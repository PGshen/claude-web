// The site's theme recordings → site/media.json (file → sha256, bytes; the site's build checks every download
// against it, site/scripts/fetch-media.ts) and the `site-media` pre-release of the repo they are downloaded from.
// The recordings are never committed (spec §5.2). site/src/showcase/media.test.ts checks the list is complete.
//   node scripts/upload-site-media.cjs --dir <recordings> [--manifest-only]
// --manifest-only: only write site/media.json (stand-ins, a dry run). Without it this changes the public release:
// run it only when the person in charge has said so.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const media = require('./lib/media-encode.cjs');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'PGshen/claude-web';
const TAG = 'site-media';
const NAME = /^[a-z0-9-]+\.(en|zh)((-sm)?\.(webm|mp4)|\.webp)$/;

const i = process.argv.indexOf('--dir');
if (i < 0 || !process.argv[i + 1]) { console.error('usage: node scripts/upload-site-media.cjs --dir <recordings> [--manifest-only]'); process.exit(2); }
const dir = path.resolve(process.argv[i + 1]);
const files = fs.readdirSync(dir).filter((f) => NAME.test(f)).sort();
const firstWebm = files.find((f) => f.endsWith('.webm'));
if (!firstWebm) { console.error(`no recordings in ${dir}`); process.exit(2); }

const manifest = { repo: REPO, tag: TAG, webmCodecs: media.webmCodecs(path.join(dir, firstWebm)), files: {} };
let total = 0;
for (const f of files) {
  const b = fs.readFileSync(path.join(dir, f));
  manifest.files[f] = { sha256: crypto.createHash('sha256').update(b).digest('hex'), bytes: b.length };
  total += b.length;
}
fs.writeFileSync(path.join(ROOT, 'site', 'media.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`site/media.json: ${files.length} files, ${(total / 1048576).toFixed(1)} MB, webm ${manifest.webmCodecs}`);
if (process.argv.includes('--manifest-only')) process.exit(0);

const gh = (args) => execFileSync('gh', args, { windowsHide: true, stdio: 'inherit' });
try {
  execFileSync('gh', ['release', 'view', TAG, '--repo', REPO], { windowsHide: true, stdio: 'ignore' });
} catch {
  gh(['release', 'create', TAG, '--repo', REPO, '--prerelease', '--target', 'main', '--title', 'Site media',
    '--notes', 'Recordings for the website’s theme showcase (scripts/record-themes.cjs). Not a release of the app.']);
}
for (let k = 0; k < files.length; k += 10) gh(['release', 'upload', TAG, '--repo', REPO, '--clobber', ...files.slice(k, k + 10).map((f) => path.join(dir, f))]);
console.log(`uploaded ${files.length} files to ${REPO}@${TAG}`);
