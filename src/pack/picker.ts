// In-page region picker. The user marks which parts of an app are UI chrome
// (sidebar, toolbar, settings) and which areas inside them are content to
// exclude. Only marked regions are ever read by the harvester. Lives in a
// shadow root under <translucid-picker> so page styles cannot leak in and our
// walkers skip it.
import type { PackRegion } from './format';
import { buildSelector, regionLabel } from './selector';

export type PickMode = 'pick' | 'exclude' | 'paused';

export interface PickerState {
  regions: PackRegion[];
  excludes: string[];
}

export interface PickerCallbacks {
  onChange: (state: PickerState) => void;
  onDone: (state: PickerState) => void;
  onCancel: () => void;
  /** Candidates found so far (shown as a counter). */
  count?: () => number;
  /** The pick-regions shortcut as the browser has it ('' when the user removed it). */
  shortcut?: string;
}

const OVERLAY_ID = 'overlays';

// The 透层 tokens (src/ui/ui.css), inlined: page styles never reach this shadow root and ours never leak out.
// Cobalt marks what is collected, orange-red (#C2410C) what is excluded: apart in lightness from the amber language layer.
const STYLE = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC","Segoe UI","Microsoft YaHei",sans-serif}
.hl{position:fixed;pointer-events:none;border:2px solid #2F56D6;background:rgba(47,86,214,.08);border-radius:6px;z-index:2147483646;display:none}
.hl.ex{border-color:#C2410C;background:rgba(194,65,12,.08)}
.tag{position:absolute;left:-2px;top:-27px;background:#2F56D6;color:#fff;font-size:12px;font-weight:500;line-height:18px;padding:2px 8px;border-radius:6px;white-space:nowrap}
.hl.ex .tag{background:#C2410C}
.mark{position:fixed;pointer-events:none;border:2px dashed #2F56D6;border-radius:6px;z-index:2147483645}
.mark.ex{border-color:#C2410C;background:rgba(194,65,12,.06)}
.panel{position:fixed;top:16px;right:16px;width:340px;max-height:calc(100vh - 32px);overflow:auto;display:flex;flex-direction:column;gap:12px;
  background:#fff;color:#14161B;border:1px solid #E2E4E9;border-radius:16px;box-shadow:0 16px 40px rgba(20,22,27,.18);padding:16px;
  z-index:2147483647;font-size:13px;line-height:1.5;transition:top .18s ease,left .18s ease,right .18s ease,bottom .18s ease}
.panel.at-bl{top:auto;right:auto;bottom:16px;left:16px}
.panel.at-br{top:auto;bottom:16px}
.panel.at-tl{right:auto;left:16px}
.head{display:flex;align-items:center;gap:10px}
.head svg{flex:none;display:block}
h3{margin:0;flex:1;font-size:15px;font-weight:600}
.count{font-size:12px;color:#5B616E;white-space:nowrap}
p{margin:0;color:#5B616E;font-size:12px;line-height:1.6}
.modes{display:flex;gap:2px;padding:3px;border-radius:10px;background:#E9EBEF}
.modes button{flex:1;height:36px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;background:transparent;color:#3D424B;font-size:13px;font-weight:500;cursor:pointer}
.modes button.on{background:#2F56D6;color:#fff;font-weight:600}
.modes button.on.ex{background:#C2410C}
.modes button.on.pause{background:#fff;color:#14161B;box-shadow:0 1px 2px rgba(20,22,27,.12)}
label.chk{display:flex;gap:8px;align-items:center;font-size:13px;color:#3D424B;cursor:pointer}
label.chk input{margin:0;width:16px;height:16px;accent-color:#2F56D6}
ul{list-style:none;margin:0;padding:0;max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:6px}
li{display:flex;align-items:center;gap:10px;min-height:40px;padding:4px 4px 4px 12px;border-radius:8px;background:#F4F5F7;font-size:13px}
li.ex{background:#FDF0EA}
li .sw{flex:none;width:10px;height:10px;border-radius:3px;border:2px dashed #2F56D6}
li.ex .sw{border-color:#C2410C}
li .lbl{flex:1;min-width:0;display:flex;flex-direction:column}
li code{font:11px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:#5B616E;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li button{flex:none;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:#5B616E;cursor:pointer}
li button:hover{background:rgba(20,22,27,.06);color:#14161B}
.empty{padding:10px 12px;border:1px dashed #D5D8DE;border-radius:8px;color:#5B616E;font-size:12px;text-align:center}
.toast{padding:8px 10px;border-radius:8px;background:#FFF4DC;color:#8A5A00;font-size:12px}
.row{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.row button{height:38px;padding:0 16px;border:1px solid #D5D8DE;border-radius:10px;background:#fff;color:#14161B;font-size:14px;font-weight:500;cursor:pointer}
.row button:hover{border-color:#5B616E}
.row button.primary{background:#2F56D6;border-color:#2F56D6;color:#fff}
.row button.primary:hover{background:#1E3DA8;border-color:#1E3DA8}
button:focus-visible,input:focus-visible{outline:2px solid #2F56D6;outline-offset:1px}
kbd{font:11px/1 ui-monospace,"SF Mono",Menlo,monospace;border:1px solid #D5D8DE;border-bottom-width:2px;border-radius:4px;padding:2px 5px;background:#fff;color:#3D424B}
.modes kbd{border-color:currentColor;background:transparent;color:inherit;opacity:.75}
@media (prefers-color-scheme: dark){
  .panel{background:#1C1E23;color:#ECEEF2;border-color:#2C2F36;box-shadow:0 16px 40px rgba(0,0,0,.5)}
  p,.count,li code,li button,.empty{color:#9AA1AC}
  label.chk{color:#C5C9D1}
  .modes{background:#262930}
  .modes button{color:#C5C9D1}
  .modes button.on{background:#7D9BF5;color:#0D0F14}
  .modes button.on.ex{background:#F0956A;color:#0D0F14}
  .modes button.on.pause{background:#3A3E46;color:#ECEEF2}
  li{background:#262930}
  li.ex{background:#3D2419}
  li .sw{border-color:#7D9BF5}
  li.ex .sw{border-color:#F0956A}
  li button:hover{background:rgba(255,255,255,.08);color:#ECEEF2}
  .empty{border-color:#3A3E46}
  .toast{background:#3A2D14;color:#F0BF6A}
  .row button{background:#1C1E23;border-color:#3A3E46;color:#ECEEF2}
  .row button.primary{background:#7D9BF5;border-color:#7D9BF5;color:#0D0F14}
  kbd{background:#1C1E23;border-color:#3A3E46;color:#C5C9D1}
}`;

const SVG_NS = 'http://www.w3.org/2000/svg';

const POINTER_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'touchstart', 'touchend'] as const;
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

export class RegionPicker {
  private actions = new WeakMap<Element, (e: Event) => void>();
  private swallowedKeys = new Set<string>();
  private host: HTMLElement;
  private root: ShadowRoot;
  private hl: HTMLDivElement;
  private marks: HTMLDivElement;
  private mode: PickMode = 'pick';
  private state: PickerState;
  private initial: PickerState;
  private target: Element | null = null;
  /** How many levels above the hovered element the selection is (↑ / ↓ keys). */
  private depth = 0;
  private toast = '';
  private seq = 0;
  private countTimer: ReturnType<typeof setInterval> | undefined;
  /** Panel corner: it moves away from the pointer so it never covers what you want to click. */
  private corner: 'tr' | 'bl' | 'br' | 'tl' = 'tr';

  constructor(
    private doc: Document,
    init: PickerState,
    private cb: PickerCallbacks,
  ) {
    this.state = { regions: [...init.regions], excludes: [...init.excludes] };
    this.initial = { regions: init.regions.map((r) => ({ ...r })), excludes: [...init.excludes] };
    this.host = doc.createElement('translucid-picker');
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    this.hl = doc.createElement('div');
    this.hl.className = 'hl';
    this.marks = doc.createElement('div');
    this.root.append(style, this.marks, this.hl, doc.createElement('div'));
  }

  /**
   * Listeners sit on window in the capture phase: they run before any page listener, so a page
   * menu that is open stays open (its "click outside" handler never sees our clicks).
   */
  open(): void {
    const view = this.doc.defaultView!;
    this.doc.documentElement.appendChild(this.host);
    for (const t of POINTER_EVENTS) view.addEventListener(t, this.onPointer, true);
    view.addEventListener('mousemove', this.onPointer, true);
    view.addEventListener('mousemove', this.avoid, true);
    for (const t of KEY_EVENTS) view.addEventListener(t, this.onKey, true);
    view.addEventListener('scroll', this.repaint, true);
    this.countTimer = setInterval(() => this.renderCount(), 1000);
    this.render();
  }

  close(): void {
    const view = this.doc.defaultView;
    if (view) {
      for (const t of POINTER_EVENTS) view.removeEventListener(t, this.onPointer, true);
      view.removeEventListener('mousemove', this.onPointer, true);
      view.removeEventListener('mousemove', this.avoid, true);
      for (const t of KEY_EVENTS) view.removeEventListener(t, this.onKey, true);
      view.removeEventListener('scroll', this.repaint, true);
    }
    clearInterval(this.countTimer);
    this.host.remove();
  }

  private ours(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  private pointer = { x: -1, y: -1 };

  private avoid = (e: Event) => {
    if (this.ours(e)) return;
    const m = e as MouseEvent;
    this.pointer = { x: m.clientX, y: m.clientY };
  };

  /**
   * Keep the panel off what is being picked: when the highlighted element (or the pointer over the
   * page) would be under it, the panel moves to the first corner that leaves both free. Pointing at
   * the panel itself never moves it, so its buttons stay reachable.
   */
  private keepClear(target: DOMRect): void {
    const panel = this.root.querySelector<HTMLElement>('.panel');
    if (!panel) return;
    const view = this.doc.defaultView!;
    const pr = panel.getBoundingClientRect();
    const w = pr.width;
    const h = pr.height;
    const gap = 16;
    const rectAt = (c: typeof this.corner) => {
      const left = c === 'tl' || c === 'bl' ? gap : view.innerWidth - gap - w;
      const top = c === 'tl' || c === 'tr' ? gap : view.innerHeight - gap - h;
      return { left, top, right: left + w, bottom: top + h };
    };
    const hits = (r: { left: number; top: number; right: number; bottom: number }) => {
      const overTarget = r.left < target.right + 8 && r.right > target.left - 8 && r.top < target.bottom + 8 && r.bottom > target.top - 8;
      const p = this.pointer;
      const overPointer = p.x >= r.left - 24 && p.x <= r.right + 24 && p.y >= r.top - 24 && p.y <= r.bottom + 24;
      return overTarget || overPointer;
    };
    if (!hits(rectAt(this.corner))) return;
    const free = (['tr', 'bl', 'br', 'tl'] as const).find((c) => c !== this.corner && !hits(rectAt(c)));
    if (!free) return; // the target fills the screen: stay put
    this.corner = free;
    panel.className = `panel at-${free}`;
  }

  private onPointer = (e: Event) => {
    if (this.ours(e)) {
      // Run the action directly: dispatching a replay would expose it to page capture listeners.
      if (!e.isTrusted || e.type === 'mousemove') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.type === 'click') {
        this.panelAction(e);
      }
      return;
    }
    if (this.mode === 'paused') return;
    const el = e.target instanceof Element ? e.target : null;
    if (e.type === 'mousemove') {
      if (el !== this.target) this.depth = 0;
      this.target = el;
      this.paintHighlight();
      return;
    }
    // Swallow the whole click sequence so the app does not react while picking.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click' && el) this.pick(this.lifted(el));
  };

  private panelAction(e: Event): void {
    for (const node of e.composedPath()) {
      if (!(node instanceof Element)) continue;
      const action = this.actions.get(node);
      if (action) { action(e); return; }
    }
  }

  private onKey = (e: KeyboardEvent) => {
    const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const control = this.ours(e) && (e.key === 'Enter' || e.key === ' ');
    const blocked = e.key === 'Escape' || (arrow && this.mode !== 'paused' && !!this.target) || control || this.swallowedKeys.has(e.key);
    if (!blocked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown') this.swallowedKeys.add(e.key);
    if (e.type === 'keyup') this.swallowedKeys.delete(e.key);
    if (control) {
      if (!e.repeat && ((e.key === 'Enter' && e.type === 'keydown') || (e.key === ' ' && e.type === 'keyup'))) this.panelAction(e);
      return;
    }
    if (e.type !== 'keydown' || e.repeat) return;
    if (e.key === 'Escape') this.setMode(this.mode === 'paused' ? 'pick' : 'paused');
    else if (arrow && this.mode !== 'paused' && this.target) {
      this.depth = Math.max(0, this.depth + (e.key === 'ArrowUp' ? 1 : -1));
      this.paintHighlight();
    }
  };

  /** The hovered element raised by `depth` levels (never body/html). */
  private lifted(el: Element): Element {
    let cur = el;
    for (let i = 0; i < this.depth; i++) {
      const up = cur.parentElement;
      if (!up || up === this.doc.body || up === this.doc.documentElement) {
        this.depth = i;
        break;
      }
      cur = up;
    }
    return cur;
  }

  private repaint = () => {
    this.paintHighlight();
    this.paintMarks();
  };

  /** Nearest element (itself or an ancestor) that has a stable selector. */
  private selectable(el: Element): { el: Element; sel: string } | undefined {
    for (let a: Element | null = el; a && a !== this.doc.body && a !== this.doc.documentElement; a = a.parentElement) {
      const sel = buildSelector(a);
      if (sel) return { el: a, sel };
    }
    return undefined;
  }

  private pick(el: Element): void {
    const found = this.selectable(el);
    if (!found) {
      this.toast = '这里没有稳定的选择器，请点选更外层的区域';
      this.render();
      return;
    }
    this.toast = found.el !== el ? '已自动改选外层区域（内层元素没有稳定的选择器）' : '';
    if (this.mode === 'exclude') {
      if (!this.state.excludes.includes(found.sel)) this.state.excludes.push(found.sel);
    } else if (!this.state.regions.some((r) => r.selector === found.sel)) {
      this.state.regions.push({ id: `r${Date.now().toString(36)}${this.seq++}`, label: regionLabel(found.el), selector: found.sel });
    }
    this.cb.onChange(this.snapshot());
    this.render();
  }

  private snapshot(): PickerState {
    return { regions: this.state.regions.map((r) => ({ ...r })), excludes: [...this.state.excludes] };
  }

  private setMode(m: PickMode): void {
    this.mode = m;
    if (m === 'paused') this.hl.style.display = 'none';
    this.render();
  }

  private paintHighlight(): void {
    const found = this.target && this.mode !== 'paused' ? this.selectable(this.lifted(this.target)) : undefined;
    if (!found) {
      this.hl.style.display = 'none';
      return;
    }
    const r = found.el.getBoundingClientRect();
    Object.assign(this.hl.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    // A big region (a whole sidebar) only needs the pointer kept clear; a small one should be fully visible.
    const view = this.doc.defaultView!;
    const huge = r.width * r.height > view.innerWidth * view.innerHeight * 0.5;
    this.keepClear(huge ? new DOMRect(this.pointer.x, this.pointer.y, 1, 1) : r);
    this.hl.className = this.mode === 'exclude' ? 'hl ex' : 'hl';
    this.hl.replaceChildren(Object.assign(this.doc.createElement('span'), {
      className: 'tag',
      textContent: `${this.mode === 'exclude' ? '排除：' : ''}${regionLabel(found.el)} · ↑ 外层 ↓ 内层`,
    }));
  }

  private paintMarks(): void {
    const boxes: HTMLDivElement[] = [];
    const mark = (sel: string, ex: boolean) => {
      let els: Element[] = [];
      try {
        els = [...this.doc.querySelectorAll(sel)].slice(0, 20);
      } catch {
        /* ignore */
      }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const d = this.doc.createElement('div');
        d.className = ex ? 'mark ex' : 'mark';
        Object.assign(d.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        boxes.push(d);
      }
    };
    for (const r of this.state.regions) if (r.selector) mark(r.selector, false);
    for (const s of this.state.excludes) mark(s, true);
    this.marks.replaceChildren(...boxes);
  }

  private renderCount(): void {
    const el = this.root.querySelector('.count');
    if (el && this.cb.count) el.textContent = `已收集 ${this.cb.count()} 条`;
  }

  private render(): void {
    const d = this.doc;
    const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]) => {
      const el = d.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('on')) {
          el.addEventListener(k.slice(2), v as EventListener);
          if (k === 'onclick') this.actions.set(el, v as (e: Event) => void);
          if (k === 'onchange') this.actions.set(el, () => {
            if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !el.checked;
            (v as (e: Event) => void)({ target: el } as unknown as Event);
          });
        }
        else if (k === 'className') el.className = String(v);
        else if (v !== false && v !== undefined) el.setAttribute(k, String(v));
      }
      el.append(...kids);
      return el;
    };
    const svg = (w: number, view: string, ...shapes: [string, Record<string, string>][]) => {
      const el = d.createElementNS(SVG_NS, 'svg');
      for (const [k, v] of Object.entries({ width: String(w), height: String(w), viewBox: view, 'aria-hidden': 'true' })) el.setAttribute(k, v);
      for (const [tag, attrs] of shapes) {
        const c = d.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
        el.append(c);
      }
      return el;
    };
    // The app mark: cobalt interface layer under the amber language layer.
    const logo = () =>
      svg(22, '0 0 128 128',
        ['rect', { x: '6', y: '6', width: '84', height: '84', rx: '22', fill: '#2F56D6' }],
        ['rect', { x: '38', y: '38', width: '84', height: '84', rx: '22', fill: '#F2B33D' }],
        ['path', { d: 'M60 38H90V68A22 22 0 0 1 68 90H38V60A22 22 0 0 1 60 38Z', fill: '#C79F5F' }]);
    const closeIcon = () =>
      svg(16, '0 0 24 24', ['path', { d: 'M6 6l12 12M18 6L6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }]);
    const modeBtn = (m: PickMode, text: string, ...extra: Node[]) =>
      h('button', {
        type: 'button',
        className: [this.mode === m ? 'on' : '', m === 'exclude' ? 'ex' : '', m === 'paused' ? 'pause' : ''].filter(Boolean).join(' '),
        'aria-pressed': String(this.mode === m),
        onclick: () => this.setMode(m),
      }, text, ...extra);
    const overlays = this.state.regions.some((r) => r.builtin === 'overlays');
    const removeBtn = (label: string, drop: () => void) =>
      h('button', { type: 'button', title: '移除', 'aria-label': `移除 ${label}`, onclick: () => { drop(); this.cb.onChange(this.snapshot()); this.render(); } }, closeIcon());
    const items = [
      ...this.state.regions.map((r, i) => {
        const label = r.builtin ? '弹出菜单 / 对话框 / 提示' : r.label;
        return h('li', {}, h('span', { className: 'sw' }), h('span', { className: 'lbl' }, h('span', {}, label), r.selector ? h('code', {}, r.selector) : ''),
          removeBtn(label, () => this.state.regions.splice(i, 1)));
      }),
      ...this.state.excludes.map((sel, i) =>
        h('li', { className: 'ex' }, h('span', { className: 'sw' }), h('span', { className: 'lbl' }, h('span', {}, '排除内容'), h('code', {}, sel)),
          removeBtn(sel, () => this.state.excludes.splice(i, 1))),
      ),
    ];
    const key = this.cb.shortcut;
    const panel = h(
      'div',
      { className: `panel at-${this.corner}`, role: 'dialog', 'aria-label': '圈选界面区域' },
      h('div', { className: 'head' }, logo(), h('h3', {}, '圈选界面区域'), h('span', { className: 'count' }, '')),
      h('div', { className: 'modes', role: 'group', 'aria-label': '模式' },
        modeBtn('pick', '圈选区域'), modeBtn('exclude', '排除内容'), modeBtn('paused', '暂停', h('kbd', {}, 'Esc'))),
      h('p', {}, '点选要收集的界面区域，↑ ↓ 扩大或缩小范围；会话、消息这类你自己的内容用「排除内容」标出。'),
      h('label', { className: 'chk', onclick: () => {
        const input = this.root.querySelector<HTMLInputElement>('.chk input');
        if (input) this.actions.get(input)?.({ target: input } as unknown as Event);
      } },
        h('input', {
          type: 'checkbox', checked: overlays || undefined,
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            this.state.regions = this.state.regions.filter((r) => r.builtin !== 'overlays');
            if (on) this.state.regions.push({ id: OVERLAY_ID, label: '弹出菜单 / 对话框 / 提示', builtin: 'overlays' });
            this.cb.onChange(this.snapshot());
            this.render();
          },
        }),
        '包含弹出菜单、对话框和提示'),
      this.toast ? h('div', { className: 'toast', role: 'status' }, this.toast) : '',
      items.length ? h('ul', {}, ...items) : h('div', { className: 'empty' }, '还没有圈选区域'),
      h('p', {}, '面板会自己让开要圈选的地方。要圈网页菜单：按 ', h('kbd', {}, 'Esc'), ' 暂停，点开菜单，再按 ', h('kbd', {}, 'Esc'), ' 继续',
        ...(key ? ['；或先打开菜单，再按 ', h('kbd', {}, key), ' 直接开始圈选。'] : ['。'])),
      h('div', { className: 'row' },
        h('button', { type: 'button', title: '撤销本次圈选的改动', onclick: () => { this.close(); this.cb.onChange(this.initial); this.cb.onCancel(); } }, '取消'),
        h('button', { type: 'button', className: 'primary', onclick: () => { this.close(); this.cb.onDone(this.snapshot()); } }, '完成')),
    );
    this.root.lastChild!.replaceWith(panel);
    this.paintMarks();
    this.renderCount();
  }
}
