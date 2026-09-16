/**
 * Webview-side state: folds host messages (ToWebview) into React state.
 * Chunk deltas are applied optimistically for smooth streaming; snapshots are
 * authoritative and replace the full payload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextAttachment,
  SessionStatus,
  TimelineEntry,
} from '@dsh-vscode/core';
import type {
  ToWebview,
  WebviewInitPayload,
  WebviewSnapshot,
} from '@dsh-vscode/core';
import { BUILT_IN_COMMANDS } from '@dsh-vscode/core';
import { postToHost } from '../vscode.js';

export interface ChatState {
  init: WebviewInitPayload | undefined;
  status: SessionStatus;
  statusDetail?: string;
  sessionId?: string;
  entries: TimelineEntry[];
  history: WebviewSnapshot['history'];
  workingSet: WebviewSnapshot['workingSet'];
  availableCommands: WebviewSnapshot['availableCommands'];
  modes: WebviewSnapshot['modes'];
  modeId?: string;
  authMethods: WebviewSnapshot['authMethods'];
  canLoadSession: boolean;
  chips: ContextAttachment[];
  errors: string[];
}

const EMPTY: ChatState = {
  init: undefined,
  status: 'disconnected',
  entries: [],
  history: [],
  workingSet: [],
  // Built-ins are always offered, even before the first host snapshot.
  availableCommands: [...BUILT_IN_COMMANDS],
  modes: [],
  authMethods: [],
  canLoadSession: false,
  chips: [],
  errors: [],
};

function applyMessage(state: ChatState, message: ToWebview): ChatState {
  switch (message.type) {
    case 'init':
      return { ...state, init: message.payload };
    case 'snapshot': {
      const payload = message.payload;
      return {
        ...state,
        status: payload.status,
        statusDetail: payload.statusDetail,
        sessionId: payload.sessionId,
        entries: payload.entries,
        history: payload.history,
        workingSet: payload.workingSet,
        availableCommands: payload.availableCommands,
        modes: payload.modes,
        modeId: payload.modeId,
        authMethods: payload.authMethods,
        canLoadSession: payload.canLoadSession,
      };
    }
    case 'chunk': {
      const entries = [...state.entries];
      const index = entries.findIndex((entry) => entry.entryId === message.entryId);
      if (index < 0) {
        return state;
      }
      const entry = entries[index]!;
      if (entry.kind !== 'assistant') {
        return state;
      }
      entries[index] = {
        ...entry,
        text: entry.text + (message.textDelta ?? ''),
        thought: message.thoughtDelta ? (entry.thought ?? '') + message.thoughtDelta : entry.thought,
      };
      return { ...state, entries };
    }
    case 'addContext': {
      const exists = state.chips.some((chip) => chip.path === message.attachment.path);
      if (exists) {
        return state;
      }
      return { ...state, chips: [...state.chips, message.attachment] };
    }
    case 'error':
      return { ...state, errors: [...state.errors.slice(-2), message.message] };
    default:
      return state;
  }
}

export function useChat() {
  const [state, setState] = useState<ChatState>(EMPTY);
  const [draft, setDraft] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const message = event.data as ToWebview;
      if (message && typeof message === 'object' && 'type' in message) {
        setState((prev) => applyMessage(prev, message));
      }
    };
    window.addEventListener('message', handler);
    postToHost({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const send = useCallback((message: Parameters<typeof postToHost>[0]) => postToHost(message), []);

  const submitPrompt = useCallback((text: string) => {
    const chips = stateRef.current.chips;
    setState((prev) => ({ ...prev, chips: [] }));
    postToHost({ type: 'submitPrompt', text, attachments: chips });
  }, []);

  const removeChip = useCallback((chipId: string) => {
    setState((prev) => ({ ...prev, chips: prev.chips.filter((chip) => chip.chipId !== chipId) }));
  }, []);

  // Stop is meaningful while a turn runs or awaits approval; a short
  // "connecting" phase just disables the composer instead.
  const busy = state.status === 'prompting' || state.status === 'awaitingApproval';

  return useMemo(
    () => ({ state, send, submitPrompt, removeChip, busy, draft, setDraft }),
    [state, send, submitPrompt, removeChip, busy, draft],
  );
}
