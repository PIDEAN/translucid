// Turns a capture timeline (docs/media/.out/<scene>.json) into everything the video needs per moment:
// when each frame appears, where the pointer is, when it clicks, the camera and the captions. All times in ms.
import { Easing } from 'remotion';

export const FPS = 25;
export const W = 1280;
export const H = 800;
/** Browser window; the captured page (1160×600 CSS px) sits under its toolbar. */
export const WIN = { x: 60, y: 40, w: 1160, bar: 46, r: 12 };
export const PAGE = { x: WIN.x, y: WIN.y + WIN.bar, w: 1160, h: 600 };
/** Centre of the extension's toolbar icon. */
export const ICON = { x: WIN.x + WIN.w - 96, y: WIN.y + WIN.bar / 2 };
/** Popups hang under the toolbar icon, like Chrome's. */
export const POPUP = { x: ICON.x + 26 - 372, y: PAGE.y + 2, w: 372 };
/** The area zooms are framed in (the caption row stays below it). */
export const STAGE_H = PAGE.y + PAGE.h + 6;

export const T = { fade: 300, sweep: 760, popIn: 200, popOut: 160, zoomIn: 640, zoomOut: 500, caption: 260 };

export interface Box { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }
export interface Shot {
  img: string;
  popup?: string;
  dur: number;
  cursor?: { x: number; y: number; on: 'page' | 'popup' | 'toolbar' };
  click?: boolean;
  caption?: string;
  zoom?: Box;
  enter?: 'cut' | 'fade' | 'sweep';
  lang?: string;
  url?: string;
  keys?: string[];
  speed?: number;
  marks?: Box[];
}
export interface SceneData { scene: string; langs?: string[]; loop?: 'fade' | 'sweep'; shots: Shot[] }

export interface Timed extends Shot {
  i: number;
  start: number;
  end: number;
  /** When the frame shows up: after the pointer arrives for hover states, else at the start. */
  appear: number;
  at?: Pt;
  from?: Pt;
  travelEnd?: number;
  clickAt?: number;
}

/** Camera: content point (fx, fy) is drawn at screen point (sx, sy), scaled by s. */
export interface Cam { s: number; fx: number; fy: number; sx: number; sy: number }
export const NO_CAM: Cam = { s: 1, fx: W / 2, fy: STAGE_H / 2, sx: W / 2, sy: STAGE_H / 2 };

export interface Timeline {
  shots: Timed[];
  /** The tail where the last frame turns back into the first, so the GIF loops without a jump. */
  loopAt: number;
  loop: 'fade' | 'sweep';
  total: number;
  captions: { text: string; at: number }[];
  cams: { t: number; cam: Cam }[];
  /** Spans where the pointer is on screen. */
  pointer: { from: number; to: number }[];
  /** Outlines around page boxes, shown once the camera settles. */
  rings: { box: Box; from: number; to: number }[];
}

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const enterMs = (e: Shot['enter']) => (e === 'fade' ? T.fade : e === 'sweep' ? T.sweep : 0);
export const ease = Easing.bezier(0.65, 0, 0.35, 1);
const sameBox = (a?: Box, b?: Box) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function target(c: NonNullable<Shot['cursor']>): Pt {
  if (c.on === 'toolbar') return { x: ICON.x, y: ICON.y };
  if (c.on === 'popup') return { x: POPUP.x + c.x, y: POPUP.y + c.y };
  return { x: PAGE.x + c.x, y: PAGE.y + c.y };
}

/** Frame a page box in the stage, keeping the view inside the window. */
export function zoomCam(box: Box): Cam {
  const s = Math.min(2, (W * 0.9) / box.w, (STAGE_H * 0.9) / box.h);
  const hw = W / s / 2;
  const hh = STAGE_H / s / 2;
  const fit = (v: number, lo: number, hi: number, half: number) => (hi - lo <= half * 2 ? (lo + hi) / 2 : clamp(v, lo + half, hi - half));
  return {
    s,
    fx: fit(PAGE.x + box.x + box.w / 2, WIN.x, WIN.x + WIN.w, hw),
    fy: fit(PAGE.y + box.y + box.h / 2, WIN.y, PAGE.y + PAGE.h, hh),
    sx: W / 2,
    sy: STAGE_H / 2,
  };
}

