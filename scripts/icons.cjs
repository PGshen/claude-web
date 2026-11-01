// The app's mark everywhere from one drawing, web/public/icon.svg (the user's logo: a black squircle, white «r / b», an
// orange dot — 2026-10-17):
//   node scripts/icons.cjs
// writes web/public/icon-192.png and icon-512.png (PWA manifest, apple-touch-icon), and desktop/build/icon.png (512: the
// installer, the window and the tray; electron-builder makes .ico / .icns from it).
// The sidebar draws the same shapes inline (web/src/ui/AppLogo.tsx) — change both together.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const svgFile = path.join(root, 'web/public/icon.svg');
const svg = fs.readFileSync(svgFile);

(async () => {
  const out = [
    [path.join(root, 'web/public/icon-192.png'), 192],
    [path.join(root, 'web/public/icon-512.png'), 512],
    [path.join(root, 'desktop/build/icon.png'), 512],
  ];
  for (const [file, size] of out) {
    await sharp(svg, { density: Math.ceil((72 * size) / 100) * 2 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
    console.log(`wrote ${path.relative(root, file)} (${size}×${size})`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
