// Chrome Web Store promo tiles: brand first (icon, name, one line), plus a glimpse of the product on the
// large tile. Same palette as the README animations: amber is the user's language.
import { AbsoluteFill, Img, staticFile } from 'remotion';
import icon from '../../../../public/icon/128.png';

export type PromoProps = { variant: 'small' | 'marquee' };

const BG = '#14161b';
const AMBER = '#f2b33d';
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif';

function Brand({ scale }: { scale: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 * scale }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 * scale }}>
        <Img src={icon} style={{ width: 72 * scale, height: 72 * scale }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 * scale }}>
          <span style={{ color: '#fff', fontSize: 40 * scale, fontWeight: 750, letterSpacing: -0.5 * scale, lineHeight: 1.05 }}>Translucid</span>
          <span style={{ color: AMBER, fontSize: 22 * scale, fontWeight: 650, letterSpacing: 4 * scale }}>透译</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 * scale, color: '#d5d9e0', fontSize: 19 * scale, fontWeight: 500, lineHeight: 1.45 }}>
        <span>网页应用的界面，换成任意语言</span>
        <span>用你自己的大模型，双语阅读网页</span>
      </div>
    </div>
  );
}

export function Promo({ variant }: PromoProps) {
  if (variant === 'small') {
    return (
      <AbsoluteFill style={{ background: BG, fontFamily: FONT, padding: '0 40px', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: AMBER }} />
        <Brand scale={0.92} />
      </AbsoluteFill>
    );
  }
  // Marquee: the brand on the left, the Chinese Notara page on the right, half revealed by the amber edge.
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: FONT }}>
      <div style={{ position: 'absolute', left: 96, top: 0, bottom: 0, display: 'flex', alignItems: 'center' }}>
        <Brand scale={1.3} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: 660,
          top: 70,
          width: 860,
          height: 445,
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 0 0 1px rgba(255,255,255,.08), 0 30px 70px rgba(0,0,0,.55)',
        }}
      >
        <Img src={staticFile('languages/000-page.png')} style={{ position: 'absolute', inset: 0, width: 860, height: 445 }} />
        <div style={{ position: 'absolute', inset: 0, clipPath: 'inset(0 52% 0 0)' }}>
          <Img src={staticFile('languages/001-page.png')} style={{ position: 'absolute', inset: 0, width: 860, height: 445 }} />
        </div>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 860 * 0.48 - 90, width: 90, background: 'linear-gradient(90deg, rgba(242,179,61,0), rgba(242,179,61,.24))' }} />
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 860 * 0.48 - 1.5, width: 3, background: AMBER, boxShadow: '0 0 16px 3px rgba(242,179,61,.55)' }} />
      </div>
    </AbsoluteFill>
  );
}
