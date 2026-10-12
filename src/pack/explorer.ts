// Automatic exploration: reveals the parts of an app's interface that only
// render on demand (settings sections, menus, dropdowns) so their strings can
// be collected. It only ever touches navigation and disclosure controls, checks
// every step for its expected result, records how to undo it, and restores the
// page afterwards. Anything it cannot do safely is skipped and reported.
//
// Action protocols:
//   nav item / tab   one element.click(); verified by the active marker moving or the URL changing
//   popup trigger    element.click(); if nothing opened and it is a pointer-driven trigger
//                    (Radix / Base UI), one complete PointerEvent('pointerdown'); never more
//   close            the same activation on the trigger again (a disclosure toggles closed);
//                    if that does nothing, Escape on the focused element inside the popup (first
//                    shielded from document-level listeners, then plain); verified closed and the
//                    parent surface still open
//   sub-page link    same-origin only; a click the app does not handle itself (no SPA routing)
//                    is cancelled, so the page never reloads; undone with history.back() only
//                    when exactly one entry was pushed
// Never touched: options, menu items (except settings links), switches, checkboxes, radios,
// sliders, text fields, form controls, submit/reset, external links, destructive labels.
import { ACTIVE_SELECTOR, COLLECTION_SELECTOR, CONTROL_SELECTOR, controlLabel, SURFACE_SELECTOR } from './structure';
import { hrefLooksPersonal } from './privacy';

export interface ExploreBudget {
  actions: number;
  ms: number;
  depth: number;
  triggersPerSurface: number;
  links: number;
}

export const DEFAULT_BUDGET: ExploreBudget = { actions: 120, ms: 120_000, depth: 3, triggersPerSurface: 30, links: 20 };

export interface ExploreProgress {
  step: string;
  actions: number;
  visited: number;
}

export interface ExploreHooks {
  /** Read strings in `root` (called after each verified transition). */
  collect(root: Element): void;
  progress?(p: ExploreProgress): void;
  shouldStop(): boolean;
}

export interface ExploreReport {
  visited: string[];
  skipped: { label: string; reason: string; count?: number }[];
  actions: number;
  ms: number;
  budgetHit?: 'actions' | 'time';
  stopped?: boolean;
  refused?: 'draft';
  /** A setting changed after this step: exploration was aborted. */
  guard?: string;
  restore: 'full' | 'partial';
  unrestored: string[];
}

const NEVER =
  '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],[role="slider"],[role="textbox"],[role="spinbutton"],[role="searchbox"],input,select,textarea,[type="submit"],[type="reset"],[contenteditable]:not([contenteditable="false"]),[disabled],[aria-disabled="true"]';
const TRIGGER = '[aria-haspopup]:not([aria-haspopup="false"]),[role="combobox"]';
const GUARDED = 'input,select,textarea,[role="switch"],[role="checkbox"],[role="radio"],[aria-pressed],[role="slider"]';
const SETTINGS_RE = /\b(settings|preferences)\b|设置|設定/i;
const DANGER_RE =
  /\b(delete|remove|log ?out|sign ?out|save|submit|upgrade|pay|purchase|buy|checkout|send|share|export|new|create|invite|archive|leave|disconnect|revoke|reset|clear|unsubscribe|cancel plan|deactivate|transfer|publish|deploy|run|start|stop|restart|install|uninstall|download|upload|import|duplicate|rename|block|report)\b|删除|移除|退出|登出|保存|提交|升级|付款|购买|发送|分享|导出|新建|创建|邀请|归档|离开|断开|撤销|重置|清除|发布|部署|安装|卸载|下载|上传|导入|重命名/i;

