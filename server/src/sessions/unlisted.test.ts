import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { appendLastPrompt, promptOf, summaryFromFile, unlistedTranscripts } from './unlisted.js';

let cfg = '';
let saved: string | undefined;
beforeEach(() => { saved = process.env.CLAUDE_CONFIG_DIR; cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-unl-')); process.env.CLAUDE_CONFIG_DIR = cfg; });
afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; fs.rmSync(cfg, { recursive: true, force: true }); });

/** A transcript the way our engine writes one when the first prompt is long: the prompt twice up front, cwd after it. */
function write(prompt: string): { id: string; file: string } {
  const cwd = path.join(os.tmpdir(), 'cw-unl-proj');
  const dir = path.join(cfg, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const lines = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: at, sessionId: id, content: prompt },
    { parentUuid: null, isSidechain: false, message: { role: 'user', content: prompt }, type: 'user', uuid: crypto.randomUUID(), timestamp: at, entrypoint: 'sdk-ts', cwd, sessionId: id },
    { parentUuid: null, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, type: 'assistant', uuid: crypto.randomUUID(), timestamp: at, cwd, sessionId: id },
    { parentUuid: null, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }, type: 'user', uuid: crypto.randomUUID(), timestamp: at, cwd, sessionId: id },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { id, file };
}

describe('conversations the SDK list skips (a long first prompt, no title at the end)', () => {
  it('the SDK leaves it out; our reader lists it with its prompt and folder', async () => {
    const { id, file } = write(`fix the checkout page ${'x'.repeat(120_000)}`);
    const short = write('hello there');
    const sdk = (await listSessions()).map((s) => s.sessionId);
    expect(sdk).toContain(short.id);
    expect(sdk).not.toContain(id);
    const missing = unlistedTranscripts(path.join(cfg, 'projects'), new Set(sdk));
    expect(missing).toEqual([file]);
    const row = summaryFromFile(file)!;
    expect(row.sessionId).toBe(id);
    expect(row.title.startsWith('fix the checkout page')).toBe(true);
    expect(row.title.length).toBeLessThanOrEqual(120);
    expect(row.cwd).toBe(path.join(os.tmpdir(), 'cw-unl-proj'));
  });

  it('after its process ends, one last-prompt line makes every SDK reader list it again — written once', async () => {
    const { id, file } = write(`fix the checkout page ${'x'.repeat(120_000)}`);
    expect(appendLastPrompt(file, id)).toBe(true);
    expect(appendLastPrompt(file, id)).toBe(false);
    const listed = (await listSessions()).find((s) => s.sessionId === id);
    expect(listed?.summary?.startsWith('fix the checkout page')).toBe(true);
  });

  it('a transcript cut off mid-line (the process was killed) gets the last-prompt line on a line of its own', async () => {
    const { id, file } = write(`fix the checkout page ${'x'.repeat(120_000)}`);
    fs.appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"te');
    expect(appendLastPrompt(file, id)).toBe(true);
    const last = fs.readFileSync(file, 'utf8').trimEnd().split(/\n/).pop()!;
    expect(JSON.parse(last)).toMatchObject({ type: 'last-prompt', sessionId: id });
    expect((await listSessions()).some((s) => s.sessionId === id)).toBe(true);
  });

  it('a user line that is a tool result, a command or meta is not a prompt', () => {
    expect(promptOf({ type: 'user', message: { content: 'hi  there' } })).toBe('hi there');
    expect(promptOf({ type: 'user', message: { content: '<artifact-view-context artifact="a">\n{}\n</artifact-view-context>\n\n开始选题' } })).toBe('开始选题');
    expect(promptOf({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: 'look' }] } })).toBe('look');
    expect(promptOf({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe('');
    expect(promptOf({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })).toBe('');
    expect(promptOf({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe('');
  });
});
