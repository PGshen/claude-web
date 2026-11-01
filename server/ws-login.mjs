// Login end-to-end against a real server: an account in a temporary data dir, requests made the way Nginx passes them on.
//   node server/ws-login.mjs     (starts its own server; clear the CLAUDE_* / ANTHROPIC_* variables first, see CLAUDE.md)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-login-e2e-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), PORT: '0', LANG: 'zh_CN.UTF-8' };
const tsx = path.resolve(serverDir, '../node_modules/.bin/tsx');
const PASSWORD = 'a long enough password';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const account = spawnSync(tsx, ['src/auth/cli.ts'], { cwd: serverDir, env, input: `me\n${PASSWORD}\n${PASSWORD}\n`, encoding: 'utf8' });
check('npm run account writes the account', account.status === 0 && fs.existsSync(path.join(env.CLAUDE_WEB_DIR, 'login.json')), account.stderr);
const short = spawnSync(tsx, ['src/auth/cli.ts'], { cwd: serverDir, env, input: 'me\nshort\nshort\n', encoding: 'utf8' });
check('a short password is refused', short.status === 1);

const child = spawn(tsx, ['src/index.ts'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((res, rej) => {
  let out = '';
  child.stdout.on('data', (c) => { out += c; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) res(Number(m[1])); });
  child.on('exit', (code) => rej(new Error(`server exited: ${code}`)));
  setTimeout(() => rej(new Error('server did not start')), 60_000).unref();
});
const base = `http://127.0.0.1:${port}`;
// what the proxy adds to every request from a browser
const PROXIED = { host: 'app.example.com', 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' };
const rawRequest = async (pathname, { headers = {}, ...init } = {}) => new Promise((res, rej) => {
  // fetch() will not send a custom Host: plain http
  import('node:http').then(({ default: http }) => {
    const r = http.request({ port, host: '127.0.0.1', path: pathname, method: init.method ?? 'GET', headers }, (m) => {
      let body = '';
      m.on('data', (c) => { body += c; });
      m.on('end', () => res({ status: m.statusCode, headers: m.headers, body }));
    });
    r.on('error', rej);
    r.end(init.body);
  });
});
const proxied = (pathname, init = {}) => rawRequest(pathname, { ...init, headers: { ...PROXIED, ...(init.headers ?? {}) } });
const wsOpens = (headers) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  ws.once('open', () => res(ws));
  ws.once('error', () => res(null));
});
const signIn = (password = PASSWORD, headers = {}) => proxied('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.com', ...headers }, body: JSON.stringify({ username: 'me', password }) });

