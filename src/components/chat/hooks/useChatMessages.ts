/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  // Second pass: aggregate subagent (Task) children from live-stream messages.
  // The Claude SDK emits a subagent's internal tool_use/tool_result events
  // tagged with `parentToolUseId`. They must not render as top-level chat
  // bubbles — they belong nested inside the parent Task tool widget.
  const liveSubagentTools = new Map<string, SubagentChildTool[]>();
  const liveSubagentToolResults = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (!msg.parentToolUseId) continue;
    if (msg.kind === 'tool_result' && msg.toolId) {
      liveSubagentToolResults.set(msg.toolId, msg);
    }
  }
  for (const msg of messages) {
    if (!msg.parentToolUseId) continue;
    if (msg.kind !== 'tool_use') continue;
    const parentId = msg.parentToolUseId;
    const tr = msg.toolResult || (msg.toolId ? liveSubagentToolResults.get(msg.toolId) : null);
    const child: SubagentChildTool = {
      toolId: msg.toolId || '',
      toolName: msg.toolName || '',
      toolInput: msg.toolInput,
      toolResult: tr
        ? {
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            isError: Boolean(tr.isError),
            toolUseResult: (tr as any).toolUseResult,
          }
        : null,
      timestamp: new Date(msg.timestamp || Date.now()),
    };
    const arr = liveSubagentTools.get(parentId) || [];
    arr.push(child);
    liveSubagentTools.set(parentId, arr);
  }

  for (const msg of messages) {
    // Skip any subagent-internal message — it must not render as a top-level
    // chat bubble. Its content is surfaced inside the parent Task widget via
    // the aggregated `subagentTools` array built above.
    if (msg.parentToolUseId) continue;

    const sharedMetadata = {
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        if (!content.trim()) continue;

        if (msg.role === 'user') {
          // Parse task notifications
          const taskNotifRegex = /<task-notification>\s*<task-id>[^<]*<\/task-id>\s*<output-file>[^<]*<\/output-file>\s*<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>\s*<\/task-notification>/g;
          const taskNotifMatch = taskNotifRegex.exec(content);
          if (taskNotifMatch) {
            converted.push({
              type: 'assistant',
              content: taskNotifMatch[2]?.trim() || 'Background task finished',
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotifMatch[1]?.trim() || 'completed',
              ...sharedMetadata,
            });
          } else {
            converted.push({
              type: 'user',
              content: unescapeWithMathProtection(decodeHtmlEntities(content)),
              timestamp: msg.timestamp,
              ...sharedMetadata,
            });
          }
        } else {
          let text = decodeHtmlEntities(content);
          text = unescapeWithMathProtection(text);
          text = formatUsageLimitText(text);
          converted.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        // The Claude SDK has renamed the subagent invocation tool from `Task`
        // to `Agent` (older transcripts still use `Task`). Treat both names
        // as subagent containers so the dedicated SubagentContainer widget
        // is selected instead of the generic Default fallback.
        const isSubagentContainer = msg.toolName === 'Task' || msg.toolName === 'Agent';

        // Build child tools from subagentTools (history path) merged with any
        // live-stream subagent activity aggregated by parentToolUseId above.
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
          }
        }
        if (isSubagentContainer && msg.toolId) {
          const liveChildren = liveSubagentTools.get(msg.toolId);
          if (liveChildren && liveChildren.length > 0) {
            const seen = new Set(childTools.map((t) => t.toolId).filter(Boolean));
            for (const child of liveChildren) {
              if (child.toolId && seen.has(child.toolId)) continue;
              childTools.push(child);
            }
          }
        }

        const toolResult = tr
          ? {
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        converted.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentParentSessionId: isSubagentContainer ? msg.sessionId : undefined,
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        converted.push({
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        converted.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          ...sharedMetadata,
        });
        break;

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result':
        break;

      default:
        break;
    }
  }

  return converted;
}
