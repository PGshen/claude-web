import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAC_SWAP_SCRIPT, REQUIRED_MARK, firstLine, isRequired, macBundle, macSelfUpdateBlocker, macZip, manualDownloadUrl, notesText, releaseFileUrl, releasePage, swapResult, updateMode } from './update-policy';

describe('which builds update themselves', () => {
  it('the Windows installer and a Mac app that can replace itself; portable, a Mac app that cannot, and Linux get a download link', () => {
    expect(updateMode('win32', {})).toBe('auto');
    expect(updateMode('win32', { PORTABLE_EXECUTABLE_FILE: 'D:\\apps\\ClaudeWeb-0.1.2-portable.exe' })).toBe('manual');
    expect(updateMode('darwin', {}, true)).toBe('auto');
    expect(updateMode('darwin', {})).toBe('manual');
    expect(updateMode('linux', {}, true)).toBe('manual');
  });

  it('the .app a Mac main process runs from', () => {
    expect(macBundle('/Applications/Claude Web.app/Contents/MacOS/Claude Web')).toBe('/Applications/Claude Web.app');
    expect(macBundle('/Users/me/my.app.d/Claude Web.app/Contents/MacOS/Claude Web')).toBe('/Users/me/my.app.d/Claude Web.app');
    expect(macBundle('/usr/local/bin/electron')).toBeNull();
    expect(macBundle('C:\\Program Files\\Claude Web\\Claude Web.exe')).toBeNull();
  });

  it('a Mac app cannot replace itself when it runs from source, is translocated (opened from Downloads / a dmg) or sits in a folder it cannot write', () => {
    const bundle = '/Applications/Claude Web.app';
    expect(macSelfUpdateBlocker({ packaged: true, bundle, writable: true })).toBeNull();
    expect(macSelfUpdateBlocker({ packaged: false, bundle, writable: true })).toBe('dev');
    expect(macSelfUpdateBlocker({ packaged: true, bundle: null, writable: false })).toBe('not-bundle');
    expect(macSelfUpdateBlocker({ packaged: true, bundle: '/private/var/folders/x/T/AppTranslocation/1F2E/d/Claude Web.app', writable: true })).toBe('translocated');
    expect(macSelfUpdateBlocker({ packaged: true, bundle: '/Volumes/Claude Web 0.3.0/Claude Web.app', writable: false })).toBe('read-only');
  });

  it("the zip for this Mac in latest-mac.yml: its architecture, Rosetta takes arm64, none without a checksum", () => {
    const files = [
      { url: 'ClaudeWeb-0.3.0-mac-x64.zip', sha512: 'a', size: 1 },
      { url: 'ClaudeWeb-0.3.0-mac-x64.dmg', sha512: 'b', size: 1 },
      { url: 'ClaudeWeb-0.3.0-mac-arm64.zip', sha512: 'c', size: 1 },
      { url: 'ClaudeWeb-0.3.0-mac-arm64.dmg', sha512: 'd', size: 1 },
    ];
    expect(macZip(files, 'arm64')?.sha512).toBe('c');
    expect(macZip(files, 'x64')?.sha512).toBe('a');
    expect(macZip(files, 'x64', true)?.sha512).toBe('c');
    // latest-mac.yml overwritten by the other mac job (macos-ci 发版收尾): only one architecture left
    expect(macZip(files.slice(2), 'x64')).toBeNull();
    expect(macZip([{ url: 'ClaudeWeb-0.3.0-mac-arm64.zip' }], 'arm64')).toBeNull();
    expect(macZip(undefined, 'arm64')).toBeNull();
  });

  it('release files: GitHub by tag, a generic feed next to its yml, full URLs as they are', () => {
    expect(releaseFileUrl('o/r', '0.3.0', 'ClaudeWeb-0.3.0-mac-arm64.zip')).toBe('https://github.com/o/r/releases/download/v0.3.0/ClaudeWeb-0.3.0-mac-arm64.zip');
    expect(releaseFileUrl('o/r', '0.3.0', 'a.zip', 'http://127.0.0.1:9/feed//')).toBe('http://127.0.0.1:9/feed/a.zip');
    expect(releaseFileUrl('o/r', '0.3.0', 'https://cdn.example/a.zip')).toBe('https://cdn.example/a.zip');
  });

  it('what the last swap left', () => {
    expect(swapResult('ok 0.3.0\n')).toEqual({ ok: true, version: '0.3.0' });
    expect(swapResult('fail 0.3.0 mv: rename a to b: Operation not permitted\n')).toEqual({ ok: false, version: '0.3.0', error: 'mv: rename a to b: Operation not permitted' });
    expect(swapResult('fail 0.3.0')).toEqual({ ok: false, version: '0.3.0', error: 'unknown' });
    expect(swapResult('')).toBeNull();
  });
});

