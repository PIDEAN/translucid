import { beforeEach, describe, expect, it } from 'vitest';
import { Controller, pageLang, type Transport } from '../src/content/controller';
import { detectDarkPage, needsFit } from '../src/content/render';
import { BUILTIN_EXPERTS } from '../src/prompt/experts/builtin';
import { parseGlossary, serializeGlossary } from '../src/prompt/glossary';
import { explainExpert } from '../src/shared/match';
import type { ToBackground, ToContent } from '../src/shared/messages';

const html = (s: string) => {
  document.body.innerHTML = s;
  return document.body;
};

describe('needsFit', () => {
  it('flags items of a single-line flex row and clamped boxes, not normal paragraphs', () => {
    html(`
      <nav style="display:flex"><a id="nav" style="display:block">Docs</a></nav>
      <div style="display:flex;flex-wrap:wrap"><a id="wrap" style="display:block">Docs</a></div>
      <div style="overflow:hidden;max-height:44px"><p id="clamp">Deploying small changes safely</p></div>
      <p id="plain">A normal paragraph of body text.</p>
      <div style="display:flex"><p id="long">${'Long body text inside a flex row. '.repeat(5)}</p></div>
    `);
    const $ = (id: string) => document.getElementById(id)!;
    expect(needsFit($('nav'))).toBe(true);
    expect(needsFit($('wrap'))).toBe(false);
    expect(needsFit($('clamp'))).toBe(true);
    expect(needsFit($('plain'))).toBe(false);
    expect(needsFit($('long'))).toBe(false);
  });
});

describe('detectDarkPage', () => {
  it('reads the body background, falling back to html', () => {
    document.body.style.background = 'rgb(18, 18, 20)';
    expect(detectDarkPage(document)).toBe(true);
    document.body.style.background = 'rgb(250, 250, 250)';
    expect(detectDarkPage(document)).toBe(false);
    document.body.style.background = '';
  });
});

describe('explainExpert', () => {
  it('says which rule picked the expert', () => {
    expect(explainExpert(BUILTIN_EXPERTS, 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service', [], 'general')).toMatchObject({
      expert: { id: 'rigorous' },
      reason: '路径匹配 */*terms*',
    });
    expect(explainExpert(BUILTIN_EXPERTS, 'https://github.com/a/b', [], 'general')?.reason).toBe('域名匹配 github.com');
    expect(explainExpert(BUILTIN_EXPERTS, 'https://github.com/a/b', [{ host: 'github.com', mode: 'default', expertId: 'news' }], 'general')).toMatchObject({
      expert: { id: 'news' },
      reason: '站点规则 github.com',
    });
    expect(explainExpert(BUILTIN_EXPERTS, 'https://example.org/', [], 'general')?.reason).toBe('未匹配，使用默认');
  });
});

describe('glossary serializer', () => {
  it('round-trips entries, KEEP and notes', () => {
    const text = 'LLM => 大语言模型\nTransformer => KEEP # 架构名\nagent => 智能体';
    expect(serializeGlossary(parseGlossary(text))).toBe(text);
  });
});

describe('pageLang', () => {
  it('prefers html lang and falls back to script detection', () => {
    document.documentElement.lang = 'en-US';
    expect(pageLang(document)).toBe('en-us');
    document.documentElement.lang = '';
    html('<p>これは日本語のテキストです</p>');
    expect(pageLang(document)).toBe('ja');
  });
});

// ---------- controller quick actions with a scripted background ----------

