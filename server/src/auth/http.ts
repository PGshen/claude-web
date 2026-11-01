// The HTTP side of login (docs/notes/login.md): the page, its endpoints, and what counts as HTTPS / as this machine
// when the server sits behind Nginx on the same host — every request then comes from a loopback address.
import type http from 'node:http';
import { sameOriginRequest, loopbackHost } from '../cloud/same-origin.js';
import { getLocale, resolveLanguage, setLocale, tr, type Locale } from '../i18n/index.js';
import { CARD_PAGE_STYLE } from '../remote/service.js';
import { SESSION_COOKIE, SESSION_TTL_MS, type LoginService } from './login.js';

const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded'];

const loopbackAddress = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));

export function cookieValue(cookie: string | undefined, name: string): string | null {
  for (const part of (cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

type Req = Pick<http.IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } };

/** Sent by something on this machine itself, not passed on by a reverse proxy: the only callers the internal endpoints have. */
export function internalRequest(req: Req): boolean {
  return loopbackAddress(req.socket.remoteAddress) && loopbackHost(req.headers.host) && !FORWARD_HEADERS.some((h) => req.headers[h] !== undefined);
}

/** The proxy on this machine says the browser used HTTPS. From anywhere else the header means nothing. */
export function viaHttps(req: Req): boolean {
  if (!loopbackAddress(req.socket.remoteAddress)) return false;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

/** Whom the failed tries count against: the address Nginx reports, because every proxied socket is loopback. */
export function clientAddress(req: Req): string {
  const socket = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!loopbackAddress(req.socket.remoteAddress)) return socket;
  const real = String(req.headers['x-real-ip'] ?? '').trim();
  if (real) return real;
  // the last entry is the one the proxy added itself; the ones before it are whatever the client sent
  return String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() || socket;
}

/** The page and its messages in the language the user chose, else the browser's: a cloud machine's own says nothing. */
function inLanguage<T>(req: Req, setting: unknown, build: () => T): T {
  const before: Locale = getLocale();
  setLocale(resolveLanguage(setting, String(req.headers['accept-language'] ?? '')));
  try {
    return build();
  } finally {
    setLocale(before);
  }
}

function json(res: http.ServerResponse, status: number, body: object, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function loginPage(): string {
  return `<!doctype html><html lang="${getLocale() === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f7f6f2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)"><title>${tr('登录 · Claude Web')}</title>
<style>${CARD_PAGE_STYLE}</style></head><body><div class="card"><h1><i>✱</i>${tr('登录')}</h1><p>${tr('登录后才能使用这台服务器上的 Claude Web。')}</p>
<form id="f"><label for="username">${tr('用户名')}</label><input id="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus><label for="password">${tr('密码')}</label><input id="password" type="password" autocomplete="current-password" required><button id="go">${tr('登录')}</button><div class="err" id="err" role="alert"></div></form></div>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const err=document.getElementById('err'),go=document.getElementById('go');err.textContent='';go.disabled=true;
try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});const j=await r.json().catch(()=>({}));
if(r.ok&&j.ok){location.replace('/');return;}err.textContent=j.error||(${JSON.stringify(tr('失败'))}+' '+r.status);}catch(x){err.textContent=String(x);}go.disabled=false;};</script></body></html>`;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function serveLogin(login: LoginService, req: http.IncomingMessage, res: http.ServerResponse, setting: unknown) {
  const refuse = (status: number, error: string, headers?: Record<string, string>) => json(res, status, { ok: false, error }, headers);
  // a page on another site must not be able to try passwords through the visitor's browser
  if (!sameOriginRequest(req)) return inLanguage(req, setting, () => refuse(403, tr('登录请求来源不对')));
  const https = viaHttps(req);
  // over plain HTTP the password could be read on the way: only this machine itself may (SSH tunnel, local test)
  if (!https && !internalRequest(req)) return inLanguage(req, setting, () => refuse(403, tr('请用 HTTPS 地址登录')));
  let body = '';
  let tooLong = false;
  req.on('data', (c: Buffer) => {
    if (tooLong) return;
    body += c.toString();
    if (body.length > 4096) tooLong = true;
  });
  req.on('end', () => {
    void (async () => {
      let j: any = {};
      try { j = tooLong ? {} : JSON.parse(body || '{}'); } catch { /* treated as a wrong password */ }
      const ip = clientAddress(req);
      const r = await login.attempt(String(j.username ?? ''), String(j.password ?? ''), ip);
      if (r.ok) {
        json(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=${r.token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}` });
        return;
      }
      if (r.reason !== 'busy') console.warn(`[login] ${r.reason === 'locked' ? 'locked out' : 'failed attempt'} from ${ip}`);
      inLanguage(req, setting, () => {
        if (r.reason === 'wrong') refuse(401, tr('用户名或密码不对'));
        else {
          const minutes = Math.max(1, Math.ceil(r.retryAfterMs / 60_000));
          const retry = { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) };
          if (r.reason === 'locked') refuse(429, tr('失败次数太多，{minutes} 分钟后再试', { minutes }), retry);
          else refuse(429, tr('登录请求太多，请稍后再试'), retry);
        }
      });
    })().catch((e) => {
      console.error('[login]', e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
}

/** The login page and endpoints; true when this request was one of them. */
export function handleLogin(login: LoginService | null, req: http.IncomingMessage, res: http.ServerResponse, url: URL, opts: { language: () => unknown; onLogout: () => void }): boolean {
  if (url.pathname === '/api/auth/status' && req.method === 'GET') {
    json(res, 200, { login: !!login, authed: !login || login.valid(cookieValue(req.headers.cookie, SESSION_COOKIE)) });
    return true;
  }
  if (!login) return false;
  if (url.pathname === '/login' && req.method === 'GET') {
    if (login.valid(cookieValue(req.headers.cookie, SESSION_COOKIE))) { res.writeHead(302, { location: '/' }).end(); return true; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff' });
    res.end(inLanguage(req, opts.language(), loginPage));
    return true;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    serveLogin(login, req, res, opts.language());
    return true;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    if (!sameOriginRequest(req)) { res.writeHead(403).end(); return true; }
    login.logout(cookieValue(req.headers.cookie, SESSION_COOKIE));
    opts.onLogout();
    json(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${viaHttps(req) ? '; Secure' : ''}` });
    return true;
  }
  return false;
}

/** Not signed in: a page opened in the browser goes to the login page, anything else is told so. */
export function denyAnonymous(req: http.IncomingMessage, res: http.ServerResponse) {
  const navigation = (req.method === 'GET' || req.method === 'HEAD') && (req.headers['sec-fetch-dest'] === 'document' || String(req.headers.accept ?? '').includes('text/html'));
  if (navigation) res.writeHead(302, { location: '/login', 'cache-control': 'no-store' }).end();
  else json(res, 401, { error: 'login required' });
}