export function build(data: SceneData): Timeline {
  let t = 0;
  let last: Pt | undefined;
  const shots: Timed[] = data.shots.map((s, i) => {
    const start = t;
    const end = (t += s.dur);
    const shot: Timed = { ...s, i, start, end, appear: start };
    if (s.cursor) {
      const at = target(s.cursor);
      const from = last ?? { x: at.x + 150, y: at.y + 120 };
      const dist = Math.hypot(at.x - from.x, at.y - from.y);
      shot.at = at;
      if (dist > 2) {
        shot.from = from;
        shot.travelEnd = start + Math.min(s.dur * 0.6, clamp(280 + dist * 0.5, 380, 760));
        // A hover state (highlight under the pointer) shows once the pointer gets there.
        if (i > 0 && (s.enter ?? 'cut') === 'cut') shot.appear = shot.travelEnd;
      }
      if (s.click) shot.clickAt = Math.min(end - 120, Math.max((shot.travelEnd ?? start) + 140, end - Math.min(220, s.dur * 0.35)));
      last = at;
    }
    return shot;
  });
  const loopAt = t;
  const loop = data.loop ?? 'fade';
  const total = loopAt + (loop === 'sweep' ? T.sweep : 500);

  const captions: Timeline['captions'] = [];
  for (const s of shots) if (s.caption && s.caption !== captions.at(-1)?.text) captions.push({ text: s.caption, at: captions.length ? s.start : 0 });

  const cams: Timeline['cams'] = [{ t: 0, cam: NO_CAM }];
  shots.forEach((s, k) => {
    if (!s.zoom) return;
    const cam = zoomCam(s.zoom);
    if (!sameBox(shots[k - 1]?.zoom, s.zoom)) {
      const t0 = s.appear + enterMs(s.enter);
      cams.push({ t: t0, cam: NO_CAM }, { t: t0 + T.zoomIn, cam });
    }
    // The last shot stays zoomed: the loop fades the opening frame in over it.
    const last = k === shots.length - 1 && loop === 'fade';
    if (!sameBox(shots[k + 1]?.zoom, s.zoom) && !last) cams.push({ t: s.end - T.zoomOut, cam }, { t: s.end, cam: NO_CAM });
  });

  // The pointer stays between nearby moves and leaves after a longer pause.
  const pointer: Timeline['pointer'] = [];
  for (const s of shots) {
    if (!s.cursor) continue;
    const span = pointer.at(-1);
    if (span && s.start - span.to < 1500) span.to = s.end;
    else pointer.push({ from: s.start, to: s.end });
  }
  for (const p of pointer) p.to = Math.min(p.to + 300, loopAt);

  const rings: Timeline['rings'] = [];
  shots.forEach((s, k) => {
    const zoomIn = !!s.zoom && !sameBox(shots[k - 1]?.zoom, s.zoom);
    const zoomOut = !!s.zoom && !sameBox(shots[k + 1]?.zoom, s.zoom) && !(k === shots.length - 1 && loop === 'fade');
    const settle = zoomIn ? s.appear + enterMs(s.enter) + T.zoomIn : s.appear;
    const leave = zoomOut ? s.end - T.zoomOut : s.end;
    s.marks?.forEach((box, j) => {
      const open = rings.find((r) => sameBox(r.box, box) && r.to === s.start);
      if (open) open.to = leave;
      else rings.push({ box, from: settle + j * 140, to: leave });
    });
  });

  return { shots, loopAt, loop, total, captions, cams, pointer, rings };
}

/** Index of the shot on screen at `t` (by appear time). */
export function shotAt(tl: Timeline, t: number): number {
  let k = 0;
  for (let i = 0; i < tl.shots.length; i++) if (tl.shots[i]!.appear <= t) k = i;
  return k;
}

export function camAt(tl: Timeline, t: number): Cam {
  const ks = tl.cams;
  let a = ks[0]!;
  for (const k of ks) {
    if (k.t > t) {
      const p = ease(clamp((t - a.t) / Math.max(1, k.t - a.t)));
      const lerp = (x: number, y: number) => x + (y - x) * p;
      return { s: a.cam.s * (k.cam.s / a.cam.s) ** p, fx: lerp(a.cam.fx, k.cam.fx), fy: lerp(a.cam.fy, k.cam.fy), sx: lerp(a.cam.sx, k.cam.sx), sy: lerp(a.cam.sy, k.cam.sy) };
    }
    a = k;
  }
  return a.cam;
}

const glide = Easing.bezier(0.45, 0, 0.2, 1);

/** Pointer position, opacity and press state at `t`. */
export function pointerAt(tl: Timeline, t: number): { x: number; y: number; opacity: number; press: number; ripple?: number } | null {
  const span = tl.pointer.find((p) => t >= p.from && t < p.to + 250);
  if (!span) return null;
  let pos: Pt | undefined;
  let press = 0;
  let ripple: number | undefined;
  for (const s of tl.shots) {
    if (!s.at || s.start > t) continue;
    pos = s.at;
    if (s.from && s.travelEnd && t < s.travelEnd) {
      const p = glide(clamp((t - s.start) / (s.travelEnd - s.start)));
      const dx = s.at.x - s.from.x;
      const dy = s.at.y - s.from.y;
      // A slight arc, like a hand moving a mouse.
      const arc = Math.sin(Math.PI * p) * Math.hypot(dx, dy) * 0.06;
      const len = Math.hypot(dx, dy) || 1;
      pos = { x: s.from.x + dx * p - (dy / len) * arc, y: s.from.y + dy * p + (dx / len) * arc };
    }
    if (s.clickAt !== undefined && t >= s.clickAt - 60 && t < s.clickAt + 500) {
      const d = t - s.clickAt;
      press = d < 0 ? clamp((d + 60) / 60) : clamp(1 - (d - 60) / 120);
      if (d >= 0) ripple = d / 500;
    }
  }
  if (!pos) return null;
  const opacity = Math.min(clamp((t - span.from) / 180), clamp((span.to + 250 - t) / 250));
  return { ...pos, opacity, press, ripple };
}
