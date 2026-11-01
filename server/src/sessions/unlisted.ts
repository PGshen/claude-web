// Conversations the SDK's listSessions leaves out. It reads a transcript's first and last 64 KB only; when the first
// prompt is long (a pasted screenshot is base64 in it — and the CLI writes it twice up front, in a queue-operation line
// and the user line) and the end has no title-like line (`custom-title`, `ai-title`, `summary`, `last-prompt`: the CLI
// writes these on a clean exit, not when its process is killed), the conversation is not listed at all — not in our
// sidebar and not in any other app that lists Claude Code's history through the SDK (2026-10-17 user report: Mirasim
// showed none of the conversations made here the night before).
import fs from 'node:fs';
import path from 'node:path';
import type { SessionSummary } from '../protocol.js';
import { cwdFromTranscript } from './service.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const TAIL = 256 * 1024;
const HEAD_LINES = 400;

/** Every `<projects>/<dir>/<uuid>.jsonl` not in `listed`. */
export function unlistedTranscripts(projectsDir: string, listed: Set<string>): string[] {
  const out: string[] = [];
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(projectsDir, d.name)); } catch { continue; }
    for (const f of files) if (ID.test(f) && !listed.has(f.slice(0, -6))) out.push(path.join(projectsDir, d.name, f));
  }
  return out;
}

function readTail(file: string, size: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(size, TAIL);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** The text a user line says (a string, or its text blocks), or '' for tool results, commands and meta lines. */
export function promptOf(line: any): string {
  if (line?.type !== 'user' || line.isMeta || line.isSidechain) return '';
  const c = line.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ') : '';
  // a message from an artifact page in the official app starts with that page's state; what was said comes after it
  const t = text.replace(/<artifact-view-context\b[^>]*>[\s\S]*?<\/artifact-view-context>/g, '').replace(/\s+/g, ' ').trim();
  return t.startsWith('<') ? '' : t;
}

/** The first user prompt, read line by line from the start (lines can be megabytes; a few hundred are plenty). */
function firstPrompt(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(1 << 20);
    let pending = '';
    let lines = 0;
    for (let pos = 0; lines < HEAD_LINES; ) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      pending += chunk.toString('utf8', 0, n);
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0 && lines < HEAD_LINES) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lines++;
        if (!line.includes('"type":"user"')) continue;
        try { const p = promptOf(JSON.parse(line)); if (p) return p; } catch { /* a broken line */ }
      }
      if (pending.length > 64 * 1024 * 1024) break;
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return '';
}

interface Tail { custom?: string; ai?: string; summary?: string; lastPrompt?: string; lastPromptLine: boolean; sidechain: boolean }
/** What the end of the transcript says the conversation is called (newest first), and its last prompt. */
function tailTitles(text: string): Tail {
  const out: Tail = { sidechain: false, lastPromptLine: false };
  for (const line of text.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'custom-title' && out.custom === undefined && typeof j.customTitle === 'string') out.custom = j.customTitle;
    else if (j.type === 'ai-title' && out.ai === undefined && typeof j.aiTitle === 'string') out.ai = j.aiTitle;
    else if (j.type === 'summary' && out.summary === undefined && typeof j.summary === 'string') out.summary = j.summary;
    else if (j.type === 'last-prompt' && typeof j.lastPrompt === 'string') { out.lastPromptLine = true; if (out.lastPrompt === undefined) out.lastPrompt = j.lastPrompt; }
    else if (out.lastPrompt === undefined && j.type === 'user') { const p = promptOf(j); if (p) out.lastPrompt = p; if (j.isSidechain) out.sidechain = true; }
  }
  return out;
}

function endsInNewline(file: string, size: number): boolean {
  if (!size) return true;
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); return b[0] === 10; } finally { fs.closeSync(fd); }
}

const clip = (t: string, n = 200) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

const seen = new Map<string, { key: string; row: SessionSummary | null }>();

/** A list row for a transcript the SDK skipped; null for one with no conversation in it (remembered per size + mtime). */
export function summaryFromFile(file: string): SessionSummary | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = seen.get(file);
  if (hit?.key === key) return hit.row;
  const row = readRow(file, st);
  seen.set(file, { key, row });
  return row;
}

function readRow(file: string, st: fs.Stats): SessionSummary | null {
  if (!st.size) return null;
  let tail = '';
  try { tail = readTail(file, st.size); } catch { return null; }
  const t = tailTitles(tail);
  if (t.sidechain) return null;
  const first = firstPrompt(file);
  const title = t.custom || t.ai || t.summary || first || t.lastPrompt;
  if (!title) return null;
  return {
    sessionId: path.basename(file, '.jsonl'),
    title: clip(title, 120),
    cwd: cwdFromTranscript(file),
    lastModified: st.mtimeMs,
    ...(first ? { firstPrompt: clip(first) } : {}),
  } as SessionSummary;
}

/**
 * Make an ended conversation listable for every app again: append the `last-prompt` line the CLI itself writes on a
 * clean exit. Only for a transcript the SDK skips (`listed` false) and only once its process is gone (no two writers).
 */
export function appendLastPrompt(file: string, sessionId: string): boolean {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return false; }
  const t = tailTitles(readTail(file, st.size));
  if (t.custom || t.ai || t.summary || t.lastPromptLine) return false;
  const prompt = t.lastPrompt || firstPrompt(file);
  if (!prompt) return false;
  // a process killed mid-write leaves a half line: ours goes on a line of its own
  const lead = endsInNewline(file, st.size) ? '' : '\n';
  fs.appendFileSync(file, `${lead}${JSON.stringify({ type: 'last-prompt', lastPrompt: clip(prompt), sessionId })}\n`);
  return true;
}