// The script a Mac app quits into (mac-update.ts), run for real on throwaway folders. POSIX only (macOS in CI, Linux).
describe.skipIf(process.platform === 'win32')('the swap script', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-swap-'));
    const apps = path.join(root, 'Applications');
    const stage = path.join(root, 'update');
    const app = path.join(apps, 'Claude Web.app');
    const fresh = path.join(stage, 'new', 'Claude Web.app');
    for (const [dir, v] of [[app, 'old'], [fresh, 'new']]) {
      fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Contents', 'v'), v);
    }
    const script = path.join(stage, 'swap.sh');
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
    const result = path.join(stage, 'result');
    // not spawnSync: a blocked event loop never reaps the stand-in app, and `kill -0` sees its zombie as running
    const swap = (pid: number, from = fresh) => new Promise<number | null>((resolve) =>
      spawn('/bin/sh', [script, String(pid), app, from, result, '0', '0.3.0'], { stdio: 'ignore' }).on('exit', (code) => resolve(code)));
    const version = () => fs.readFileSync(path.join(app, 'Contents', 'v'), 'utf8');
    return { root, apps, stage, app, fresh, result, swap, version };
  };

  it('waits for the app to exit, then puts the new app in its place and clears the old one away', async () => {
    const s = setup();
    const app = spawn('sleep', ['1']);
    const started = Date.now();
    expect(await s.swap(app.pid!)).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    expect(s.version()).toBe('new');
    expect(fs.existsSync(s.fresh)).toBe(false);
    expect(fs.existsSync(path.join(s.stage, 'new', 'previous.app'))).toBe(false);
    expect(swapResult(fs.readFileSync(s.result, 'utf8'))).toEqual({ ok: true, version: '0.3.0' });
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it('a new app that cannot be moved in: the old one is put back', async () => {
    const s = setup();
    expect(await s.swap(999_999_999, path.join(s.stage, 'new', 'missing.app'))).toBe(1);
    expect(s.version()).toBe('old');
    expect(swapResult(fs.readFileSync(s.result, 'utf8'))).toMatchObject({ ok: false, version: '0.3.0' });
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  it.skipIf(process.getuid?.() === 0)('a folder it may not change (App Management, permissions): nothing moves, the failure is recorded', async () => {
    const s = setup();
    fs.chmodSync(s.apps, 0o555);
    try {
      expect(await s.swap(999_999_999)).toBe(1);
      expect(s.version()).toBe('old');
      expect(fs.existsSync(s.fresh)).toBe(true);
      const res = swapResult(fs.readFileSync(s.result, 'utf8'));
      expect(res).toMatchObject({ ok: false, version: '0.3.0' });
      expect(res?.error).not.toBe('unknown');
    } finally {
      fs.chmodSync(s.apps, 0o755);
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe('release notes', () => {
  it('GitHub gives the body as HTML: paragraphs, list items and line breaks survive as lines, entities are decoded', () => {
    const html = '<h2>修复</h2>\n<ul>\n<li><strong>停止</strong>一定能停下来。</li>\n<li>A &amp; B &lt;ok&gt; &#x4e2d;&#25991;</li>\n</ul>\n<p>第一行<br>第二行</p>';
    expect(notesText(html)).toBe('修复\n\n• 停止一定能停下来。\n• A & B <ok> 中文\n\n第一行\n第二行');
  });

  it('full changelogs come as an array; nothing usable is undefined', () => {
    expect(notesText([{ version: '0.1.3', note: '<p>三</p>' }, { version: '0.1.2', note: null }, { version: '0.1.1', note: '二' }])).toBe('三\n\n二');
    expect(notesText(undefined)).toBeUndefined();
    expect(notesText('   ')).toBeUndefined();
    expect(notesText({})).toBeUndefined();
  });

  it('a release marked 必须更新 in its notes cannot be put off', () => {
    expect(isRequired(notesText(`<p><strong>${REQUIRED_MARK}</strong> 修复了会丢数据的问题</p>`))).toBe(true);
    expect(isRequired('必须更新')).toBe(false); // only the exact mark, not the words in passing
    expect(isRequired(undefined)).toBe(false);
  });
});

describe('where a build that cannot update itself downloads from', () => {
  const repo = 'PGshen/claude-web';
  it('its own kind of file, for this machine', () => {
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'darwin', arch: 'arm64' })).toBe('https://github.com/PGshen/claude-web/releases/download/v0.1.3/ClaudeWeb-0.1.3-mac-arm64.dmg');
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'darwin', arch: 'x64' })).toBe('https://github.com/PGshen/claude-web/releases/download/v0.1.3/ClaudeWeb-0.1.3-mac-x64.dmg');
    // the Intel build running under Rosetta on Apple Silicon: offer the native one
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'darwin', arch: 'x64', arm64Translated: true })).toMatch(/mac-arm64\.dmg$/);
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'win32', arch: 'x64', portable: true })).toMatch(/\/ClaudeWeb-0\.1\.3-portable\.exe$/);
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'win32', arch: 'x64' })).toMatch(/\/ClaudeWeb-0\.1\.3-win-x64\.exe$/);
    expect(manualDownloadUrl({ repo, version: '0.1.3', platform: 'linux', arch: 'x64' })).toBe(releasePage(repo, '0.1.3'));
    expect(manualDownloadUrl({ repo, version: '9.9.9', platform: 'darwin', arch: 'arm64', feed: 'http://127.0.0.1:5000/feed' })).toBe('http://127.0.0.1:5000/feed/ClaudeWeb-9.9.9-mac-arm64.dmg');
  });
});

it('errors keep their first line only', () => {
  expect(firstLine(new Error('HttpError: 404\n"method: GET url: …"\nheaders…'))).toBe('HttpError: 404');
});
