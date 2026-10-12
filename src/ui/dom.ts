type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

/** Minimal hyperscript: h('div', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function select(options: [string, string][], value: string, attrs: Attrs = {}): HTMLSelectElement {
  const s = h('select', attrs, ...options.map(([v, label]) => h('option', { value: v }, label)));
  s.value = value;
  return s;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', {}, hint) : null);
}

export function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
