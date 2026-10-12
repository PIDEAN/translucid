// A small scripted settings app for explorer tests: only the active section is
// rendered, popups mount on demand and close on Escape (topmost first), one
// trigger opens on pointerdown only (Radix-style). All names are invented.

const SECTIONS: Record<string, string> = {
  General: `
    <div role="group" aria-labelledby="g1"><span id="g1">Chat font</span>
      <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" data-popup="fonts">Serif</button></div>
    <div role="radiogroup" aria-label="Theme"><span role="radio" aria-checked="true">System</span><span role="radio" aria-checked="false">Dark</span></div>`,
  Account: `
    <div role="group" aria-labelledby="a1"><span id="a1">What best describes your work?</span>
      <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false" data-popup="work">Engineering</button></div>
    <div role="group" aria-labelledby="a2"><span id="a2">Language</span>
      <button type="button" aria-haspopup="menu" aria-expanded="false" data-state="closed" data-pointer="1" data-popup="lang">English</button></div>`,
  Privacy: `
    <div role="group" aria-labelledby="p1"><span id="p1">Location metadata</span><span role="switch" aria-checked="true" aria-label="Location metadata" id="sw"></span></div>
    <button type="button" aria-haspopup="dialog" aria-expanded="false" data-popup="danger">Delete account</button>`,
  Billing: `
    <div role="tablist"><button role="tab" aria-selected="true" data-tab="Plan">Plan</button><button role="tab" aria-selected="false" data-tab="Invoices">Invoices</button><button role="tab" aria-selected="false" data-tab="Payment">Payment</button></div>
    <div id="tabpanel">Your plan details</div>`,
};

const POPUPS: Record<string, string> = {
  fonts: '<div role="listbox"><div role="option">Serif</div><div role="option">Sans</div><div role="option">Dyslexic friendly</div></div>',
  work: '<div role="listbox"><div role="option">Engineering</div><div role="option">Design</div><div role="option">Product management</div></div>',
  lang: '<div role="menu"><div role="menuitem">English</div><div role="menuitem">Deutsch</div></div>',
  danger: '<div role="dialog" aria-label="Confirm"><button type="button">Delete forever</button></div>',
};

const TAB_TEXT: Record<string, string> = { Plan: 'Your plan details', Invoices: 'Past invoices appear here', Payment: 'Payment method on file' };

export interface ExploreApp {
  section: () => string;
  openPopups: () => number;
  /** Make a trigger misbehave: clicking it also flips the Privacy switch… if it is rendered. */
  sabotage: (popup: string, effect: () => void) => void;
  destroy: () => void;
}

export function mountExploreApp(doc: Document, opts: { escapeClosesDialog?: boolean; noToggle?: boolean; keepBody?: boolean } = {}): ExploreApp {
  const markup = `
    <div role="dialog" aria-label="Settings" id="settings">
      <nav><ul>${Object.keys(SECTIONS)
        .map((s, i) => `<li><button type="button"${i === 0 ? ' aria-current="page"' : ''} data-nav="${s}">${s}</button></li>`)
        .join('')}</ul></nav>
      <div id="content">${SECTIONS.General}</div>
    </div>`;
  if (opts.keepBody) doc.body.insertAdjacentHTML('beforeend', markup);
  else doc.body.innerHTML = markup;
  let current = 'General';
  const stack: { el: Element; trigger: Element }[] = [];
  const sabotage = new Map<string, () => void>();

  const openPopup = (trigger: Element) => {
    const name = trigger.getAttribute('data-popup')!;
    const wrap = doc.createElement('div');
    wrap.innerHTML = POPUPS[name]!;
    const el = wrap.firstElementChild!;
    doc.body.appendChild(el);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('data-state', 'open');
    stack.push({ el, trigger });
    sabotage.get(name)?.();
  };

  const onClick = (e: Event) => {
    const t = e.target as Element;
    const nav = t.closest('[data-nav]');
    if (nav) {
      current = nav.getAttribute('data-nav')!;
      for (const b of doc.querySelectorAll('[data-nav]')) b.removeAttribute('aria-current');
      nav.setAttribute('aria-current', 'page');
      doc.getElementById('content')!.innerHTML = SECTIONS[current]!;
      return;
    }
    const tab = t.closest('[data-tab]');
    if (tab) {
      for (const b of doc.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b === tab));
      doc.getElementById('tabpanel')!.textContent = TAB_TEXT[tab.getAttribute('data-tab')!]!;
      return;
    }
    const trig = t.closest('[data-popup]');
    if (trig && !trig.hasAttribute('data-pointer')) toggle(trig);
  };
  const onPointer = (e: Event) => {
    const trig = (e.target as Element).closest('[data-pointer]');
    if (trig) toggle(trig);
  };
  // Disclosure triggers toggle, like real ones.
  const toggle = (trig: Element) => {
    if (trig.getAttribute('aria-expanded') !== 'true') return openPopup(trig);
    if (opts.noToggle) return;
    const i = stack.findIndex((s) => s.trigger === trig);
    if (i >= 0) closeAt(i);
  };
  const closeAt = (i: number) => {
    const [top] = stack.splice(i, 1);
    top!.el.remove();
    top!.trigger.setAttribute('aria-expanded', 'false');
    top!.trigger.setAttribute('data-state', 'closed');
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !stack.length) return;
    closeAt(stack.length - 1);
    if (opts.escapeClosesDialog) doc.getElementById('settings')?.remove();
  };
  doc.addEventListener('click', onClick);
  doc.addEventListener('pointerdown', onPointer);
  doc.addEventListener('keydown', onKey);
  return {
    section: () => current,
    openPopups: () => stack.length,
    sabotage: (popup, effect) => sabotage.set(popup, effect),
    destroy: () => {
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('pointerdown', onPointer);
      doc.removeEventListener('keydown', onKey);
      doc.body.innerHTML = '';
    },
  };
}
