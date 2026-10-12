// One README animation: the captured frames in a browser window, with pointer, popups, transitions,
// camera moves and captions laid over them.
import { useMemo, type ReactNode } from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import icon from '../../../../public/icon/48.png';
import { Window } from './Browser';
import {
  build, camAt, clamp, ease, enterMs, H, PAGE, pointerAt, POPUP, shotAt, STAGE_H, T, W, WIN,
  type SceneData, type Shot, type Timeline,
} from './timeline';

export type SceneProps = { scene: string; title: string; data: SceneData | null };

const BG = '#14161b';
const AMBER = '#f2b33d';
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif';

const Page = ({ shot }: { shot: Shot }) => <Img src={staticFile(shot.img)} style={{ position: 'absolute', inset: 0, width: PAGE.w, height: PAGE.h }} />;

/** The amber "language layer" edge that reveals the new frame from left to right. */
function Sweep({ p, children }: { p: number; children: ReactNode }) {
  const x = p * PAGE.w;
  const glow = Math.min(1, p * 6, (1 - p) * 6);
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }}>{children}</div>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: x - 110, width: 110, opacity: glow, background: 'linear-gradient(90deg, rgba(242,179,61,0), rgba(242,179,61,.22))' }} />
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: x - 1.5, width: 3, opacity: glow, background: AMBER, boxShadow: '0 0 16px 3px rgba(242,179,61,.55)' }} />
    </>
  );
}

/** `next` entering over `prev` with the given transition at progress p. */
function Transition({ kind, p, prev, next }: { kind: Shot['enter']; p: number; prev: ReactNode; next: ReactNode }) {
  if (p >= 1 || kind === 'cut' || !kind) return <>{next}</>;
  return (
    <>
      {prev}
      {/* Fades step in thirds: a GIF repaints every pixel of a blended frame. */}
      {kind === 'fade' ? <div style={{ position: 'absolute', inset: 0, opacity: Math.ceil(p * 3) / 3 }}>{next}</div> : <Sweep p={ease(p)}>{next}</Sweep>}
    </>
  );
}

function Popup({ src, opacity, lift }: { src: string; opacity: number; lift: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: POPUP.x,
        top: POPUP.y,
        width: POPUP.w,
        borderRadius: 10,
        overflow: 'hidden',
        opacity,
        transform: `translateY(${-6 * lift}px) scale(${1 - 0.02 * lift})`,
        transformOrigin: 'top right',
        boxShadow: '0 0 0 1px rgba(0,0,0,.08), 0 14px 40px rgba(16,18,24,.28)',
        background: '#fff',
        // Chrome caps popups at 600 px and scrolls the rest; this one also stays inside the window.
        maxHeight: PAGE.h - 16,
      }}
    >
      <Img src={staticFile(src)} style={{ width: POPUP.w, display: 'block' }} />
    </div>
  );
}

function Pointer({ tl, t }: { tl: Timeline; t: number }) {
  const p = pointerAt(tl, t);
  if (!p) return null;
  return (
    <>
      {p.ripple !== undefined && p.ripple < 1 && (
        <div
          style={{
            position: 'absolute',
            left: p.x - 24,
            top: p.y - 24,
            width: 48,
            height: 48,
            borderRadius: 24,
            border: '2px solid rgba(47,86,214,.7)',
            background: 'rgba(47,86,214,.12)',
            opacity: (1 - p.ripple) * p.opacity,
            transform: `scale(${0.3 + 0.9 * ease(p.ripple)})`,
          }}
        />
      )}
      <svg
        width={26}
        height={26}
        viewBox="0 0 24 24"
        style={{ position: 'absolute', left: p.x - 5.5, top: p.y - 3, opacity: p.opacity, transform: `scale(${1 - 0.14 * p.press})`, transformOrigin: '5.5px 3px', filter: 'drop-shadow(0 1.5px 2px rgba(0,0,0,.35))' }}
      >
        <path d="M5.5 3v16.2l4.3-4.2 2.7 6.2 2.6-1.1-2.7-6.1h6z" fill="#111" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </>
  );
}

function Rings({ tl, t }: { tl: Timeline; t: number }) {
  return (
    <>
      {tl.rings.map((r, i) => {
        const inP = clamp((t - r.from) / 220);
        const o = Math.min(inP, clamp((r.to - t) / 200));
        if (o <= 0) return null;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: PAGE.x + r.box.x - 4,
              top: PAGE.y + r.box.y - 4,
              width: r.box.w + 8,
              height: r.box.h + 8,
              borderRadius: 9,
              border: `2.5px solid ${AMBER}`,
              boxShadow: '0 0 0 4px rgba(242,179,61,.2)',
              opacity: o,
              transform: `scale(${1.08 - 0.08 * ease(inP)})`,
            }}
          />
        );
      })}
    </>
  );
}

