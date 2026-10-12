// A compact, Chrome-like window: traffic lights, navigation, the address bar and the toolbar icons.
import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import icon from '../../../../public/icon/48.png';
import { ICON, WIN } from './timeline';

const ink = '#1f2329';
const soft = '#8a909b';

const Stroke = ({ d, size = 18, style }: { d: string; size?: number; style?: CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={soft} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d={d} />
  </svg>
);

function Address({ url }: { url: string }) {
  const ext = /^chrome-extension:\/\/[^/]+\/(.*)$/.exec(url);
  if (ext) {
    return (
      <>
        <Img src={icon} style={{ width: 16, height: 16, marginRight: 8 }} />
        <span style={{ color: ink, fontWeight: 600 }}>Translucid</span>
        <span style={{ color: '#c4c8cf', margin: '0 9px' }}>|</span>
        <span style={{ color: soft }}>chrome-extension://…/</span>
        <span style={{ color: '#4b515c' }}>{ext[1]}</span>
      </>
    );
  }
  const [host, ...path] = url.split('/');
  return (
    <>
      <Stroke size={15} d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6" style={{ marginRight: 9 }} />
      <span style={{ color: ink }}>{host}</span>
      <span style={{ color: soft }}>{path.length ? `/${path.join('/')}` : ''}</span>
    </>
  );
}

export function Window({ url, active, children }: { url: string; active: number; children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: WIN.x,
        top: WIN.y,
        width: WIN.w,
        borderRadius: WIN.r,
        overflow: 'hidden',
        background: '#fff',
        boxShadow: '0 0 0 1px rgba(255,255,255,.07), 0 28px 70px rgba(0,0,0,.55)',
      }}
    >
      <div style={{ height: WIN.bar, background: '#eef0f3', borderBottom: '1px solid #dcdfe5', display: 'flex', alignItems: 'center', position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8, marginLeft: 18 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, boxShadow: 'inset 0 0 0 .5px rgba(0,0,0,.12)' }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, marginLeft: 26 }}>
          <Stroke d="M15 18l-6-6 6-6" />
          <Stroke d="M9 18l6-6-6-6" style={{ opacity: 0.5 }} />
          <Stroke d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
        </div>
        <div
          style={{
            position: 'absolute',
            left: 196,
            right: 150,
            height: 30,
            borderRadius: 15,
            background: '#fff',
            boxShadow: 'inset 0 0 0 1px #e1e4e9',
            display: 'flex',
            alignItems: 'center',
            padding: '0 14px',
            fontSize: 14,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <Address url={url} />
        </div>
        {/* Toolbar: Translucid, the extensions menu and the profile. */}
        <div
          style={{
            position: 'absolute',
            left: ICON.x - WIN.x - 15,
            top: ICON.y - WIN.y - 15,
            width: 30,
            height: 30,
            borderRadius: 15,
            background: `rgba(31,35,41,${0.09 * active})`,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Img src={icon} style={{ width: 18, height: 18 }} />
        </div>
        <Stroke
          d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z"
          style={{ position: 'absolute', left: ICON.x - WIN.x + 26, top: ICON.y - WIN.y - 9 }}
        />
        <span style={{ position: 'absolute', left: ICON.x - WIN.x + 60, top: ICON.y - WIN.y - 11, width: 22, height: 22, borderRadius: 11, background: '#c7d2fe', color: '#3730a3', fontSize: 11, fontWeight: 700, display: 'grid', placeItems: 'center' }}>
          M
        </span>
      </div>
      {children}
    </div>
  );
}
