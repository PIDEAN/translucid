import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegionPicker } from '../src/pack/picker';
import { ScanOverlay } from '../src/pack/scan-overlay';

let picker: RegionPicker | undefined;
let overlay: ScanOverlay | undefined;
afterEach(() => { picker?.close(); overlay?.close(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

// happy-dom events cannot be physically trusted; simulate the browser's trust bit only.
const trusted = <T extends Event>(e: T): T => { Object.defineProperty(e, 'isTrusted', { value: true }); return e; };
const click = (el: Element) => el.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })));
const key = (el: Element, type: string, value: string) => el.dispatchEvent(trusted(new KeyboardEvent(type, { key: value, bubbles: true, composed: true, cancelable: true })));

function openPicker() {
  const change = vi.fn();
  const done = vi.fn();
  picker = new RegionPicker(document, { regions: [{ id: 'r', label: 'Nav', selector: 'nav' }], excludes: [] }, { onChange: change, onDone: done, onCancel: vi.fn() });
  picker.open();
  return { root: document.querySelector('translucid-picker')!.shadowRoot!, change, done };
}

describe('picker input isolation', () => {
  it('does not move page focus when a panel button is pressed', () => {
    document.body.innerHTML = '<input id="page-field" value="menu search">';
    const field = document.getElementById('page-field')!;
    field.focus();
    const { root } = openPicker();
    const page = vi.fn();
    for (const type of ['focusin', 'blur', 'focusout']) document.addEventListener(type, page, true);
    try {
      const exclude = [...root.querySelectorAll('button')].find((b) => b.textContent === '排除内容')!;
      exclude.dispatchEvent(trusted(new MouseEvent('pointerdown', { bubbles: true, composed: true, cancelable: true })));
      click(exclude);
      expect(document.activeElement).toBe(field);
      expect(root.querySelector('button.on')!.textContent).toBe('排除内容');
      expect(page).not.toHaveBeenCalled();
    } finally { for (const type of ['focusin', 'blur', 'focusout']) document.removeEventListener(type, page, true); }
  });
  it('runs SVG remove and label actions without replaying a click to page capture listeners', () => {
    const { root, change } = openPicker();
    const page = vi.fn();
    document.addEventListener('click', page, true);
    const replay = vi.spyOn(HTMLElement.prototype, 'click');
    try {
      click(root.querySelector('li button svg path')!);
      expect(root.querySelector('li')).toBeNull();
      const count = change.mock.calls.length;
      click(root.querySelector('.chk')!);
      expect(change.mock.calls.length).toBe(count + 1);
      expect(root.querySelector<HTMLInputElement>('.chk input')!.checked).toBe(true);
      expect(page).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
    } finally { document.removeEventListener('click', page, true); }
  });

  it('activates panel buttons with Enter and Space, isolating both keyboard halves', () => {
    const { root, done } = openPicker();
    const page = vi.fn();
    for (const type of ['keydown', 'keyup', 'keypress']) document.addEventListener(type, page, true);
    try {
      const exclude = [...root.querySelectorAll('button')].find((b) => b.textContent === '排除内容')!;
      key(exclude, 'keydown', 'Enter');
      expect(root.querySelector('button.on')!.textContent).toBe('排除内容');
      key(exclude, 'keyup', 'Enter');
      const finish = [...root.querySelectorAll('button')].find((b) => b.textContent === '完成')!;
      key(finish, 'keydown', ' ');
      key(finish, 'keyup', ' ');
      expect(done).toHaveBeenCalledOnce();
      expect(page).not.toHaveBeenCalled();
    } finally { for (const type of ['keydown', 'keyup', 'keypress']) document.removeEventListener(type, page, true); }
  });

  it('blocks Escape and arrow key releases, including a release after Escape paused picking', () => {
    const { root } = openPicker();
    document.body.insertAdjacentHTML('beforeend', '<nav><button id="target">Settings</button></nav>');
    const target = document.getElementById('target')!;
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
    const page = vi.fn();
    for (const type of ['keydown', 'keyup', 'keypress']) document.addEventListener(type, page, true);
    try {
      key(target, 'keydown', 'ArrowUp');
      key(target, 'keypress', 'ArrowUp');
      key(target, 'keyup', 'ArrowUp');
      key(target, 'keydown', 'Escape');
      expect(root.querySelector('button.on')!.textContent).toContain('暂停');
      key(target, 'keyup', 'Escape');
      expect(page).not.toHaveBeenCalled();
    } finally { for (const type of ['keydown', 'keyup', 'keypress']) document.removeEventListener(type, page, true); }
  });
});