function Keys({ tl, t }: { tl: Timeline; t: number }) {
  const s = tl.shots.find((x) => x.keys && t >= x.appear && t < x.end);
  if (!s?.keys) return null;
  return (
    <div style={{ position: 'absolute', left: PAGE.x, width: PAGE.w, top: PAGE.y + PAGE.h - 86, display: 'flex', justifyContent: 'center', gap: 10 }}>
      {s.keys.map((k, j) => {
        const d = t - s.appear - j * 170;
        const inP = clamp(d / 140);
        const out = clamp((s.appear + 900 + j * 170 - t) / 200 + 1);
        return (
          <span
            key={j}
            style={{
              minWidth: 52,
              height: 52,
              borderRadius: 12,
              background: 'rgba(20,22,27,.86)',
              color: '#fff',
              fontSize: 26,
              fontWeight: 600,
              display: 'grid',
              placeItems: 'center',
              boxShadow: '0 3px 0 rgba(0,0,0,.35), 0 10px 24px rgba(0,0,0,.25)',
              opacity: inP * out,
              transform: `translateY(${(1 - inP) * 8}px) scale(${0.85 + 0.15 * inP})`,
            }}
          >
            {k}
          </span>
        );
      })}
    </div>
  );
}

const ROW_Y = PAGE.y + PAGE.h + 34;

function Chip({ children }: { children: ReactNode }) {
  return <span style={{ background: AMBER, color: '#3d2a00', fontSize: 15, fontWeight: 700, padding: '6px 12px', borderRadius: 8, whiteSpace: 'nowrap' }}>{children}</span>;
}

