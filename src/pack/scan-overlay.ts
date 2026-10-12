// Shown while an exploration scan runs. It keeps the user's mouse and keyboard
// away from the page (a stray click could change a setting mid-scan), says what
// is happening, and offers Stop (also Esc). Programmatic events from the
// explorer are untrusted and pass through; all trusted input is swallowed. Lives in a shadow root under <translucid-scan>.

// The 透层 tokens (src/ui/ui.css), inlined for the closed shadow root; same panel as the region picker.
const STYLE = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC","Segoe UI","Microsoft YaHei",sans-serif}
.shield{position:fixed;inset:0;z-index:2147483646;background:rgba(20,22,27,.06);cursor:progress}
.panel{position:fixed;right:16px;bottom:16px;width:340px;display:flex;flex-direction:column;gap:12px;background:#fff;color:#14161B;
  border:1px solid #E2E4E9;border-radius:16px;box-shadow:0 16px 40px rgba(20,22,27,.18);padding:16px;z-index:2147483647;font-size:13px;line-height:1.5}
.head{display:flex;align-items:center;gap:10px}
.head svg{flex:none;display:block}
h3{margin:0;flex:1;font-size:15px;font-weight:600}
.live{width:8px;height:8px;border-radius:50%;background:#2F56D6;animation:pulse 1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
p{margin:0;color:#5B616E;font-size:12px;line-height:1.6}
.step{padding:8px 10px;border-radius:8px;background:#F4F5F7;font-size:12px;color:#3D424B;min-height:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;background:#F7F8FA;border:1px solid #E2E4E9}
.stat b{font-size:18px;font-weight:600;line-height:1.2}
.stat span{font-size:11px;color:#5B616E}
.row{display:flex;align-items:center;gap:8px}
.hint{margin-right:auto;color:#5B616E;font-size:12px}
kbd{font:11px/1 ui-monospace,"SF Mono",Menlo,monospace;border:1px solid #D5D8DE;border-bottom-width:2px;border-radius:4px;padding:2px 5px;background:#fff;color:#3D424B}
button{height:38px;padding:0 16px;border:1px solid #D5D8DE;border-radius:10px;background:#fff;color:#14161B;font-size:14px;font-weight:500;cursor:pointer}
button:hover{border-color:#5B616E}
button:focus-visible{outline:2px solid #2F56D6;outline-offset:1px}
@media (prefers-color-scheme: dark){
  .panel{background:#1C1E23;color:#ECEEF2;border-color:#2C2F36;box-shadow:0 16px 40px rgba(0,0,0,.5)}
  .live{background:#7D9BF5}
  p,.hint,.stat span{color:#9AA1AC}
  .step{background:#262930;color:#C5C9D1}
  .stat{background:#17191D;border-color:#2C2F36}
  kbd{background:#1C1E23;border-color:#3A3E46;color:#C5C9D1}
  button{background:#1C1E23;border-color:#3A3E46;color:#ECEEF2}
}`;

const SVG_NS = 'http://www.w3.org/2000/svg';

const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'wheel', 'pointermove', 'mousemove', 'touchmove', 'pointercancel', 'touchcancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'];

export class ScanOverlay {
  private host: HTMLElement | undefined;
  private stopButton: HTMLButtonElement | undefined;
  private root: ShadowRoot | undefined;
  private stepEl: HTMLElement | undefined;
  private counts: { visited: HTMLElement; strings: HTMLElement; actions: HTMLElement } | undefined;
  private guard = (e: Event) => {
    if (!e.isTrusted || !this.host) return;
    const key = (e as KeyboardEvent).key;
    const button = this.stopButton;
    const rect = button?.getBoundingClientRect();
    const mouse = e as MouseEvent;
    const hit = rect && rect.width > 0 && rect.height > 0 && mouse.clientX >= rect.left && mouse.clientX <= rect.right && mouse.clientY >= rect.top && mouse.clientY <= rect.bottom;
    const focused = button && this.root?.activeElement === button;
    e.preventDefault();
    e.stopImmediatePropagation();
    if ((e.type === 'keydown' && key === 'Escape') || (e.type === 'click' && hit) || (e.type === 'keydown' && focused && (key === 'Enter' || key === ' '))) this.onStop();
    // Pointer defaults are blocked too; explicitly focus our only control.
    else if (e.type === 'pointerdown' && hit) button?.focus();
  };

  constructor(
    private doc: Document,
    private onStop: () => void,
  ) {}

  open(): void {
    if (this.host) return;
    const d = this.doc;
    const host = (this.host = d.createElement('translucid-scan'));
    const root = (this.root = host.attachShadow({ mode: 'closed' }));
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]) => {
      const e = d.createElement(tag);
      if (cls) e.className = cls;
      e.append(...kids);
      return e;
    };
    const style = el('style', '', STYLE);
    const shield = el('div', 'shield');
    // The app mark: cobalt interface layer under the amber language layer.
    const logo = d.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ width: '22', height: '22', viewBox: '0 0 128 128', 'aria-hidden': 'true' })) logo.setAttribute(k, v);
    for (const [tag, attrs] of [
      ['rect', { x: '6', y: '6', width: '84', height: '84', rx: '22', fill: '#2F56D6' }],
      ['rect', { x: '38', y: '38', width: '84', height: '84', rx: '22', fill: '#F2B33D' }],
      ['path', { d: 'M60 38H90V68A22 22 0 0 1 68 90H38V60A22 22 0 0 1 60 38Z', fill: '#C79F5F' }],
    ] as const) {
      const c = d.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
      logo.append(c);
    }
    const stat = (label: string) => {
      const b = el('b', '', '0');
      return { box: el('div', 'stat', b, el('span', '', label)), b };
    };
    const visited = stat('已打开');
    const strings = stat('界面文字');
    const actions = stat('操作');
    this.counts = { visited: visited.b, strings: strings.b, actions: actions.b };
    this.stepEl = el('div', 'step', '准备中…');
    const stop = (this.stopButton = el('button', '', '停止并恢复'));
    stop.type = 'button';
    stop.addEventListener('click', () => this.onStop());
    const panel = el(
      'div',
      'panel',
      el('div', 'head', logo, el('h3', '', '正在扫描界面'), el('span', 'live')),
      el('p', '', '只打开导航和菜单，不更改任何设置；结束后恢复原状。扫描期间请不要操作页面。'),
      this.stepEl,
      el('div', 'stats', visited.box, strings.box, actions.box),
      el('div', 'row', el('span', 'hint', '按 ', el('kbd', '', 'Esc'), ' 也可停止'), stop),
    );
    panel.setAttribute('role', 'status');
    root.append(style, shield, panel);
    (d.body ?? d.documentElement).appendChild(host);
    const view = d.defaultView!;
    for (const t of BLOCKED) view.addEventListener(t, this.guard, { capture: true, passive: false });
  }

  update(step: string, actions: number, visited: number, strings: number): void {
    if (this.stepEl) this.stepEl.textContent = step;
    if (this.counts) {
      this.counts.visited.textContent = String(visited);
      this.counts.strings.textContent = String(strings);
      this.counts.actions.textContent = String(actions);
    }
  }

  close(): void {
    const view = this.doc.defaultView;
    if (view) for (const t of BLOCKED) view.removeEventListener(t, this.guard, true);
    this.host?.remove();
    this.host = undefined;
    this.stopButton = undefined;
    this.root = undefined;
  }
}