export class Abort extends Error {
  constructor(readonly kind: 'stopped' | 'actions' | 'time' | 'guard' | 'draft', readonly label = '') {
    super(kind);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` until it returns something truthy or `ms` passes. */
async function until<T>(cond: () => T | null | undefined | false, ms: number, every = 40): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() >= end) return undefined;
    await sleep(every);
  }
}

/** Wait until the DOM under `root` has been quiet for `quiet` ms (at most `max`). */
export function settle(root: Node, quiet = 200, max = 2000): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quiet);
    const stop = setTimeout(done, max);
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quiet);
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    function done() {
      mo.disconnect();
      clearTimeout(timer);
      clearTimeout(stop);
      resolve();
    }
  });
}

function visible(el: Element): boolean {
  if (!el.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el) : true;
}

const labelOf = (el: Element) => controlLabel(el) ?? '';

/** Gone, hidden, or in its closing transition (Base UI data-closed, Radix data-state=closed). */
const closing = (el: Element) => !el.isConnected || el.hasAttribute('data-closed') || el.getAttribute('data-state') === 'closed' || !visible(el);

function valueOf(el: Element): string {
  if (el instanceof HTMLInputElement) return el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value;
  if (el instanceof HTMLSelectElement) return JSON.stringify([...el.options].map((o) => [o.value, o.selected]));
  if (el instanceof HTMLTextAreaElement) return el.value;
  return [el.getAttribute('aria-checked'), el.getAttribute('aria-pressed'), el.getAttribute('aria-valuenow')].join('|');
}

/** Values of setting controls; a change after a step means exploration touched a setting. */
class ValueGuard {
  private base = new WeakMap<Element, string>();
  private seen = new Set<Element>();
  record(root: ParentNode): void {
    for (const el of root.querySelectorAll(GUARDED)) {
      if (this.base.has(el)) continue;
      this.base.set(el, valueOf(el));
      this.seen.add(el);
    }
  }
  /** Label of a control whose value changed (only controls present before and after count). */
  changed(): string | undefined {
    for (const el of this.seen) {
      if (!el.isConnected) {
        this.seen.delete(el);
        continue;
      }
      if (valueOf(el) !== this.base.get(el)) return labelOf(el) || el.tagName.toLowerCase();
    }
    return undefined;
  }
}

const SAVE_RE = /^(save|save changes|update|apply|保存|保存更改|应用|更新)$/i;

function enabledSaveButton(b: Element, allowSubmit = false): boolean {
  if (b.matches(':disabled,[disabled],[aria-disabled="true"]') || !visible(b)) return false;
  const label = (b.getAttribute('aria-label') ?? (b instanceof HTMLInputElement ? b.value : b.textContent) ?? '').replace(/\s+/g, ' ').trim();
  const submit = b instanceof HTMLInputElement ? b.type === 'submit'
    : b instanceof HTMLButtonElement && b.type === 'submit' && (b.hasAttribute('type') || !!b.form);
  return SAVE_RE.test(label) || (allowSubmit && submit);
}

function needsExplicitSave(el: Element): boolean {
  for (let region = el.parentElement; region; region = region.parentElement) {
    if (region.matches('form,[role="dialog"],[role="alertdialog"],dialog[open]')
      && [...region.querySelectorAll('button,[role="button"],input[type="submit"]')].some((b) => enabledSaveButton(b, true))) return true;
  }
  return false;
}

/** Unsaved page or dialog input must survive exploration, including controlled fields. */
export function hasDraft(doc: Document): boolean {
  const active = doc.activeElement;
  if (active && visible(active) && active.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"]),textarea,[contenteditable]:not([contenteditable="false"])')) {
    const content = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.value : active.textContent;
    if (content?.trim()) return true;
  }
  for (const el of doc.querySelectorAll('input,textarea,select')) {
    if (!visible(el)) continue;
    if (el instanceof HTMLInputElement) {
      if (['hidden', 'submit', 'button', 'reset'].includes(el.type)) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked && needsExplicitSave(el)) return true;
      } else if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true;
    } else if (el instanceof HTMLSelectElement) {
      // Controlled autosaving fields can retain their mount-time checked/selected defaults.
      if (!needsExplicitSave(el)) continue;
      const options = [...el.options];
      // Without an explicit selected attribute the browser selects the first enabled option.
      const defaults = options.filter((o) => o.defaultSelected ?? o.hasAttribute('selected'));
      const fallback = options.find((o) => !o.disabled && !o.closest('optgroup[disabled]'));
      const selected = el.multiple ? defaults : [defaults.at(-1) ?? ((el.size || 0) <= 1 ? fallback : undefined)];
      if (options.some((o) => o.selected !== selected.includes(o))) return true;
    }
  }
  for (const region of doc.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')) {
    for (const b of region.querySelectorAll('button,[role="button"],input[type="submit"]')) {
      if (enabledSaveButton(b)) return true;
    }
  }
  return false;
}

/** Open popups and dialogs (top-level surface elements). */
function surfaces(doc: Document): Element[] {
  return [...doc.querySelectorAll(SURFACE_SELECTOR)].filter((s) => visible(s) && !s.parentElement?.closest(SURFACE_SELECTOR));
}

/** The surface a trigger opened: new since `before`, or referenced by aria-controls once expanded. */
function openedBy(doc: Document, before: Set<Element>, trigger: Element): Element | undefined {
  const id = trigger.getAttribute('aria-controls');
  if (id && trigger.getAttribute('aria-expanded') === 'true') {
    const el = doc.getElementById(id);
    if (el && visible(el)) return el;
  }
  const fresh = surfaces(doc).find((s) => !before.has(s) && !s.contains(trigger));
  if (!fresh) return undefined;
  // Radix wraps menus in a popper div: return the menu itself.
  return fresh.matches('[data-radix-popper-content-wrapper]') ? (fresh.querySelector('[role]') ?? fresh) : fresh;
}

interface NavCollection {
  container: Element;
  active: Element;
}

/** Navigation collections inside `scope` (3+ controls, exactly one active). */
export function navCollectionsIn(scope: Element): NavCollection[] {
  const out: NavCollection[] = [];
  for (const c of scope.querySelectorAll(COLLECTION_SELECTOR)) {
    if (out.some((o) => o.container.contains(c) || c.contains(o.container))) continue;
    const controls = [...c.querySelectorAll(CONTROL_SELECTOR)].filter(visible);
    if (controls.length < 3) continue;
    const active = controls.filter((x) => x.matches(ACTIVE_SELECTOR) || !!x.closest('[aria-current]:not([aria-current="false"])'));
    if (active.length === 1) out.push({ container: c, active: active[0]! });
  }
  return out;
}

const isActive = (el: Element) => el.matches(ACTIVE_SELECTOR) || !!el.querySelector('[aria-current]:not([aria-current="false"])');

export class Explorer {
  private actions = 0;
  private t0 = 0;
  private guard = new ValueGuard();
  private opened: { popup: Element; trigger: Element; label: string; via: 'click' | 'pointer' }[] = [];
  private report: ExploreReport = { visited: [], skipped: [], actions: 0, ms: 0, restore: 'full', unrestored: [] };
  private triedTriggers = new Set<string>();
  /** In the final restore: stop requests no longer interrupt. */
  private restoring = false;
  /** Settings are opened from a menu at most once per scan. */
  private settingsVisited = false;
  /** A change seen while restoring (reported, not interrupting). */
  private lateChange: string | undefined;
  private navigationApi = false;
  private leaveAttempts = 0;
  /** Nav collections being explored right now (never re-entered from inside). */
  private navStack: Element[] = [];

  constructor(
    private doc: Document,
    private hooks: ExploreHooks,
    private budget: ExploreBudget = DEFAULT_BUDGET,
  ) {}

  async run(): Promise<ExploreReport> {
    this.t0 = Date.now();
    if (hasDraft(this.doc)) {
      this.report.refused = 'draft';
      return this.report;
    }
    const body = this.doc.body;
    const href0 = this.doc.location.href;
    const release = this.holdNavigation();
    this.guard.record(body);
    this.hooks.collect(body);
    try {
      // Start where the user is: an open dialog (settings) if there is one, else the page.
      const scope = surfaces(this.doc).filter((s) => s.matches('[role="dialog"],[role="alertdialog"],dialog')).at(-1) ?? body;
      await this.exploreScope(scope, 0);
      if (scope === body) await this.exploreLinks(0);
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      if (e.kind === 'draft') this.report.refused = 'draft';
      else if (e.kind === 'stopped') this.report.stopped = true;
      else if (e.kind === 'guard') {
        this.report.guard = e.label;
        // A changed setting cannot be put back by the explorer: say so instead of "restored".
        this.unrestored(`设置值被改动：${e.label}`);
      } else this.report.budgetHit = e.kind;
    } finally {
      this.restoring = true;
      await this.closeAll();
      if (this.doc.location.href !== href0) this.unrestored('地址已变化');
      const late = this.lateChange ?? this.guard.changed();
      if (late && !this.report.guard) {
        this.report.guard = late;
        this.unrestored(`设置值被改动：${late}`);
      }
      // Kept a moment longer: a navigation an app schedules right after the last click is cancelled too.
      setTimeout(release, 1500);
    }
    // A stop that came when no further action was due still counts as stopped.
    if (this.hooks.shouldStop()) this.report.stopped = true;
    this.report.actions = this.actions;
    this.report.ms = Date.now() - this.t0;
    return this.report;
  }

  // ---------- budget, guard, bookkeeping ----------

  /** Stop requested: no new action starts (restoring what was opened still runs). */
  private checkStop(): void {
    if (!this.restoring && this.hooks.shouldStop()) throw new Abort('stopped');
  }

  private tick(step: string): void {
    this.checkStop();
    if (this.actions >= this.budget.actions) throw new Abort('actions');
    if (Date.now() - this.t0 > this.budget.ms) throw new Abort('time');
    this.actions++;
    this.hooks.progress?.({ step, actions: this.actions, visited: this.report.visited.length });
  }

  /** After every verified step: nothing may have changed, and newly rendered controls get a baseline. */
  private checkGuard(label: string): void {
    const changed = this.guard.changed();
    if (changed) throw new Abort('guard', `${label} → ${changed}`);
    this.guard.record(this.doc.body);
  }

  /** Like checkGuard, but a step that restores state records a change instead of interrupting. */
  private guardStep(label: string, restoring: boolean): void {
    if (!restoring && !this.restoring) return this.checkGuard(label);
    const changed = this.guard.changed();
    if (changed) this.lateChange ??= `${label} → ${changed}`;
    this.guard.record(this.doc.body);
  }

  private skip(label: string, reason: string): void {
    if (reason === '指向个人内容') {
      const item = this.report.skipped.find((s) => s.reason === reason);
      if (item) item.count = (item.count ?? 1) + 1;
      else this.report.skipped.push({ label: '个人内容链接', reason, count: 1 });
      return;
    }
    if (label && !this.report.skipped.some((s) => s.label === label && s.reason === reason)) this.report.skipped.push({ label, reason });
  }

  private unrestored(what: string): void {
    this.report.restore = 'partial';
    if (!this.report.unrestored.includes(what)) this.report.unrestored.push(what);
  }

  private visit(root: Element, label: string): void {
    if (label) this.report.visited.push(label);
    this.hooks.collect(root);
    this.guard.record(root);
  }

  private safe(el: Element, label: string): string | undefined {
    const personal = el.closest('a[href]');
    if (personal && hrefLooksPersonal(personal.getAttribute('href')!, this.doc.location.href)) return '指向个人内容';
    if (!visible(el)) return '不可见';
    if (el.matches(NEVER) || el.closest('[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"]')) return '会改变设置';
    // A <button> without type="button" inside (or attached to) a form submits it.
    const button = el.closest('button');
    if (button instanceof this.doc.defaultView!.HTMLButtonElement && button.type === 'submit' && button.form) return '可能提交表单';
    if (DANGER_RE.test(label)) return '可能执行操作';
    const a = el.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href')!;
      let u: URL;
      try {
        u = new URL(href, this.doc.location.href);
      } catch {
        return '链接无效';
      }
      if (u.origin !== this.doc.location.origin) return '外部链接';
      if (hrefLooksPersonal(href, this.doc.location.href)) return '指向个人内容';
    }
    return undefined;
  }

  // ---------- navigation sections ----------

  private async exploreScope(scope: Element, depth: number): Promise<void> {
    for (const col of this.freshCollections(scope)) await this.exploreNav(col, scope, depth);
    await this.explorePopups(scope, depth);
  }

  private freshCollections(scope: Element): NavCollection[] {
    return navCollectionsIn(scope).filter((c) => !this.navStack.some((s) => s === c.container || s.contains(c.container) || c.container.contains(s)));
  }

  private async exploreNav(col: NavCollection, scope: Element, depth: number): Promise<void> {
    const originalLabel = labelOf(col.active);
    // Destinations only: menu buttons in a sidebar are popup triggers (explored as popups), not places.
    const destinations = () => [...col.container.querySelectorAll(CONTROL_SELECTOR)].filter((c) => visible(c) && !c.matches(TRIGGER) && !c.closest(TRIGGER));
    const labels = [...new Set(destinations().map(labelOf).filter(Boolean))];
    const find = (label: string) => destinations().find((c) => labelOf(c) === label);
    let moved = false;
    this.navStack.push(col.container);
    try {
      for (const label of labels) {
        if (label === originalLabel) continue;
        const el = find(label);
        if (!el) continue;
        const unsafe = this.safe(el, label);
        if (unsafe) {
          this.skip(label, unsafe);
          continue;
        }
        if (!(await this.clickNav(el, label, false, () => (moved = true)))) continue;
        // Same dialog, new section: read the whole scope again (not only "new surfaces").
        this.visit(scope.isConnected ? scope : this.doc.body, label);
        if (depth + 1 < this.budget.depth) {
          for (const inner of this.freshCollections(scope)) await this.exploreNav(inner, scope, depth + 1);
          await this.explorePopups(scope, depth + 1, col.container);
        }
      }
    } finally {
      this.navStack.pop();
      // Back to the section the user was on.
      if (moved) {
        const back = find(originalLabel);
        if (!back || !(await this.clickNav(back, originalLabel, true))) this.unrestored(`返回「${originalLabel}」`);
      }
    }
  }

  private async clickNav(el: Element, label: string, restoring = false, onMoved?: () => void): Promise<boolean> {
    if (!restoring) this.checkGuard(label);
    if (!restoring) this.tick(`打开「${label}」`);
    const href = this.doc.location.href;
    const ok = await this.followClick(el);
    if (!ok) {
      this.skip(label, '会离开当前页面');
      this.guardStep(label, restoring);
      return false;
    }
    const verified = await until(() => isActive(el) || !el.isConnected || this.doc.location.href !== href, 1500);
    if (!verified) {
      if (!restoring) this.skip(label, '点击后没有变化');
      // Nothing visible happened, but something else might have: the guard still checks.
      this.guardStep(label, restoring);
      return false;
    }
    // Registered before anything can throw, so the way back is always taken.
    onMoved?.();
    await settle(this.doc.body);
    this.guardStep(label, restoring);
    return true;
  }

  /**
   * Click without ever leaving the document: if the app does not handle a link
   * click itself (no client-side routing), the browser's navigation is cancelled.
   */
  private async followClick(el: Element): Promise<boolean> {
    const link = el.closest('a[href]');
    const before = this.leaveAttempts;
    let leaving = false;
    const view = this.doc.defaultView!;
    // Fallback without the Navigation API: a link click nobody handled would load a page.
    const onClick = (e: Event) => {
      if (link && !e.defaultPrevented) {
        e.preventDefault();
        leaving = true;
      }
    };
    if (!this.navigationApi) view.addEventListener('click', onClick, { once: true });
    try {
      (el as HTMLElement).click();
    } finally {
      if (!this.navigationApi) view.removeEventListener('click', onClick);
    }
    return !leaving && this.leaveAttempts === before;
  }

  /**
   * For the whole scan, every cross-document navigation the page starts (from a click, or later
   * from app code) is cancelled before it begins, whatever its handlers did with the click event.
   */
  private holdNavigation(): () => void {
    const nav = (this.doc.defaultView as Window & { navigation?: EventTarget } | null)?.navigation;
    if (!nav) return () => {};
    this.navigationApi = true;
    const onNavigate = (e: Event) => {
      const ev = e as Event & { destination?: { sameDocument?: boolean }; cancelable: boolean };
      if (ev.destination?.sameDocument === false) {
        this.leaveAttempts++;
        if (ev.cancelable) e.preventDefault();
      }
    };
    nav.addEventListener('navigate', onNavigate);
    return () => nav.removeEventListener('navigate', onNavigate);
  }

  // ---------- popups ----------

  private async explorePopups(scope: Element, depth: number, exclude?: Element): Promise<void> {
    let n = 0;
    // Triggers inside the scope itself count (a dialog the explorer opened has dropdowns of its own),
    // not those inside other popups that happen to be open.
    const triggers = [...scope.querySelectorAll(TRIGGER)].filter((t) => !exclude?.contains(t) && !this.opened.some((o) => o.popup !== scope && o.popup.contains(t)));
    for (const t of triggers) {
      if (n >= this.budget.triggersPerSurface) {
        this.skip(labelOf(t), '超出每个界面的数量上限');
        continue;
      }
      if (!t.isConnected) continue;
      const label = labelOf(t);
      // One look per trigger label and place ("More options" on every row opens the same menu).
      const key = `${label}\u0001${t.getAttribute('aria-haspopup') ?? t.getAttribute('role')}`;
      if (this.triedTriggers.has(key)) continue;
      this.triedTriggers.add(key);
      const unsafe = this.safe(t, label);
      if (unsafe) {
        this.skip(label, unsafe);
        continue;
      }
      n++;
      const popup = await this.open(t, label);
      if (!popup) continue;
      this.visit(popup, label);
      if (depth + 1 < this.budget.depth && popup.matches('[role="dialog"],[role="alertdialog"],dialog')) await this.exploreScope(popup, depth + 1);
      else if (await this.exploreSettingsLink(popup, depth)) {
        // Following the link closed the menu.
        if (!popup.isConnected) {
          this.opened = this.opened.filter((o) => o.popup !== popup);
          continue;
        }
      }
      if (!(await this.close(popup, t, scope))) {
        this.unrestored(`关闭「${label}」`);
        return;
      }
    }
  }

  private async open(trigger: Element, label: string): Promise<Element | undefined> {
    this.tick(`展开「${label}」`);
    const before = new Set(surfaces(this.doc));
    if (!(await this.followClick(trigger))) {
      this.skip(label, '会离开当前页面');
      return undefined;
    }
    let via: 'click' | 'pointer' = 'click';
    let popup = await until(() => openedBy(this.doc, before, trigger), 600);
    // Pointer-driven triggers (Radix, Base UI) ignore click(): one complete pointerdown, nothing more.
    if (!popup && (trigger.hasAttribute('data-state') || trigger.hasAttribute('aria-haspopup')) && trigger.getAttribute('aria-expanded') !== 'true') {
      // Stopped while waiting: no further event is dispatched.
      if (!this.restoring && this.hooks.shouldStop()) {
        this.checkGuard(label);
        throw new Abort('stopped');
      }
      this.pointerdown(trigger);
      via = 'pointer';
      popup = await until(() => openedBy(this.doc, before, trigger), 600);
    }
    if (!popup) {
      this.skip(label, '未能展开');
      this.checkGuard(label);
      return undefined;
    }
    this.opened.push({ popup, trigger, label, via });
    await settle(popup.isConnected ? popup : this.doc.body, 150, 1500);
    this.checkGuard(label);
    return popup;
  }

  private pointerdown(el: Element): void {
    const PE = this.doc.defaultView!.PointerEvent ?? this.doc.defaultView!.MouseEvent;
    el.dispatchEvent(new PE('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true } as PointerEventInit));
  }

  private async close(popup: Element, trigger: Element, parent: Element): Promise<boolean> {
    const entry = this.opened.find((o) => o.popup === popup);
    const isClosed = () => closing(popup) || trigger.getAttribute('aria-expanded') === 'false';
    // A disclosure closes the way it opened: the same activation on its trigger.
    if (entry && trigger.isConnected && trigger.getAttribute('aria-expanded') === 'true') {
      if (entry.via === 'pointer') this.pointerdown(trigger);
      else (trigger as HTMLElement).click();
      if (await until(isClosed, 400)) {
        this.opened = this.opened.filter((o) => o.popup !== popup);
        return this.afterClose(parent);
      }
    }
    const active = this.doc.activeElement;
    const target = active && popup.contains(active) ? active : popup;
    const KE = this.doc.defaultView!.KeyboardEvent;
    const escape = (shield: boolean) => {
      // Shielded: the event stops at <body>, so document-level handlers of other layers (a dialog
      // from another library under this popup) never see it; handlers on the popup itself, in the
      // capture phase or on <body> still do.
      const stop = (e: Event) => e.stopPropagation();
      if (shield) this.doc.body.addEventListener('keydown', stop, { once: true });
      target.dispatchEvent(new KE('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit));
      if (shield) this.doc.body.removeEventListener('keydown', stop);
    };
    escape(true);
    let closed = await until(isClosed, 400);
    if (!closed) {
      escape(false);
      closed = await until(isClosed, 1000);
    }
    this.opened = this.opened.filter((o) => o.popup !== popup);
    if (!closed) return false;
    return this.afterClose(parent);
  }

  private async afterClose(parent: Element): Promise<boolean> {
    if (parent !== this.doc.body && closing(parent)) {
      // Escape closed the parent dialog too: exploration of it cannot continue.
      this.unrestored('上一层对话框被一并关闭');
      return false;
    }
    await settle(this.doc.body, 100, 800);
    // Closing is an action too: it must not have changed anything. (During the final restore a
    // change is reported instead of interrupting the restore.)
    this.guardStep('关闭弹层', false);
    return true;
  }

  /** Links may be followed from menus only when they lead to settings: same origin, nothing personal. */
  private safeLink(a: Element, label: string): string | undefined {
    if (hrefLooksPersonal(a.getAttribute('href')!, this.doc.location.href)) return '指向个人内容';
    if (!visible(a)) return '不可见';
    if (DANGER_RE.test(label)) return '可能执行操作';
    let u: URL;
    try {
      u = new URL(a.getAttribute('href')!, this.doc.location.href);
    } catch {
      return '链接无效';
    }
    if (u.origin !== this.doc.location.origin) return '外部链接';
    if (hrefLooksPersonal(a.getAttribute('href')!, this.doc.location.href)) return '指向个人内容';
    return undefined;
  }

  /**
   * In an open menu (an account menu, say), the settings link: the one exception to "never click a
   * menu item". Its settings (a dialog or a page) are explored, then closed or navigated back.
   */
  private async exploreSettingsLink(menu: Element, depth: number): Promise<boolean> {
    if (this.settingsVisited || depth + 1 >= this.budget.depth) return false;
    const link = [...menu.querySelectorAll('a[href]')].find((a) => SETTINGS_RE.test(labelOf(a)) || SETTINGS_RE.test(a.getAttribute('href') ?? ''));
    if (!link) return false;
    const label = labelOf(link);
    const unsafe = this.safeLink(link, label);
    if (unsafe) {
      this.skip(label, unsafe);
      return false;
    }
    this.checkGuard(label);
    this.settingsVisited = true;
    this.tick(`打开「${label}」`);
    const loc = this.doc.location;
    const href = loc.href;
    const pos = this.historyPosition();
    const before = new Set(surfaces(this.doc));
    if (!(await this.followClick(link))) {
      this.skip(label, '会重新加载页面');
      this.checkGuard(label);
      return false;
    }
    const isDialog = (s: Element) => s.matches('[role="dialog"],[role="alertdialog"],dialog');
    const dialog = await until(() => surfaces(this.doc).find((s) => !before.has(s) && isDialog(s)), 1500);
    const routed = loc.href !== href;
    if (!dialog && !routed) {
      this.skip(label, '点击后没有变化');
      this.checkGuard(label);
      return false;
    }
    try {
      await settle(this.doc.body);
      this.checkGuard(label);
      const scope = dialog ?? this.doc.body;
      this.visit(scope, label);
      await this.exploreScope(scope, depth + 1);
    } finally {
      // Back to where the user was: pop the one history entry we pushed, else close the dialog.
      if (routed && this.pushedOne(pos)) {
        this.doc.defaultView!.history.back();
        if (!(await until(() => loc.href === href, 1500))) this.unrestored(`关闭「${label}」`);
        else await settle(this.doc.body, 150, 1500);
      } else if (dialog?.isConnected && !closing(dialog)) {
        const was = this.restoring;
        this.restoring = true;
        if (!(await this.close(dialog, dialog, this.doc.body))) this.unrestored(`关闭「${label}」`);
        this.restoring = was;
      } else if (routed && loc.href !== href) this.unrestored(`从「${label}」返回`);
    }
    return true;
  }

  private async closeAll(): Promise<void> {
    for (const o of [...this.opened].reverse()) {
      if (!o.popup.isConnected) continue;
      if (!(await this.close(o.popup, o.trigger, this.doc.body))) this.unrestored(`关闭「${o.label}」`);
    }
    this.opened = [];
  }

  // ---------- sub-pages ----------

  /** Session history position: Navigation API entry index (exact), else history.length. */
  private historyPosition(): { index?: number; length: number } {
    const view = this.doc.defaultView as (Window & { navigation?: { currentEntry?: { index: number } } }) | null;
    return { index: view?.navigation?.currentEntry?.index, length: view?.history.length ?? 0 };
  }

  /** Did the last step push exactly one history entry (so history.back() returns to where we were)? */
  private pushedOne(before: { index?: number; length: number }): boolean {
    const now = this.historyPosition();
    if (before.index !== undefined && now.index !== undefined) return now.index === before.index + 1;
    return now.length === before.length + 1;
  }

  /** Same-origin sub-pages of the current page, and settings pages. Undone with history.back(). */
  private async exploreLinks(depth: number): Promise<void> {
    const loc = this.doc.location;
    const base = loc.pathname.replace(/\/$/, '');
    const pathOf = (a: Element) => {
      try {
        const u = new URL(a.getAttribute('href')!, loc.href);
        return u.origin === loc.origin ? u.pathname : undefined;
      } catch {
        return undefined;
      }
    };
    const targets: string[] = [];
    for (const a of this.doc.querySelectorAll('a[href]')) {
      const p = pathOf(a);
      if (!p || p === loc.pathname || targets.includes(p)) continue;
      const sub = p.startsWith(base + '/');
      const settings = SETTINGS_RE.test(p) || SETTINGS_RE.test(labelOf(a));
      if (sub || settings) targets.push(p);
    }
    for (const target of targets.slice(0, this.budget.links)) {
      // Re-found each time: returning to the hub re-renders its links.
      const a = [...this.doc.querySelectorAll('a[href]')].find((x) => pathOf(x) === target && visible(x));
      if (!a) continue;
      const label = labelOf(a);
      const unsafe = this.safe(a, label);
      if (unsafe) {
        this.skip(label, unsafe);
        continue;
      }
      this.checkGuard(label);
      this.tick(`打开「${label}」`);
      const href = loc.href;
      const before = this.historyPosition();
      if (!(await this.followClick(a))) {
        this.skip(label, '会重新加载页面');
        continue;
      }
      if (!(await until(() => loc.href !== href, 1500))) {
        this.skip(label, '点击后没有变化');
        continue;
      }
      let back = false;
      try {
        await settle(this.doc.body);
        this.checkGuard(label);
        this.visit(this.doc.body, label);
        if (depth + 1 < this.budget.depth) await this.exploreScope(this.doc.body, depth + 1);
      } finally {
        // Undo even when stopped or aborted: only an entry we verifiably pushed is popped.
        if (this.pushedOne(before)) {
          this.doc.defaultView!.history.back();
          back = !!(await until(() => loc.href === href, 1500));
          if (back) await settle(this.doc.body);
        }
        if (!back) this.unrestored(`从「${label}」返回`);
      }
      if (!back) return;
    }
  }
}