function Captions({ tl, t, back }: { tl: Timeline; t: number; back: number }) {
  let k = 0;
  tl.captions.forEach((c, i) => { if (c.at <= t) k = i; });
  const cur = tl.captions[k];
  const prev = tl.captions[k - 1];
  // The opening caption is already there on the first frame (the loop lands on it).
  const p = k === 0 ? 1 : clamp((t - (cur?.at ?? 0)) / (T.caption * 1.5));
  const line = (text: string, o: number, dy: number) => (
    <span style={{ position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap', opacity: o, transform: `translateY(${dy}px)` }}>{text}</span>
  );
  const first = tl.captions[0]?.text;
  return (
    <div style={{ position: 'relative', flex: 1, height: 28, fontSize: 19, color: '#e9ebf0', letterSpacing: 0.2 }}>
      {back > 0 && first !== cur?.text ? (
        <>
          {cur && line(cur.text, 1 - clamp(back * 2.2), -6 * back)}
          {first && line(first, clamp((back - 0.35) / 0.65), 6 * (1 - back))}
        </>
      ) : (
        <>
          {prev && p < 1 && line(prev.text, 1 - clamp(p * 2.2), -6 * p)}
          {cur && line(cur.text, clamp((p - 0.35) / 0.65), 6 * (1 - p))}
        </>
      )}
    </div>
  );
}

function Languages({ langs, from, to, p }: { langs: string[]; from: number; to: number; p: number }) {
  const CW = 98;
  const GAP = 6;
  const x = (from + (to - from) * p) * (CW + GAP);
  return (
    <div style={{ position: 'relative', display: 'flex', gap: GAP }}>
      <span style={{ position: 'absolute', left: x, top: 0, width: CW, height: 34, borderRadius: 9, background: 'rgba(242,179,61,.16)', boxShadow: `inset 0 0 0 1.5px ${AMBER}` }} />
      {langs.map((l, i) => {
        const on = Math.max(0, 1 - Math.abs(from + (to - from) * p - i));
        return (
          <span key={l} style={{ position: 'relative', width: CW, height: 34, display: 'grid', placeItems: 'center', fontSize: 16, color: on > 0.5 ? '#fff' : '#9aa1ac', fontWeight: on > 0.5 ? 650 : 500 }}>
            {l}
          </span>
        );
      })}
    </div>
  );
}

export function Scene({ data, title }: SceneProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tl = useMemo(() => (data ? build(data) : null), [data]);
  if (!tl || !data) return <AbsoluteFill style={{ background: BG }} />;
  const t = (frame / fps) * 1000;
  if (tl.loop === 'fade' && t >= tl.loopAt) {
    // Loop: the opening frame fades in over the last one, in four steps (each step repaints the whole GIF frame).
    const q = Math.ceil(clamp((t - tl.loopAt) / (tl.total - tl.loopAt)) * 4) / 4;
    return (
      <AbsoluteFill>
        <Frame tl={tl} data={data} title={title} t={tl.loopAt - 1} />
        <AbsoluteFill style={{ opacity: q }}>
          <Frame tl={tl} data={data} title={title} t={0} />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }
  return <Frame tl={tl} data={data} title={title} t={t} />;
}

function Frame({ tl, data, title, t }: { tl: Timeline; data: SceneData; title: string; t: number }) {
  const k = shotAt(tl, t);
  const cur = tl.shots[k]!;
  const prev = tl.shots[k - 1];
  const first = tl.shots[0]!;
  const p = k === 0 ? 1 : clamp((t - cur.appear) / Math.max(1, enterMs(cur.enter)));
  // Sweep loop (languages): the last frame turns back into the first under the language layer.
  const back = tl.loop === 'sweep' && t >= tl.loopAt ? clamp((t - tl.loopAt) / (tl.total - tl.loopAt)) : 0;

  const page = back > 0
    ? <Transition kind={tl.loop} p={back} prev={<Page shot={cur} />} next={<Page shot={first} />} />
    : <Transition kind={cur.enter} p={prev ? p : 1} prev={prev && <Page shot={prev} />} next={<Page shot={cur} />} />;

  // Popups open and close on their own, over any page transition.
  const popups: ReactNode[] = [];
  let active = 0;
  const pop = (src: string | undefined, o: number, lift: number) => {
    if (!src || o <= 0) return;
    active = Math.max(active, o);
    popups.push(<Popup key={`${src}-${popups.length}`} src={src} opacity={o} lift={lift} />);
  };
  if (back > 0) pop(cur.popup, 1 - clamp(back * 3), 0);
  else if (prev && prev.popup !== cur.popup) {
    const d = t - cur.appear;
    pop(prev.popup, 1 - clamp(d / T.popOut), 0);
    const inP = ease(clamp(d / T.popIn));
    pop(cur.popup, inP, 1 - inP);
  } else pop(cur.popup, 1, 0);

  // Camera moves step every 80 ms: whole-frame changes are what make a GIF heavy, the pointer stays smooth.
  const cam = camAt(tl, Math.floor(t / 80) * 80);
  const speed = cur.speed && back === 0 ? Math.min(clamp((t - cur.appear) / 150) + (prev?.speed ? 1 : 0), 1) : 0;
  const langs = data.langs;
  const li = (s?: Shot) => Math.max(0, langs?.indexOf(s?.lang ?? '') ?? 0);

  return (
    <AbsoluteFill style={{ background: BG, fontFamily: FONT }}>
      <AbsoluteFill style={{ transformOrigin: '0 0', transform: `translate(${cam.sx - cam.s * cam.fx}px, ${cam.sy - cam.s * cam.fy}px) scale(${cam.s})` }}>
        <Window url={(back > 0.5 ? first.url : prev && p < 0.5 ? prev.url : cur.url) ?? ''} active={active}>
          <div style={{ position: 'relative', width: PAGE.w, height: PAGE.h, overflow: 'hidden' }}>{page}</div>
        </Window>
        <Rings tl={tl} t={t} />
        {popups}
        <Pointer tl={tl} t={t} />
      </AbsoluteFill>
      {/* Zoomed frames stop above the caption row. */}
      <div style={{ position: 'absolute', left: 0, top: STAGE_H, width: W, height: H - STAGE_H, background: BG, opacity: clamp((cam.s - 1) * 5) }} />
      <Keys tl={tl} t={t} />
      {/* Caption row: what is happening, under the window. */}
      <div style={{ position: 'absolute', left: WIN.x, width: WIN.w, top: ROW_Y, height: 40, display: 'flex', alignItems: 'center', gap: 14 }}>
        <Chip>{title}</Chip>
        {langs ? (
          <Languages
            langs={langs}
            from={back > 0 ? li(cur) : li(prev ?? cur)}
            to={back > 0 ? 0 : li(cur)}
            p={back > 0 ? ease(back) : prev ? ease(p) : 1}
          />
        ) : (
          <Captions tl={tl} t={t} back={back} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          {speed > 0 && (
            <span style={{ opacity: speed, color: '#e9ebf0', fontSize: 14, fontWeight: 600, padding: '4px 10px', borderRadius: 7, background: 'rgba(255,255,255,.1)' }}>▶▶ {cur.speed}× 速度</span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8a909b', fontSize: 15, fontWeight: 600 }}>
            <Img src={icon} style={{ width: 20, height: 20 }} />
            Translucid
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
