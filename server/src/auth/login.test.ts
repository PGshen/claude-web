import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientAddress, cookieValue, internalRequest, viaHttps } from './http.js';
import { LoginService, SESSION_TTL_MS, readAccount, removeAccount, writeAccount } from './login.js';

const PASSWORD = 'correct horse battery';
let dir: string;
let clock: number;
const load = () => LoginService.load(dir, () => clock)!;
const signIn = async (s: LoginService, ip = '1.1.1.1') => {
  const r = await s.attempt('me', PASSWORD, ip);
  if (!r.ok) throw new Error(r.reason);
  return r.token;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-login-'));
  clock = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the account file', () => {
  it('means no login when it is not there', () => {
    expect(LoginService.load(dir)).toBeNull();
  });
  it('stops the server rather than opening it up when it is damaged', () => {
    fs.writeFileSync(path.join(dir, 'login.json'), '{ not json');
    expect(() => LoginService.load(dir)).toThrow(/cannot be used/);
    fs.writeFileSync(path.join(dir, 'login.json'), '{"username":"me"}');
    expect(() => LoginService.load(dir)).toThrow(/cannot be used/);
  });
  it('holds a hash, not the password, and only its owner can read it', async () => {
    await writeAccount('me', PASSWORD, dir);
    const text = fs.readFileSync(path.join(dir, 'login.json'), 'utf8');
    expect(text).not.toContain(PASSWORD);
    expect(readAccount(dir)?.username).toBe('me');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'login.json')).mode & 0o077).toBe(0);
  });
  it('removing it turns login off', async () => {
    await writeAccount('me', PASSWORD, dir);
    expect(removeAccount(dir)).toBe(true);
    expect(LoginService.load(dir)).toBeNull();
    expect(removeAccount(dir)).toBe(false);
  });
});

describe('signing in', () => {
  beforeEach(() => writeAccount('me', PASSWORD, dir));

  it('takes the right name and password, and nothing else', async () => {
    const s = load();
    expect(await s.attempt('me', 'wrong password!', '1.1.1.1')).toEqual({ ok: false, reason: 'wrong' });
    expect(await s.attempt('you', PASSWORD, '1.1.1.1')).toEqual({ ok: false, reason: 'wrong' });
    expect(s.valid(await signIn(s))).toBe(true);
  });
  it('keeps a session across a restart and until it expires', async () => {
    const token = await signIn(load());
    expect(fs.readFileSync(path.join(dir, 'login-sessions.json'), 'utf8')).not.toContain(token);
    expect(load().valid(token)).toBe(true);
    clock += SESSION_TTL_MS + 1;
    expect(load().valid(token)).toBe(false);
  });
  it('signing out ends that session only', async () => {
    const s = load();
    const [a, b] = [await signIn(s), await signIn(s)];
    s.logout(a);
    expect(s.valid(a)).toBe(false);
    expect(s.valid(b)).toBe(true);
    expect(load().valid(a)).toBe(false);
  });
  it('a new password signs every browser out', async () => {
    const token = await signIn(load());
    await writeAccount('me', 'another long password', dir);
    expect(load().valid(token)).toBe(false);
  });
  it('rejects anything that is not a session', () => {
    const s = load();
    for (const t of [null, undefined, '', 'nope']) expect(s.valid(t)).toBe(false);
  });
});

describe('guessing', () => {
  beforeEach(() => writeAccount('me', PASSWORD, dir));

  it('locks an address for 15 minutes after 5 wrong passwords, even for the right one', async () => {
    const s = load();
    for (let i = 0; i < 5; i++) await s.attempt('me', 'wrong password!', '1.1.1.1');
    const locked = await s.attempt('me', PASSWORD, '1.1.1.1');
    expect(locked).toMatchObject({ ok: false, reason: 'locked' });
    clock += 15 * 60_000 + 1;
    expect((await s.attempt('me', PASSWORD, '1.1.1.1')).ok).toBe(true);
  });
  it('leaves other addresses alone, and a right password clears the count', async () => {
    const s = load();
    for (let i = 0; i < 5; i++) await s.attempt('me', 'wrong password!', '1.1.1.1');
    expect((await s.attempt('me', PASSWORD, '2.2.2.2')).ok).toBe(true);
    for (let i = 0; i < 4; i++) await s.attempt('me', 'wrong password!', '3.3.3.3');
    await signIn(s, '3.3.3.3');
    for (let i = 0; i < 4; i++) await s.attempt('me', 'wrong password!', '3.3.3.3');
    expect((await s.attempt('me', PASSWORD, '3.3.3.3')).ok).toBe(true);
  });
  it('stops all sign-ins for a while after 50 wrong ones from anywhere, but signed-in browsers carry on', async () => {
    const s = load();
    const token = await signIn(s);
    for (let i = 0; i < 50; i++) await s.attempt('me', 'wrong password!', `10.0.0.${i}`);
    expect(await s.attempt('me', PASSWORD, '2.2.2.2')).toMatchObject({ ok: false, reason: 'locked' });
    expect(s.valid(token)).toBe(true);
  }, 30_000);
  it('turns away tries beyond a few at once instead of queueing them', async () => {
    const s = load();
    const all = await Promise.all(Array.from({ length: 6 }, (_, i) => s.attempt('me', 'wrong password!', `4.4.4.${i}`)));
    expect(all.filter((r) => !r.ok && r.reason === 'busy')).toHaveLength(2);
  });
});

describe('requests behind a proxy on this machine', () => {
  const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

  it('a call from this machine itself is internal; anything the proxy passed on is not, whatever its Host says', () => {
    expect(internalRequest(req({ host: '127.0.0.1:3090' }))).toBe(true);
    expect(internalRequest(req({ host: 'localhost' }, '::ffff:127.0.0.1'))).toBe(true);
    expect(internalRequest(req({ host: 'app.example.com' }))).toBe(false);
    expect(internalRequest(req({ host: 'localhost', 'x-real-ip': '8.8.8.8' }))).toBe(false);
    expect(internalRequest(req({ host: 'localhost', 'x-forwarded-for': '8.8.8.8' }))).toBe(false);
    expect(internalRequest(req({ host: 'localhost' }, '8.8.8.8'))).toBe(false);
  });
  it('believes X-Forwarded-Proto only from the proxy on this machine', () => {
    expect(viaHttps(req({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(viaHttps(req({ 'x-forwarded-proto': 'https,http' }))).toBe(true);
    expect(viaHttps(req({ 'x-forwarded-proto': 'http' }))).toBe(false);
    expect(viaHttps(req({}))).toBe(false);
    expect(viaHttps(req({ 'x-forwarded-proto': 'https' }, '8.8.8.8'))).toBe(false);
  });
  it('counts failures against the address the proxy reports', () => {
    expect(clientAddress(req({ 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '9.9.9.9' }))).toBe('8.8.8.8');
    expect(clientAddress(req({ 'x-forwarded-for': 'made-up, 8.8.8.8' }))).toBe('8.8.8.8');
    expect(clientAddress(req({}))).toBe('127.0.0.1');
    expect(clientAddress(req({ 'x-real-ip': 'made-up' }, '::ffff:8.8.8.8'))).toBe('8.8.8.8');
  });
  it('reads one cookie out of many', () => {
    expect(cookieValue('a=1; cw_session=abc; b=2', 'cw_session')).toBe('abc');
    expect(cookieValue('xcw_session=abc', 'cw_session')).toBeNull();
    expect(cookieValue(undefined, 'cw_session')).toBeNull();
  });
});
