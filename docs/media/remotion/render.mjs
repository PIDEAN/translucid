// Renders the README animations: every composition to a PNG sequence, then to docs/images/<id>.gif with one
// palette per animation. Run after the captures (`pnpm readme:media` does both). `node render.mjs scan picker`
// renders only those scenes.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGES = join(HERE, '../../images');
const SCENES = ['languages', 'scan', 'review', 'picker', 'immersive'];
const GIF_WIDTH = 1280;

/** Playwright's headless shell, when installed, saves Remotion a browser download. */
function headlessShell() {
  for (const cache of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue;
    const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const d of dirs) {
      for (const sub of readdirSync(join(cache, d))) {
        const bin = join(cache, d, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return undefined;
}

const only = process.argv.slice(2);
const browser = headlessShell();
for (const id of only.length ? only : SCENES) {
  if (!SCENES.includes(id)) throw new Error(`Unknown scene ${id}`);
  // Remotion refuses sequence folders with a dot anywhere in the path, so frames stay out of ../.out.
  const frames = join(HERE, 'frames', id);
  rmSync(frames, { recursive: true, force: true });
  execFileSync('pnpm', ['exec', 'remotion', 'render', 'src/index.ts', id, `frames/${id}`, '--sequence', '--image-format=png', ...(browser ? [`--browser-executable=${browser}`] : [])], { cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'] });
  const digits = /(\d+)\.png$/.exec(readdirSync(frames).sort()[0] ?? '')?.[1]?.length ?? 3;
  const gif = join(IMAGES, `${id}.gif`);
  // Repeated frames (holds) collapse into longer delays; flat UI colours need no dithering.
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-framerate', '25', '-i', join(frames, `element-%0${digits}d.png`),
    '-vf', `mpdecimate=hi=64:lo=32:frac=0,scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-fps_mode', 'vfr', '-loop', '0', gif,
  ], { stdio: 'inherit' });
  console.log(`${id}.gif  ${(statSync(gif).size / 1024).toFixed(0)} KB`);
}