try {
  // ---- signed out ----
  const page = await proxied('/', { headers: { accept: 'text/html' } });
  check('opening the app goes to /login', page.status === 302 && page.headers.location === '/login');
  const login = await proxied('/login', { headers: { accept: 'text/html', 'accept-language': 'en-US,en' } });
  check('the login page follows the browser language and shows nothing of the app', login.status === 200 && login.body.includes('Sign in') && !login.body.includes('assets/'));
  const asset = await proxied('/assets/index.js');
  check('the app code stays out of reach', asset.status === 401);
  check('/api/file refused', (await proxied(`/api/file?path=${encodeURIComponent('/etc/hosts')}`)).status === 401);
  check('/ws refused', (await wsOpens({ ...PROXIED, origin: 'https://app.example.com' })) === null);
  const status = JSON.parse((await proxied('/api/auth/status')).body);
  check('status says who is signed in', status.login === true && status.authed === false);
  const health = JSON.parse((await proxied('/api/health')).body);
  check('/api/health says only that it is up', health.ok === true && Object.keys(health).length === 1);

  // ---- loopback trust and other doors ----
  check('a loopback Host gets nothing either', (await rawRequest('/api/file?path=/etc/hosts', { headers: { host: '127.0.0.1' } })).status === 401);
  check('/ws from loopback refused', (await wsOpens({})) === null);
  check('the URL token is not a way in', (await rawRequest('/api/file?path=/etc/hosts&token=x', { headers: { host: '127.0.0.1' } })).status === 401);
  check('the privacy relay is closed to proxied requests', (await proxied('/gateway/~v/x')).status === 404);
  check('/pair is closed', (await proxied('/pair')).status === 404);
  check('/api/pair is closed', (await proxied('/api/pair', { method: 'POST', body: '{"code":"000000"}' })).status === 404);

  // ---- signing in ----
  const http = await rawRequest('/api/login', { method: 'POST', headers: { host: 'app.example.com', 'x-forwarded-proto': 'http', 'x-real-ip': '203.0.113.7' }, body: JSON.stringify({ username: 'me', password: PASSWORD }) });
  check('plain HTTP through the proxy is refused', http.status === 403 && !http.headers['set-cookie']);
  const cross = await signIn(PASSWORD, { origin: 'https://evil.example' });
  check('a request from another site is refused', cross.status === 403 && !cross.headers['set-cookie']);
  const wrong = await signIn('not the password at all');
  check('a wrong password is refused', wrong.status === 401 && !wrong.headers['set-cookie']);
  const ok = await signIn();
  const cookie = String(ok.headers['set-cookie']?.[0] ?? '');
  check('the right password signs in', ok.status === 200 && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie), cookie.replace(/=[^;]+/, '=…'));
  const pair = cookie.split(';')[0];

  // ---- signed in ----
  const app = await proxied('/', { headers: { cookie: pair, accept: 'text/html' } });
  check('the app opens', app.status === 200 && !app.headers.location);
  check('/login goes back to the app', (await proxied('/login', { headers: { cookie: pair } })).headers.location === '/');
  const sock = await wsOpens({ ...PROXIED, origin: 'https://app.example.com', cookie: pair });
  check('/ws opens', !!sock);
  const reply = await new Promise((res) => {
    sock.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply') res(m.reply); });
    sock.send(JSON.stringify({ type: 'request', request: { id: '1', req: { kind: 'remote.status' } } }));
  });
  check('the app is told pairing is closed', reply.ok && reply.data.closed === true && reply.data.enabled === false);
  const code = await new Promise((res) => {
    sock.removeAllListeners('message');
    sock.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply' && m.reply.id === '2') res(m.reply); });
    sock.send(JSON.stringify({ type: 'request', request: { id: '2', req: { kind: 'remote.pairCode' } } }));
  });
  check('no pairing code can be made', code.ok === false);
  check('a cross-site upload is refused', (await proxied('/api/project-files?workspaceId=x&name=y', { method: 'POST', headers: { cookie: pair, origin: 'https://evil.example' } })).status === 403);

  // ---- signing out ----
  const closed = new Promise((res) => sock.once('close', () => res(true)));
  const out = await proxied('/api/logout', { method: 'POST', headers: { cookie: pair, origin: 'https://app.example.com' } });
  check('signing out clears the cookie', out.status === 200 && /Max-Age=0/.test(String(out.headers['set-cookie'])));
  check('signing out cuts the open socket', await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 3000))]));
  check('the old cookie no longer works', (await proxied('/', { headers: { cookie: pair, accept: 'text/html' } })).status === 302);

  // ---- guessing ----
  for (let i = 0; i < 5; i++) await signIn('still not the password');
  const locked = await signIn();
  check('five wrong passwords lock the address, whatever comes next', locked.status === 429 && !!locked.headers['retry-after'], JSON.parse(locked.body).error);
  const other = await signIn(PASSWORD, { 'x-real-ip': '203.0.113.8' });
  check('another address can still sign in', other.status === 200);
  const stored = fs.readFileSync(path.join(env.CLAUDE_WEB_DIR, 'login-sessions.json'), 'utf8');
  check('no raw session on disk', !stored.includes(String(other.headers['set-cookie']?.[0]).split(';')[0].split('=')[1]));
} finally {
  child.removeAllListeners('exit');
  child.kill('SIGTERM');
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 8000).unref(); });
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