describe('picker panel keeps out of the way', () => {
  // happy-dom has no layout: a wide row reaches under the panel at the top right.
  const layout = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('panel')) return new DOMRect(window.innerWidth - 376, 16, 360, 400);
    if (this.id === 'row') return new DOMRect(0, 100, window.innerWidth, 40);
    return new DOMRect(0, 0, 0, 0);
  });
  const setup = () => {
    vi.useFakeTimers();
    layout();
    document.body.innerHTML = '<div id="row">A settings row as wide as the page</div>';
    const { root } = openPicker();
    // The panel is re-rendered on mode changes: always read the current one.
    const corner = () => root.querySelector('.panel')!.className;
    const row = document.getElementById('row')!;
    const hover = (el: Element) => el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true, clientX: 200, clientY: 120 }));
    return { root, corner, row, hover };
  };
  afterEach(() => vi.useRealTimers());

  it('moves off a highlight only once the pointer rests there', () => {
    const { corner, row, hover } = setup();
    hover(row);
    vi.advanceTimersByTime(250);
    expect(corner()).toContain('at-tr');
    vi.advanceTimersByTime(100);
    expect(corner()).not.toContain('at-tr');
  });

  it('stays when picking is paused before the delay ends', () => {
    const { corner, row, hover } = setup();
    hover(row);
    key(row, 'keydown', 'Escape');
    vi.advanceTimersByTime(500);
    expect(corner()).toContain('at-tr');
  });

  it('stays while the pointer is on the panel, even when a scroll repaints the highlight', () => {
    const { root, corner, row, hover } = setup();
    hover(row);
    hover(root.querySelector('.panel button')!);
    window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(500);
    expect(corner()).toContain('at-tr');
    // Back on the page and resting: now it moves.
    hover(row);
    vi.advanceTimersByTime(350);
    expect(corner()).not.toContain('at-tr');
  });
});

describe('scan overlay input isolation', () => {
  it('preserves focused page menus when the overlay opens', () => {
    document.body.innerHTML = '<div id="menu" role="menu"><input id="menu-search"></div>';
    const menu = document.getElementById('menu')!, field = document.getElementById('menu-search')!;
    field.focus();
    const dismiss = vi.fn(() => menu.remove());
    const blur = vi.fn();
    menu.addEventListener('focusout', dismiss);
    field.addEventListener('blur', blur);
    overlay = new ScanOverlay(document, vi.fn());
    overlay.open();
    expect(document.activeElement).toBe(field);
    expect(menu.isConnected).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
  });

  it('lets page focus handlers run and uses non-passive capture for scroll and touch blocking', () => {
    document.body.innerHTML = '<input id="first"><input id="second">';
    const listen = vi.spyOn(window, 'addEventListener');
    overlay = new ScanOverlay(document, vi.fn());
    overlay.open();
    for (const type of ['wheel', 'touchstart', 'touchmove']) {
      expect(listen.mock.calls.find(([name]) => name === type)?.[2]).toEqual({ capture: true, passive: false });
    }
    const events: string[] = [];
    const first = document.getElementById('first')!, second = document.getElementById('second')!;
    for (const type of ['focus', 'blur', 'focusin', 'focusout']) first.addEventListener(type, () => events.push(type));
    first.focus(); second.focus();
    expect(events).toEqual(expect.arrayContaining(['focus', 'blur', 'focusin', 'focusout']));
    for (const type of ['focus', 'blur', 'focusin', 'focusout']) {
      const handler = vi.fn();
      document.addEventListener(type, handler, true);
      try {
        first.dispatchEvent(trusted(new Event(type, { bubbles: true, composed: true })));
        expect(handler).toHaveBeenCalledOnce();
      } finally { document.removeEventListener(type, handler, true); }
    }
    for (const type of ['wheel', 'touchstart', 'touchmove']) {
      const event = trusted(new Event(type, { bubbles: true, cancelable: true }));
      expect(first.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
  });
  it('blocks shield and panel input but directly honors hit-tested Stop, focused Enter/Space and Escape', () => {
    const stopped = vi.fn();
    overlay = new ScanOverlay(document, stopped);
    overlay.open();
    const host = document.querySelector('translucid-scan')!;
    expect(host.shadowRoot).toBeNull();
    // Retain a test-only reference to the closed root's button; no production debug bridge exists.
    const internal = overlay as unknown as { stopButton: HTMLButtonElement };
    vi.spyOn(internal.stopButton, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, right: 50, bottom: 50, width: 40, height: 40 } as DOMRect);
    const page = vi.fn();
    for (const type of ['click', 'pointerdown', 'keydown', 'keyup', 'pointermove', 'mousemove', 'touchmove', 'pointercancel', 'touchcancel', 'mouseover', 'pointerout', 'wheel']) document.addEventListener(type, page, true);
    try {
      host.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, clientX: 80, clientY: 80 })));
      expect(stopped).not.toHaveBeenCalled();
      host.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, clientX: 20, clientY: 20 })));
      expect(stopped).toHaveBeenCalledTimes(1);
      internal.stopButton.focus();
      key(internal.stopButton, 'keydown', 'Enter');
      key(internal.stopButton, 'keyup', 'Enter');
      key(internal.stopButton, 'keydown', ' ');
      key(host, 'keydown', 'Escape');
      key(host, 'keyup', 'Escape');
      expect(stopped).toHaveBeenCalledTimes(4);
      for (const type of ['pointermove', 'mousemove', 'touchmove', 'pointercancel', 'touchcancel', 'mouseover', 'pointerout', 'wheel']) host.dispatchEvent(trusted(new Event(type, { bubbles: true, composed: true, cancelable: true })));
      expect(page).not.toHaveBeenCalled();
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      expect(page).toHaveBeenCalledOnce(); // explorer programmatic input passes through
    } finally { for (const type of ['click', 'pointerdown', 'keydown', 'keyup', 'pointermove', 'mousemove', 'touchmove', 'pointercancel', 'touchcancel', 'mouseover', 'pointerout', 'wheel']) document.removeEventListener(type, page, true); }
  });
});
