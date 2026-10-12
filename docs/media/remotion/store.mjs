// Chrome Web Store images in docs/store: five 1280×800 screenshots (stills of the README animations), the
// 440×280 and 1400×560 promo tiles, and a 128×128 store icon with the recommended 16 px padding.
// Run after the captures (`pnpm readme:media`), then `pnpm --dir docs/media/remotion store`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const STORE = join(ROOT, 'docs/store');
// Composition and frame (25 fps) of each screenshot, in listing order.
const SHOTS = [
  ['screenshot-1-languages', 'languages', 112],
  ['screenshot-2-scan', 'scan', 100],
  ['screenshot-3-review', 'review', 212],
  ['screenshot-4-immersive', 'immersive', 150],
  ['screenshot-5-picker', 'picker', 200],
  ['promo-small-440x280', 'promo-small', 0],
  ['promo-marquee-1400x560', 'promo-marquee', 0],
];

mkdirSync(STORE, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'translucid-store-'));
try {
  for (const [name, id, frame] of SHOTS) {
    const raw = join(tmp, `${name}.png`);
    execFileSync('pnpm', ['exec', 'remotion', 'still', 'src/index.ts', id, raw, `--frame=${frame}`, ...browserArgs()], { cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'] });
    // The store wants 24-bit images without alpha.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-pix_fmt', 'rgb24', join(STORE, `${name}.png`)]);
    console.log(`${name}.png`);
  }
  // Store icon: the artwork (6..122 in the 128 px icon) at 96 px inside 16 px of transparent padding.
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(ROOT, 'public/icon/128.png'), '-vf', 'crop=116:116:6:6,scale=96:96:flags=lanczos,pad=128:128:16:16:color=0x00000000', '-pix_fmt', 'rgba', join(STORE, 'icon-128.png')]);
  console.log('icon-128.png');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
