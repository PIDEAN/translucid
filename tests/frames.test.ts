import { describe, expect, it } from 'vitest';
import { pageFrameReady, pageFrameVerdict, sensitiveFrame, siteHost, type FrameInfo } from '../src/content/frames';
import { IntentFollower } from '../src/content/page-intent';
import { combineStates, PAGE_COMMANDS, staleFrames, type FrameReport } from '../src/shared/frame-state';
import type { PageIntent, TabState } from '../src/shared/messages';

const frame = (patch: Partial<FrameInfo>): FrameInfo => ({ top: false, url: 'https://docs.example.com/page', width: 1200, height: 800, editable: false, ...patch });

describe('which documents page translation runs in', () => {
  it('always the top document; a subframe only when it is page-sized', () => {
    expect(pageFrameVerdict(frame({ top: true, width: 10, height: 10 }))).toBe('yes');
    expect(pageFrameVerdict(frame({}))).toBe('yes');
    // Ad sizes wait (they never grow into the page).
    for (const [width, height] of [[300, 250], [728, 90], [300, 600], [160, 600]]) expect(pageFrameVerdict(frame({ width, height }))).toBe('size');
  });

  it('never in widgets, editors or non-web documents', () => {
    for (const url of [
      'https://www.google.com/recaptcha/api2/anchor?k=x',
      'https://www.google.com/maps/embed?pb=x',
      'https://newassets.hcaptcha.com/captcha/v1/x',
      'https://js.stripe.com/v3/elements-inner.html',
      'https://www.youtube.com/embed/abc',
      'https://www.youtube-nocookie.com/embed/abc',
      'https://googleads.g.doubleclick.net/pagead/x',
      'https://platform.twitter.com/embed/Tweet.html',
      'https://accounts.google.com/gsi/iframe',
      'about:srcdoc',
      'data:text/html,hi',
    ]) expect(pageFrameVerdict(frame({ url })), url).toBe('no');
    expect(pageFrameVerdict(frame({ editable: true }))).toBe('no');
    // Google's own documentation frames are page content.
    expect(pageFrameVerdict(frame({ url: 'https://developers-dot-devsite-v2-prod.appspot.com/edge/foresight/index.frame' }))).toBe('yes');
  });

  it('a frame sized after it loads joins once it becomes page-sized', async () => {
    let size = { innerWidth: 0, innerHeight: 0 };
    const listeners: (() => void)[] = [];
    const win = {
      get innerWidth() { return size.innerWidth; },
      get innerHeight() { return size.innerHeight; },
      top: {},
      location: { href: 'https://docs.example.com/page' },
      document: { designMode: 'off', body: { isContentEditable: false } },
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    } as unknown as Window;
    const ready = pageFrameReady(win);
    size = { innerWidth: 1000, innerHeight: 700 };
    for (const fn of listeners) fn();
    await expect(ready).resolves.toBe(true);
  });

  it('a frame holding sign-in, one-time code or card fields is sensitive', () => {
    const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');
    expect(sensitiveFrame(doc('<form><input type="password"></form>'))).toBe(true);
    expect(sensitiveFrame(doc('<input autocomplete="one-time-code">'))).toBe(true);
    expect(sensitiveFrame(doc('<input autocomplete="billing cc-number">'))).toBe(true);
    expect(sensitiveFrame(doc('<input autocomplete="cc-exp">'))).toBe(true);
    // Recognized by name, id, label or placeholder when no autocomplete is set.
    expect(sensitiveFrame(doc('<input name="otp" inputmode="numeric">'))).toBe(true);
    expect(sensitiveFrame(doc('<input name="cardNumber" inputmode="numeric">'))).toBe(true);
    expect(sensitiveFrame(doc('<input id="cvc">'))).toBe(true);
    expect(sensitiveFrame(doc('<input aria-label="Verification code">'))).toBe(true);
    expect(sensitiveFrame(doc('<input placeholder="请输入验证码">'))).toBe(true);
    expect(sensitiveFrame(doc('<article><p>Docs</p><input type="search"></article>'))).toBe(false);
    expect(sensitiveFrame(doc('<input name="email"><input name="q"><input type="hidden" name="password">'))).toBe(false);
  });

  it('a frame laid out after its document is ready joins without any resize event', async () => {
    let size = { innerWidth: 0, innerHeight: 0 };
    let observed: (() => void) | undefined;
    const win = {
      get innerWidth() { return size.innerWidth; },
      get innerHeight() { return size.innerHeight; },
      top: {},
      location: { href: 'https://docs.example.com/page' },
      document: { designMode: 'off', body: { isContentEditable: false }, documentElement: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      ResizeObserver: class { constructor(cb: () => void) { observed = cb; } observe() {} disconnect() {} },
    } as unknown as Window;
    const ready = pageFrameReady(win);
    size = { innerWidth: 1280, innerHeight: 800 };
    observed!();
    await expect(ready).resolves.toBe(true);
  });

  it('site rules follow the site the user is on, also inside its frames', () => {
    const loc = (hostname: string, ancestors?: string[]) =>
      ({ hostname, ancestorOrigins: ancestors && Object.assign([...ancestors], { contains: () => false, item: (i: number) => ancestors[i] ?? null }) }) as unknown as Location;
    expect(siteHost(loc('developers.google.com'))).toBe('developers.google.com');
    expect(siteHost(loc('developers-dot-devsite-v2-prod.appspot.com', ['https://developers.google.com']))).toBe('developers.google.com');
    // Nested frames: the last ancestor is the top document.
    expect(siteHost(loc('c.example', ['https://b.example', 'https://top.example']))).toBe('top.example');
  });
});

const state = (patch: Omit<Partial<TabState>, 'stats'> & { stats?: Partial<TabState['stats']> }): TabState => ({
  enabled: true,
  mode: 'bilingual',
  expertOverride: '',
  resolvedExpert: null,
  firstPaintMs: null,
  avgTtftMs: null,
  lang: 'en',
  estimate: null,
  pageInfo: null,
  selectionInSegment: false,
  ...patch,
  stats: { segments: 0, done: 0, errors: 0, pending: 0, ...patch.stats },
});

describe('a tab read as one page', () => {
  it('adds up the counts of the top document and its page frames', () => {
    const st = combineStates([
      { frameId: 7, state: state({ lang: 'en', resolvedExpert: { id: 'tech', name: '科技' }, stats: { segments: 24, done: 20, pending: 3, errors: 1 }, firstPaintMs: 900, avgTtftMs: 600 }) },
      { frameId: 0, state: state({ lang: 'fr', stats: { segments: 1, done: 1 }, firstPaintMs: 400, avgTtftMs: 800, expertOverride: 'news' }) },
    ])!;
    expect(st.stats).toEqual({ segments: 25, done: 21, pending: 3, errors: 1 });
    // Details come from the document holding the text; the override set from the popup is the top one's.
    expect(st.lang).toBe('en');
    expect(st.resolvedExpert?.id).toBe('tech');
    expect(st.expertOverride).toBe('news');
    expect(st.firstPaintMs).toBe(400);
    expect(st.avgTtftMs).toBe(700);
  });

  it('is on when any document translates, and estimates the whole page while off', () => {
    expect(combineStates([{ frameId: 0, state: state({ enabled: false }) }, { frameId: 3, state: state({ enabled: true, mode: 'replace' }) }])).toMatchObject({ enabled: true, mode: 'replace' });
    expect(combineStates([{ frameId: 0, state: state({ enabled: false, estimate: 1 }) }, { frameId: 3, state: state({ enabled: false, estimate: 24 }) }])!.estimate).toBe(25);
    expect(combineStates([])).toBeNull();
  });

  it('partly on: still on (显示原文 and Alt+A restore it), with the text left untranslated reported', () => {
    // Auto-translate turned the top document on; the embedded page with the text is still off.
    const partial = combineStates([{ frameId: 0, state: state({ enabled: true, stats: { segments: 1, done: 1 } }) }, { frameId: 4, state: state({ enabled: false, estimate: 24 }) }])!;
    expect(partial).toMatchObject({ enabled: true, estimate: null, rest: 24 });
    // A frame with nothing to translate leaves nothing to offer.
    expect(combineStates([{ frameId: 0, state: state({ enabled: true }) }, { frameId: 4, state: state({ enabled: false, estimate: 0 }) }])!.rest).toBeNull();
  });

  it('page-wide commands belong to the top document; the rest act in every document', () => {
    for (const t of ['toggle', 'set-enabled', 'set-mode', 'toggle-mode', 'set-expert'] as const) expect(PAGE_COMMANDS.has(t)).toBe(true);
    for (const t of ['refine-at-cursor', 'refine-selection', 'retry-failed', 'purge-page', 'get-state'] as const) expect(PAGE_COMMANDS.has(t)).toBe(false);
  });
});

describe('a frame following the page intent', () => {
  const intent = (version: number, enabled: boolean | null, doc = 'page-a'): PageIntent => ({ doc, version, enabled, mode: null, expertId: null });

  it('waits until it joined its page, then applies the newest intent of that page only', () => {
    const applied: PageIntent[] = [];
    const f = new IntentFollower((i) => applied.push(i));
    f.offer(intent(3, true));
    f.offer(intent(2, false)); // older update arriving late
    f.offer(intent(9, false, 'old-page')); // left over from the page before a navigation
    expect(applied).toEqual([]);
    f.join(intent(1, true)); // the snapshot is older than an update that came in meanwhile
    expect(applied).toEqual([intent(3, true)]);
    expect(f.status()).toEqual({ doc: 'page-a', version: 3 });
  });

  it('never goes back to an older intent, applies each version once, and ignores other pages', () => {
    const applied: PageIntent[] = [];
    const f = new IntentFollower((i) => applied.push(i));
    f.join(intent(4, true));
    f.offer(intent(4, true)); // the same change written again
    f.offer(intent(5, false)); // 显示原文
    f.offer(intent(4, true)); // an older read arriving late
    f.offer(intent(7, true, 'old-page'));
    expect(applied.map((i) => i.version)).toEqual([4, 5]);
    expect(applied.at(-1)!.enabled).toBe(false);
  });

  it('without an answer from its page it applies nothing, and never guesses the page from updates', () => {
    const applied: PageIntent[] = [];
    const f = new IntentFollower((i) => applied.push(i));
    f.join(null);
    f.offer(null);
    f.offer({} as PageIntent);
    f.offer(intent(9, true, 'old-page')); // highest version, but from the page before a navigation
    f.offer(intent(2, false));
    expect(applied).toEqual([]);
    expect(f.bound).toBe(false);
    // The page answers when asked again: its newest intent applies, the old page's never.
    f.join(intent(1, false));
    expect(applied).toEqual([intent(2, false)]);
    expect(f.status()).toEqual({ doc: 'page-a', version: 2 });
  });
});

describe('frames behind the top document', () => {
  const report = (frameId: number, r: Partial<FrameReport>) => ({ frameId, report: { state: state({}), ...r } as FrameReport });
  const top = (version: number) => report(0, { intent: { doc: 'page-a', version, enabled: false, mode: null, expertId: null } });

  it('are the frames of this page with an older version (a lost update)', () => {
    expect(staleFrames([top(5), report(3, { follows: { doc: 'page-a', version: 5 } }), report(4, { follows: { doc: 'page-a', version: 4 } }), report(6, { follows: { doc: null, version: -1 } })])).toEqual({
      intent: { doc: 'page-a', version: 5, enabled: false, mode: null, expertId: null },
      frameIds: [4, 6],
    });
    expect(staleFrames([top(5), report(3, { follows: { doc: 'page-a', version: 5 } })])).toBeNull();
    expect(staleFrames([report(3, { follows: { doc: 'page-a', version: 1 } })])).toBeNull();
  });
});
