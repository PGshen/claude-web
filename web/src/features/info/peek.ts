// 信息栏 of a conversation with no process (history, closed): its connectors and count, asked of a short-lived process
// that is not the conversation's (server: RunnerPool.peek — why not by resuming it is on SessionRunner.peek).
// Memory only: this run of the app, like the card's ctxCache.
import { create } from 'zustand';
import type { SessionInfoSnapshot, SessionPeek } from '@shared';
import { useStore } from '@/store';
import { resumeParams, resumeView } from '@/store/reopen';
import { ws } from '@/ws/client';
import type { PeekRecord } from './info-model';

export interface Peek extends PeekRecord {
  mcpServers?: NonNullable<SessionInfoSnapshot['mcpServers']>;
  context?: unknown;
}

export const usePeeks = create<{ bySession: Record<string, Peek> }>(() => ({ bySession: {} }));

const put = (id: string, f: (p: Peek | undefined) => Peek) => usePeeks.setState((s) => ({ bySession: { ...s.bySession, [id]: f(s.bySession[id]) } }));

/** The latest ask per conversation: an older answer that comes back later is dropped. */
const asked = new Map<string, number>();

export async function askPeek(sessionId: string, context: boolean): Promise<void> {
  const st = useStore.getState();
  const o = st.open[sessionId];
  if (!o?.cwd) return;
  const meta = st.sessionMeta[sessionId];
  const rp = resumeParams(o, meta);
  const seq = (asked.get(sessionId) ?? 0) + 1;
  asked.set(sessionId, seq);
  put(sessionId, (p) => ({ at: 0, ...p, busy: true }));
  try {
    const r = await ws.request<SessionPeek | null>({ kind: 'session.peek', context, params: { sessionId, cwd: o.cwd, ...rp, model: rp.model ?? resumeView(o, meta).model } });
    if (asked.get(sessionId) !== seq) return;
    put(sessionId, (p) => (r ? { at: Date.now(), mcpServers: r.mcpServers, context: r.context ?? p?.context } : { at: Date.now(), none: true }));
  } catch {
    if (asked.get(sessionId) !== seq) return;
    put(sessionId, (p) => ({ ...p, at: Date.now(), busy: false, failed: true }));
  }
}
