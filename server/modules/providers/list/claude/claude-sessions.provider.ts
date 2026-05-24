import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions, SubagentTranscript } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return tools;
}

/**
 * Indexes subagent meta sidecars by their parent Task `tool_use_id`.
 *
 * Claude writes one `agent-<agentId>.meta.json` per subagent run alongside the
 * matching `.jsonl` transcript. Each meta sidecar carries `{toolUseId,
 * agentType, description}` so we can resolve "which subagent file backs this
 * Task tool result" without grepping the textual agent response.
 *
 * The `toolUseResult.agentId` field the older code path used isn't actually
 * present in current transcripts — the meta sidecar is the only stable link.
 */
async function readSubagentIndex(subagentDir: string): Promise<Map<string, { agentId: string; agentType?: string; description?: string }>> {
  const index = new Map<string, { agentId: string; agentType?: string; description?: string }>();
  let entries: string[];
  try {
    entries = await fsp.readdir(subagentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return index;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith('agent-') || !entry.endsWith('.meta.json')) {
      continue;
    }

    const agentId = entry.slice('agent-'.length, -'.meta.json'.length);
    try {
      const content = await fsp.readFile(path.join(subagentDir, entry), 'utf8');
      const parsed = JSON.parse(content) as AnyRecord;
      const toolUseId = typeof parsed.toolUseId === 'string' ? parsed.toolUseId : null;
      if (!toolUseId) {
        continue;
      }
      index.set(toolUseId, {
        agentId,
        agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
        description: typeof parsed.description === 'string' ? parsed.description : undefined,
      });
    } catch {
      // Skip unreadable or malformed sidecars; the rest of the transcript is still useful.
    }
  }

  return index;
}

