import { describe, expect, it } from 'vitest';
import { changelogBody } from './changelog';
import enFile from '../../CHANGELOG.md?raw';
import zhFile from '../../CHANGELOG.zh-CN.md?raw';

/** The parts of `md` that are not in a fenced code block or an inline code span. */
function outsideCode(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const parts = line.split('`');
    parts.forEach((p, i) => { if (i % 2 === 0 || i === parts.length - 1) out.push(p); });
  }
  return out;
}

const SAMPLE = [
  '# Changelog',
  '',
  '**English** · [简体中文](CHANGELOG.zh-CN.md)',
  '',
  'Installers are on the [Releases](https://github.com/PGshen/claude-web/releases) page.',
  '',
  '## [0.3.1] — 2026-10-21',
  '',
  'See [the notes](docs/notes/gateway.md) and [above](#fixed).',
].join('\n');

describe('changelogBody', () => {
  it('drops the title and the language line (the page has its own)', () => {
    const out = changelogBody(SAMPLE);
    expect(out).not.toMatch(/^# Changelog/m);
    expect(out).not.toMatch(/CHANGELOG\.zh-CN\.md/);
    expect(out).toMatch(/^## \[0\.3\.1\]/m);
  });
  it('points repo-relative links at GitHub and leaves the others', () => {
    const out = changelogBody(SAMPLE);
    expect(out).toContain('(https://github.com/PGshen/claude-web/blob/main/docs/notes/gateway.md)');
    expect(out).toContain('(https://github.com/PGshen/claude-web/releases)');
    expect(out).toContain('(#fixed)');
  });
  it('drops the Chinese file\'s language line too', () => {
    expect(changelogBody('# 更新日志\n\n**简体中文** · [English](CHANGELOG.md)\n\n## [0.3.1]')).toBe('\n\n## [0.3.1]');
  });
  it('escapes placeholders like <relay host> but keeps <kbd>', () => {
    const out = changelogBody('Claude Code · <relay host> when <kbd>Ctrl</kbd>+<kbd>=</kbd>');
    expect(out).toContain('&lt;relay host>');
    expect(out).toContain('<kbd>Ctrl</kbd>');
    expect(out).toContain('<kbd>=</kbd>');
  });
  it('leaves inline code alone', () => {
    expect(changelogBody('use `<cw-from>` here')).toContain('`<cw-from>`');
  });
  it('leaves fenced code blocks alone', () => {
    const fence = '```html\n<div class="x"></div>\n```';
    expect(changelogBody(`before\n\n${fence}\n\nafter <b>`)).toContain(fence);
  });
  it.each([['CHANGELOG.md', enFile], ['CHANGELOG.zh-CN.md', zhFile]])('%s: no raw tags but <kbd> outside code', (_name, md) => {
    const tags = outsideCode(changelogBody(md)).flatMap((s) => s.match(/<[A-Za-z/][^>]*>?/g) ?? []);
    expect(tags.filter((t) => t !== '<kbd>' && t !== '</kbd>')).toEqual([]);
  });
});
