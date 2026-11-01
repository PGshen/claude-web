// One account for a server on the open internet (docs/notes/login.md): the password's scrypt hash in <data>/login.json,
// written by `npm run account`; signed-in browsers in <data>/login-sessions.json, as hashes. No account file = no login
// (the local and desktop setups, as before); a file that cannot be read stops the server instead of opening it up.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { dataDir } from '../files/service.js';

export const SESSION_COOKIE = 'cw_session';
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const MIN_PASSWORD_LENGTH = 12;
const MAX_SESSIONS = 20;
const IP_MAX_FAILS = 5;
const ALL_MAX_FAILS = 50;
const ALL_WINDOW_MS = 3_600_000;
const LOCK_MS = 15 * 60_000;
/** scrypt is meant to be slow: this many at once, the rest are told to wait rather than queue up and starve the server */
const MAX_IN_FLIGHT = 4;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_LENGTH = 32;

export interface Account {
  username: string;
  salt: string;
  hash: string;
  /** a new one with every password: sessions of another generation are dropped when the server loads */
  generation: string;
}

interface StoredSession { hash: string; expiresAt: number; generation: string }

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'wrong' }
  | { ok: false; reason: 'locked' | 'busy'; retryAfterMs: number };

const accountFile = (dir: string) => path.join(dir, 'login.json');
const sessionsFile = (dir: string) => path.join(dir, 'login-sessions.json');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, Buffer.from(salt, 'hex'), KEY_LENGTH, SCRYPT, (e, key) => (e ? rej(e) : res(key))));
}

/** Readable by this user only, and never half written: a torn login.json would stop the server from starting. */
function writePrivate(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The account as stored; null when there is none. Throws when the file is there but unusable. */
export function readAccount(dir = dataDir()): Account | null {
  let text: string;
  try {
    text = fs.readFileSync(accountFile(dir), 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const a = JSON.parse(text) as Partial<Account>;
  if (!a || !a.username || !a.salt || !a.hash || !a.generation) throw new Error('missing fields');
  return a as Account;
}

export async function writeAccount(username: string, password: string, dir = dataDir()): Promise<void> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt)).toString('hex');
  const account: Account = { username, salt, hash, generation: randomBytes(8).toString('hex') };
  writePrivate(accountFile(dir), JSON.stringify(account, null, 2));
}

export function removeAccount(dir = dataDir()): boolean {
  let had = false;
  for (const f of [accountFile(dir), sessionsFile(dir)]) {
    try {
      fs.rmSync(f);
      if (f === accountFile(dir)) had = true;
    } catch { /* it was not there */ }
  }
  return had;
}

export class LoginService {
  private sessions = new Map<string, number>(); // token hash → expiresAt
  private ipFails = new Map<string, { count: number; lockedUntil: number }>();
  private allFails: number[] = [];
  private allLockedUntil = 0;
  private inFlight = 0;

  private constructor(private account: Account, private dir: string, private now: () => number) {
    this.loadSessions();
  }

  /** null when no account is set; throws when login.json cannot be used (the caller must not start without login). */
  static load(dir = dataDir(), now: () => number = Date.now): LoginService | null {
    let account: Account | null;
    try {
      account = readAccount(dir);
    } catch (e: any) {
      throw new Error(`${accountFile(dir)} cannot be used: ${e.message}. Set the account again with npm run account.`);
    }
    return account && new LoginService(account, dir, now);
  }

  private loadSessions() {
    try {
      const list = JSON.parse(fs.readFileSync(sessionsFile(this.dir), 'utf8')) as StoredSession[];
      const t = this.now();
      for (const s of list) if (s.generation === this.account.generation && s.expiresAt > t) this.sessions.set(s.hash, s.expiresAt);
    } catch { /* none yet, or unreadable: everyone signs in again */ }
  }

  private saveSessions() {
    const list: StoredSession[] = [...this.sessions].map(([hash, expiresAt]) => ({ hash, expiresAt, generation: this.account.generation }));
    writePrivate(sessionsFile(this.dir), JSON.stringify(list));
  }

  /** How long until this address may try again; 0 = it may. */
  private lockLeft(ip: string): number {
    const t = this.now();
    return Math.max(this.allLockedUntil - t, (this.ipFails.get(ip)?.lockedUntil ?? 0) - t, 0);
  }

  private fail(ip: string) {
    const t = this.now();
    const rec = this.ipFails.get(ip);
    // a lock that has run out starts the count over
    const fresh = !rec || (rec.lockedUntil && rec.lockedUntil <= t);
    const count = (fresh ? 0 : rec!.count) + 1;
    this.ipFails.set(ip, { count, lockedUntil: count >= IP_MAX_FAILS ? t + LOCK_MS : 0 });
    this.allFails = this.allFails.filter((x) => x > t - ALL_WINDOW_MS);
    this.allFails.push(t);
    if (this.allFails.length >= ALL_MAX_FAILS) {
      this.allLockedUntil = t + LOCK_MS;
      this.allFails = [];
    }
    // an attacker with many addresses must not grow this forever
    if (this.ipFails.size > 10_000) this.ipFails.clear();
  }

  async attempt(username: string, password: string, ip: string): Promise<LoginResult> {
    const left = this.lockLeft(ip);
    if (left > 0) return { ok: false, reason: 'locked', retryAfterMs: left };
    if (this.inFlight >= MAX_IN_FLIGHT) return { ok: false, reason: 'busy', retryAfterMs: 1000 };
    this.inFlight++;
    try {
      // the hash is worked out for a wrong name as well: the time taken must not say which of the two was wrong
      const key = await derive(password, this.account.salt);
      const hashOk = timingSafeEqual(key, Buffer.from(this.account.hash, 'hex'));
      const nameOk = timingSafeEqual(Buffer.from(sha256(username)), Buffer.from(sha256(this.account.username)));
      if (!hashOk || !nameOk) {
        this.fail(ip);
        return { ok: false, reason: 'wrong' };
      }
    } finally {
      this.inFlight--;
    }
    this.ipFails.delete(ip);
    return { ok: true, token: this.createSession() };
  }

  private createSession(): string {
    const t = this.now();
    for (const [h, exp] of this.sessions) if (exp <= t) this.sessions.delete(h);
    // Map keeps insertion order: the oldest browser goes first
    while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha256(token), t + SESSION_TTL_MS);
    this.saveSessions();
    return token;
  }

  valid(token: string | null | undefined): boolean {
    if (!token) return false;
    const exp = this.sessions.get(sha256(token));
    return exp !== undefined && exp > this.now();
  }

  logout(token: string | null | undefined) {
    if (token && this.sessions.delete(sha256(token))) this.saveSessions();
  }
}