async function getSessionMessages(
  sessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    // Claude nests subagent artifacts under `<projectDir>/<sessionId>/subagents/`,
    // not at the project root. The earlier flat-directory read here meant
    // historical session reloads silently missed every `subagentTools`
    // enrichment, leaving Task tool widgets without their child-tool list.
    const projectDir = path.dirname(jsonLPath);
    const subagentDir = path.join(projectDir, sessionId, 'subagents');
    const subagentIndex = await readSubagentIndex(subagentDir);

    const messages: AnyRecord[] = [];
    const agentToolsCache = new Map<string, AnyRecord[]>();

    const fileStream = fs.createReadStream(jsonLPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        if (entry.sessionId === sessionId) {
          messages.push(entry);
        }
      } catch {
        // Skip malformed JSONL lines that can happen during concurrent writes.
      }
    }

    // Discover which subagents actually appear in this session's tool_result
    // stream, then pull each one's tool list off disk exactly once.
    const referencedAgentIds = new Set<string>();
    for (const message of messages) {
      if (message.message?.role !== 'user' || !Array.isArray(message.message?.content)) {
        continue;
      }
      for (const part of message.message.content) {
        if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          const indexed = subagentIndex.get(part.tool_use_id);
          if (indexed) {
            referencedAgentIds.add(indexed.agentId);
          }
        }
      }
    }

    for (const agentId of referencedAgentIds) {
      const agentFilePath = path.join(subagentDir, `agent-${agentId}.jsonl`);
      const tools = await parseAgentTools(agentFilePath);
      agentToolsCache.set(agentId, tools);
    }

    // Attach the resolved tool list to the raw tool_result row so the
    // normalizer can copy it onto the corresponding tool_use via the existing
    // toolResultMap pairing in `fetchHistory`.
    for (const message of messages) {
      if (message.message?.role !== 'user' || !Array.isArray(message.message?.content)) {
        continue;
      }
      for (const part of message.message.content) {
        if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          const indexed = subagentIndex.get(part.tool_use_id);
          if (!indexed) {
            continue;
          }
          const agentTools = agentToolsCache.get(indexed.agentId);
          if (agentTools && agentTools.length > 0) {
            message.subagentTools = agentTools;
          }
        }
      }
    }

    const sortedMessages = messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    // Subagent provenance: transcript JSONL entries spawned inside a Task
    // tool run carry `parent_tool_use_id` (snake_case on disk, camelCase when
    // re-wrapped by the live SDK adapter). Every NormalizedMessage produced
    // below inherits this tag so the UI can keep subagent activity nested
    // inside the parent Task widget instead of polluting the top-level chat.
    const parentToolUseId =
      (typeof raw.parent_tool_use_id === 'string' && raw.parent_tool_use_id) ||
      (typeof raw.parentToolUseId === 'string' && raw.parentToolUseId) ||
      '';

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    const finalize = (): NormalizedMessage[] => {
      if (parentToolUseId) {
        for (const msg of messages) {
          if (!msg.parentToolUseId) {
            msg.parentToolUseId = parentToolUseId;
          }
        }
      }
      return messages;
    };

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (text && !isInternalContent(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
              }));
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
            }));
          }
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return finalize();
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return finalize();
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return finalize();
        }

        if (text && !isInternalContent(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
      }
      return finalize();
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return finalize();
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return finalize();
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return finalize();
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return finalize();
    }

    return finalize();
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    const totalNormalized = normalized.length;
    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const messages = normalizedLimit === null
      ? normalized
      : normalized.slice(
          Math.max(0, totalNormalized - normalizedOffset - normalizedLimit),
          Math.max(0, totalNormalized - normalizedOffset),
        );
    const hasMore = normalizedLimit === null
      ? false
      : Math.max(0, totalNormalized - normalizedOffset - normalizedLimit) > 0;

    return {
      messages,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  /**
   * Resolves a parent Task `tool_use_id` to the agentId of the subagent it
   * spawned, by scanning meta sidecars under `<sessionId>/subagents/`.
   *
   * Returns null when the sidecar isn't present yet. That's a normal
   * transient state — the SDK writes the sidecar shortly after the subagent
   * starts, so the UI re-fetches naturally on a subsequent click.
   */
  async resolveAgentIdByToolUseId(
    parentSessionId: string,
    toolUseId: string,
  ): Promise<string | null> {
    const session = sessionsDb.getSessionById(parentSessionId);
    const jsonLPath = session?.jsonl_path;
    if (!jsonLPath) {
      return null;
    }
    const subagentDir = path.join(path.dirname(jsonLPath), parentSessionId, 'subagents');
    const index = await readSubagentIndex(subagentDir);
    return index.get(toolUseId)?.agentId ?? null;
  }

  /**
   * Reads a subagent's persisted transcript from disk and returns it
   * normalized through the same pipeline used for parent sessions. Returns
   * null when the parent session or the subagent file is unknown.
   *
   * The returned messages share the parent's `sessionId` (every line in the
   * subagent jsonl does on disk). The frontend renders them in an isolated
   * modal — never inserted into the parent session store — so this is fine.
   */
  async fetchSubagentTranscript(
    parentSessionId: string,
    agentId: string,
  ): Promise<SubagentTranscript | null> {
    const session = sessionsDb.getSessionById(parentSessionId);
    const jsonLPath = session?.jsonl_path;
    if (!jsonLPath) {
      return null;
    }

    const projectDir = path.dirname(jsonLPath);
    const subagentDir = path.join(projectDir, parentSessionId, 'subagents');
    const transcriptPath = path.join(subagentDir, `agent-${agentId}.jsonl`);
    const metaPath = path.join(subagentDir, `agent-${agentId}.meta.json`);

    let meta: AnyRecord | null = null;
    try {
      const raw = await fsp.readFile(metaPath, 'utf8');
      meta = JSON.parse(raw) as AnyRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[ClaudeProvider] Failed to read subagent meta ${metaPath}:`, error);
      }
    }

    const rawMessages: AnyRecord[] = [];
    try {
      const fileStream = fs.createReadStream(transcriptPath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        try {
          rawMessages.push(JSON.parse(line) as AnyRecord);
        } catch {
          // Skip malformed lines from concurrent writes.
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    // Pair tool_use ↔ tool_result inside the subagent transcript so the modal
    // shows the same widgets the main chat does. Mirrors the logic in
    // `fetchHistory` but kept local to avoid coupling that signature.
    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, parentSessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }
        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
      }
    }

    return {
      agentId,
      parentSessionId,
      agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
      description: typeof meta?.description === 'string' ? meta.description : null,
      toolUseId: typeof meta?.toolUseId === 'string' ? meta.toolUseId : null,
      messages: normalized,
    };
  }
}
