"""Assemble docs/images/hero.gif from the per-language frames that hero.media.ts captured.

Each language holds for a moment, then the next one is revealed by an amber "language layer" sweeping across the app
(the brand's amber stands for the user's language). Needs Pillow and ffmpeg.

    python3 docs/media/compose_hero.py
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
HERO = HERE / '.out'
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / 'images' / 'hero.gif'
FPS = 20
W, H = 960, 620
HOLD_FIRST, HOLD, SWEEP = 2.2, 1.5, 0.6
BAND = 90
AMBER = (242, 179, 61)

frames_dir = HERO / 'frames'
order = ['en', 'zh-CN', 'ja', 'es', 'de', 'fr', 'ko']
shots = [Image.open(frames_dir / f'{i}-{lang}.png').convert('RGB').resize((W, H), Image.LANCZOS) for i, lang in enumerate(order)]
rect = json.loads((frames_dir / 'rects.json').read_text())['en']
# The app area (inside the browser window): the sweep band is drawn there only.
ax, ay, aw, ah = (round(rect[k]) for k in ('x', 'y', 'w', 'h'))

def ease(t: float) -> float:
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2

def sweep(old: Image.Image, new: Image.Image, t: float) -> Image.Image:
    bx = round(ease(t) * (W + BAND))
    img = old.copy()
    if bx > 0:
        img.paste(new.crop((0, 0, min(bx, W), H)), (0, 0))
    # Amber band trailing the edge, inside the app rectangle.
    band = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(band)
    for i in range(BAND):
        x = bx - BAND + i
        if x < ax or x >= ax + aw:
            continue
        a = int(150 * (i / BAND) ** 1.6)
        d.line([(x, ay), (x, ay + ah - 1)], fill=AMBER + (a,))
    if ax <= bx < ax + aw:
        d.rectangle([bx - 1, ay, bx + 1, ay + ah - 1], fill=AMBER + (235,))
    return Image.alpha_composite(img.convert('RGBA'), band).convert('RGB')

tmp = HERO / 'gif-frames'
shutil.rmtree(tmp, ignore_errors=True)
tmp.mkdir()
n = 0
def put(img: Image.Image, count: int = 1) -> None:
    global n
    for _ in range(count):
        img.save(tmp / f'f{n:04d}.png')
        n += 1

for i, shot in enumerate(shots):
    put(shot, round((HOLD_FIRST if i == 0 else HOLD) * FPS))
    nxt = shots[(i + 1) % len(shots)]
    steps = round(SWEEP * FPS)
    for k in range(1, steps + 1):
        put(sweep(shot, nxt, k / steps))

OUT.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([
    'ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', str(tmp / 'f%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=160:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', str(OUT),
], check=True)
print(n, 'frames', OUT.stat().st_size // 1024, 'KB')
