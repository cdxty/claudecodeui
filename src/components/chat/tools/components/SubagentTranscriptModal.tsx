import React, { useEffect, useMemo, useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { api } from '../../../../utils/api';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import type { ChatMessage, Provider } from '../../types/types';
import { createCachedDiffCalculator } from '../../utils/messageTransforms';
import MessageComponent from '../../view/subcomponents/MessageComponent';

type Status = 'idle' | 'loading' | 'ready' | 'not-ready' | 'error';

interface SubagentTranscript {
  agentId: string;
  parentSessionId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  messages: NormalizedMessage[];
}

interface SubagentTranscriptModalProps {
  open: boolean;
  onClose: () => void;
  parentSessionId: string;
  /**
   * The parent's Task `tool_use_id`. The server resolves it to the agentId
   * via on-disk meta sidecars at fetch time, so this works both for
   * historical sessions and for live runs the moment the subagent has
   * started writing.
   */
  toolUseId: string;
  /** Display-only — used in the header before the fetch resolves. */
  agentTypeHint?: string;
  /** Display-only — used in the header before the fetch resolves. */
  descriptionHint?: string;
}

/**
 * Renders one subagent's full persisted transcript in a modal.
 *
 * The subagent's messages are isolated from the main chat store: we fetch on
 * demand, normalize through the same pipeline the main chat uses, and render
 * directly. We never insert anything into `useSessionStore`, so opening the
 * modal can't corrupt the parent transcript.
 *
 * The transcript-level `parentToolUseId` (every line on disk points at the
 * parent's Task tool_use) is stripped before normalization — otherwise the
 * default top-level filter would drop the entire transcript. Nested
 * `parentToolUseId` references (a subagent that itself spawned a Task)
 * survive, so nested SubagentContainers render recursively.
 */
export const SubagentTranscriptModal: React.FC<SubagentTranscriptModalProps> = ({
  open,
  onClose,
  parentSessionId,
  toolUseId,
  agentTypeHint,
  descriptionHint,
}) => {
  const [transcript, setTranscript] = useState<SubagentTranscript | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;

    const load = async () => {
      setStatus('loading');
      setErrorMessage(null);
      try {
        const response = await api.subagentTranscriptByToolUse(parentSessionId, toolUseId);
        if (response.status === 404) {
          // Parse the error envelope to distinguish "not ready" (sidecar
          // hasn't been written yet — normal during a live run) from a real
          // 404 we want to surface as an error.
          let code: string | undefined;
          try {
            const body = await response.json();
            code = body?.error?.code ?? body?.code;
          } catch {
            // Body wasn't JSON — fall through to generic error.
          }
          if (cancelled) return;
          if (code === 'SUBAGENT_NOT_READY') {
            setStatus('not-ready');
            return;
          }
          throw new Error(`Subagent transcript not found (${response.status})`);
        }
        if (!response.ok) {
          throw new Error(`Failed to load transcript (${response.status})`);
        }
        const data = (await response.json()) as SubagentTranscript;
        if (cancelled) return;
        setTranscript(data);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load transcript');
        setStatus('error');
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [open, parentSessionId, toolUseId, reloadKey]);

  const chatMessages = useMemo<ChatMessage[]>(() => {
    if (!transcript) return [];
    const outerParentId = transcript.toolUseId;
    // Strip the outermost parentToolUseId so messages survive the top-level
    // filter in `normalizedToChatMessages`. Keep nested ones intact.
    const flattened = transcript.messages.map((msg) =>
      outerParentId && msg.parentToolUseId === outerParentId
        ? { ...msg, parentToolUseId: undefined }
        : msg
    );
    return normalizedToChatMessages(flattened);
  }, [transcript]);

  const headerType = transcript?.agentType ?? agentTypeHint ?? 'Agent';
  const headerDescription = transcript?.description ?? descriptionHint ?? '';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        className="flex h-[85vh] max-h-[900px] w-[95vw] max-w-4xl flex-col p-0"
        onPointerDownOutside={onClose}
      >
        <DialogTitle>Subagent transcript</DialogTitle>
        <header className="flex items-start justify-between gap-3 border-b px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-purple-600 dark:text-purple-400">
                Subagent
              </span>
              <span className="truncate text-sm font-semibold text-foreground">{headerType}</span>
            </div>
            {headerDescription && (
              <div className="mt-0.5 truncate text-sm text-muted-foreground">
                {headerDescription}
              </div>
            )}
            {transcript?.agentId && (
              <div className="mt-1 font-mono text-[11px] text-muted-foreground/60">
                agent-{transcript.agentId}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {status === 'loading' && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading transcript…
            </div>
          )}
          {status === 'error' && (
            <div className="flex h-full items-center justify-center text-sm text-red-500 dark:text-red-400">
              {errorMessage || 'Failed to load transcript.'}
            </div>
          )}
          {status === 'not-ready' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <div className="text-center">
                Transcript is not available yet.
                <br />
                <span className="text-xs text-muted-foreground/70">
                  The subagent may not have started writing its log.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="rounded border border-border bg-accent/50 px-3 py-1 text-xs font-medium text-foreground hover:bg-accent"
              >
                Retry
              </button>
            </div>
          )}
          {status === 'ready' && chatMessages.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Transcript is empty.
            </div>
          )}
          {status === 'ready' && chatMessages.map((message, index) => (
            <MessageComponent
              key={index}
              message={message}
              prevMessage={index > 0 ? chatMessages[index - 1] : null}
              createDiff={createDiff}
              provider={'claude' as Provider}
              autoExpandTools={false}
              showRawParameters={false}
              showThinking
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SubagentTranscriptModal;