class FakeTransport implements Transport {
  onMessage: ((msg: ToContent) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  sent: ToBackground[] = [];
  /** ids to fail on the next translate request */
  failIds = new Set<number>();
  send(msg: ToBackground): void {
    this.sent.push(msg);
    queueMicrotask(() => {
      if (msg.type === 'translate') {
        for (const s of msg.segments) {
          if (this.failIds.has(s.id)) this.onMessage?.({ type: 'error', ids: [s.id], message: 'boom' });
          else this.onMessage?.({ type: 'result', id: s.id, text: `译：${s.text}` });
        }
        this.onMessage?.({ type: 'metric', data: { ttftMs: 640, totalMs: 900 } });
      }
      if (msg.type === 'purge') this.onMessage?.({ type: 'purged' });
      if (msg.type === 'refine') this.onMessage?.({ type: 'refined', id: msg.segment.id, text: `精翻：${msg.segment.text}` });
    });
  }
}

/** happy-dom has no layout, so IntersectionObserver never fires: report everything visible. */
class AlwaysVisibleIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('Controller quick actions', () => {
  let t: FakeTransport;
  let c: Controller;
  beforeEach(() => {
    (window as any).IntersectionObserver = AlwaysVisibleIO;
    html('<p id="a">First paragraph with enough words.</p><p id="b">Second paragraph with enough words.</p><p id="c">Third paragraph with enough words.</p>');
    t = new FakeTransport();
    c = new Controller(t, { mode: 'bilingual', transStyle: 'faded', preprocess: 'off' });
  });

  it('renders, reports timing, and retries only failed segments', async () => {
    t.failIds = new Set([2]);
    c.start();
    await tick();
    let st = c.state();
    expect(st.stats).toMatchObject({ segments: 3, done: 2, errors: 1, pending: 0 });
    expect(st.firstPaintMs).not.toBeNull();
    expect(st.avgTtftMs).toBe(640);
    expect(document.querySelector('#b xt-retry')).not.toBeNull();

    t.failIds.clear();
    expect(c.retryFailed()).toBe(1);
    await tick();
    st = c.state();
    expect(st.stats).toMatchObject({ done: 3, errors: 0 });
    const lastTranslate = t.sent.filter((m) => m.type === 'translate').at(-1) as Extract<ToBackground, { type: 'translate' }>;
    expect(lastTranslate.segments.map((s) => s.text)).toEqual(['Second paragraph with enough words.']);
  });

  it('purges cached texts then translates the page again', async () => {
    c.start();
    await tick();
    const before = t.sent.filter((m) => m.type === 'translate').length;
    c.purgePage();
    await tick();
    const purge = t.sent.find((m) => m.type === 'purge') as Extract<ToBackground, { type: 'purge' }>;
    expect(purge.texts).toHaveLength(3);
    expect(t.sent.filter((m) => m.type === 'translate').length).toBeGreaterThan(before);
    expect(c.state().stats.done).toBe(3);
  });

  it('refines the paragraph holding the selection', async () => {
    c.start();
    await tick();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('c')!.firstChild!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(c.state().selectionInSegment).toBe(true);
    expect(c.refineSelection()).toBe(true);
    await tick();
    expect(document.querySelector('#c xt-trans')!.textContent).toContain('精翻：');
    expect(document.querySelector('#c xt-trans')!.hasAttribute('data-refined')).toBe(true);
    sel.removeAllRanges();
    expect(c.state().selectionInSegment).toBe(false);
  });

  it('estimates segments while idle and hides it once running', () => {
    expect(c.state().estimate).toBe(3);
    c.start();
    expect(c.state().estimate).toBeNull();
  });

  it('applies typography classes from options', () => {
    c.updateOptions({ fontSize: 'small', lineHeight: 'compact', transStyle: 'tint' });
    c.start();
    const cl = document.documentElement.classList;
    expect(cl.contains('xt-fs-small')).toBe(true);
    expect(cl.contains('xt-lh-compact')).toBe(true);
    expect(cl.contains('xt-style-tint')).toBe(true);
    c.stop();
    expect(cl.contains('xt-on')).toBe(false);
  });
});

describe('translation-only mode', () => {
  it('a refinement that keeps the original text shows the original again instead of hiding both', async () => {
    (window as any).IntersectionObserver = AlwaysVisibleIO;
    html('<p id="n">Python Software Foundation update for the community.</p>');
    const t = new FakeTransport();
    const c = new Controller(t, { mode: 'replace', transStyle: 'faded', preprocess: 'off' });
    c.start();
    await tick();
    const p = document.getElementById('n')!;
    expect(p.querySelector('xt-orig')).not.toBeNull();
    const seg = (t.sent.find((m) => m.type === 'translate') as Extract<ToBackground, { type: 'translate' }>).segments[0]!;
    t.onMessage!({ type: 'refined', id: seg.id, text: seg.text });
    // The copy is hidden by CSS (data-same); the original must not stay wrapped in the hidden <xt-orig>.
    expect(p.querySelector('xt-orig')).toBeNull();
    expect(p.querySelector('xt-trans')!.hasAttribute('data-same')).toBe(true);
    expect(p.firstChild!.textContent).toBe(seg.text);
    // A later translation that differs wraps the original again.
    t.onMessage!({ type: 'refined', id: seg.id, text: '蟒蛇软件基金会社区动态。' });
    expect(p.querySelector('xt-orig')).not.toBeNull();
    c.stop();
  });
});

describe('layout guard', () => {
  it('turns carousel paragraphs into tooltips but keeps short labels inline', async () => {
    (window as any).IntersectionObserver = AlwaysVisibleIO;
    html(
      '<div class="carousel"><h3 id="h">Slide title</h3><p id="p">A long slide paragraph that would overflow the fixed-height slideshow box.</p></div><p id="body">Regular body paragraph outside the carousel.</p>',
    );
    const t = new FakeTransport();
    const c = new Controller(t, { mode: 'bilingual', transStyle: 'faded', preprocess: 'off' });
    c.start();
    await tick();
    const p = document.querySelector('#p xt-trans')!;
    expect(p.hasAttribute('data-tip')).toBe(true);
    expect(document.getElementById('p')!.getAttribute('title')).toContain('译：');
    expect(document.querySelector('#h xt-trans')!.hasAttribute('data-tip')).toBe(false);
    expect(document.querySelector('#body xt-trans')!.hasAttribute('data-tip')).toBe(false);
    c.stop();
    expect(document.getElementById('p')!.hasAttribute('title')).toBe(false);
  });
});

describe('Controller and site language packs', () => {
  it('skips nodes a pack owns and drops segments a pack takes over later', async () => {
    const { PackApplier } = await import('../src/pack/applier');
    const { emptyPack, toRuntime } = await import('../src/pack/format');
    (window as any).IntersectionObserver = AlwaysVisibleIO;
    html('<p id="ui">Welcome back to your workspace</p><p id="body">An ordinary paragraph that the article translator handles.</p><p id="late">Shown in the sidebar once loaded</p>');
    const pack = toRuntime({
      ...emptyPack('app.example.com', 'zh-CN'),
      entries: [
        { kind: 'text', src: 'Welcome back to your workspace', t: '欢迎回到工作区', status: 'auto' },
        { kind: 'text', src: 'Shown in the sidebar once loaded', t: '加载后显示在侧栏', status: 'auto' },
      ],
    });
    // Pack first for #ui only (the late string is not on the page yet for the pack's purposes).
    const early = new PackApplier(document, { ...pack, map: Object.fromEntries(Object.entries(pack.map).filter(([k]) => k.includes('Welcome'))) });
    early.start();
    const t = new FakeTransport();
    const c = new Controller(t, { mode: 'bilingual', transStyle: 'faded', preprocess: 'off' });
    c.start();
    await tick();
    const sent = t.sent.flatMap((m) => (m.type === 'translate' ? m.segments.map((s) => s.text) : []));
    expect(sent).not.toContain('Welcome back to your workspace');
    expect(sent).toContain('An ordinary paragraph that the article translator handles.');
    expect(document.querySelector('#late xt-trans')).not.toBeNull();

    // A pack revision now covers #late: its article translation is removed.
    early.setRuntime(pack);
    await tick();
    expect(document.querySelector('#late xt-trans')).toBeNull();
    expect(document.getElementById('late')!.textContent).toBe('加载后显示在侧栏');
    expect(document.querySelector('#body xt-trans')).not.toBeNull();
    c.stop();
    early.restore();
  });
});
