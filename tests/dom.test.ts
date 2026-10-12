import { beforeEach, describe, expect, it } from 'vitest';
import { collectRuns } from '../src/content/extract';
import { buildFragment, serializeRun } from '../src/content/serialize';
import { isTranslatable } from '../src/shared/text';

const html = (s: string) => {
  document.body.innerHTML = s;
  return document.body;
};

const texts = (root: Element) => collectRuns(root).map((r) => serializeRun(r.nodes).text);

describe('collectRuns + serializeRun', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('finds one run per paragraph and keeps links/bold as tags', () => {
    const body = html('<p>Read <a href="/d">the <b>docs</b></a> first.</p><p>Second paragraph here.</p>');
    expect(texts(body)).toEqual(['Read <a2>the <b1>docs</b1></a2> first.', 'Second paragraph here.']);
  });

  it('turns code, citations and line breaks into atoms', () => {
    const body = html('<p>Run <code>npm i</code> now.<sup><a href="#c">[1]</a></sup><br>Next line</p>');
    expect(texts(body)).toEqual(['Run {{1}} now.{{2}}{{3}}Next line']);
  });

  it('splits mixed blocks so nothing is translated twice', () => {
    const body = html('<div>Intro text here <p>Inner paragraph text</p> tail words here</div>');
    expect(texts(body)).toEqual(['Intro text here', 'Inner paragraph text', 'tail words here']);
  });

  it('treats an inline element wrapping blocks as a container', () => {
    const body = html('<a href="/x"><div>Card title text</div><div>Card body text</div></a>');
    expect(texts(body)).toEqual(['Card title text', 'Card body text']);
  });

  it('skips pre, code blocks, notranslate, contenteditable and Chinese', () => {
    const body = html(
      '<pre>const x = 1;</pre><div class="notranslate">Keep this text</div><div contenteditable>Editing here</div><p>已经是中文的段落内容</p><p>Translate me please</p>',
    );
    expect(texts(body)).toEqual(['Translate me please']);
  });

  it('flattens presentational spans and drops empty ones', () => {
    const body = html('<p><span class="x">Hello</span> <span></span><em>big</em> world</p>');
    expect(texts(body)).toEqual(['Hello <i1>big</i1> world']);
  });

  it('respects the exclude selector and processed nodes', () => {
    const body = html('<nav><p>Menu item text</p></nav><p>Body text here</p>');
    const runs = collectRuns(body, { exclude: 'nav' });
    expect(runs.map((r) => r.plain)).toEqual(['Body text here']);
    const processed = new Set(runs.flatMap((r) => r.nodes));
    expect(collectRuns(body, { exclude: 'nav', isProcessed: (n) => processed.has(n) })).toEqual([]);
  });
});

describe('buildFragment', () => {
  it('rebuilds links and atoms by cloning the originals', () => {
    const body = html('<p>Read <a href="/d" id="l">the docs</a> and run <code>npm i</code>.</p>');
    const [run] = collectRuns(body);
    const { text, slots } = serializeRun(run!.nodes);
    expect(text).toBe('Read <a1>the docs</a1> and run {{2}}.');
    const { fragment, exact } = buildFragment('阅读<a1>文档</a1>并运行 {{2}}。', slots);
    const div = document.createElement('div');
    div.append(fragment);
    expect(exact).toBe(true);
    expect(div.innerHTML).toBe('阅读<a href="/d">文档</a>并运行 <code>npm i</code>。');
  });

  it('never parses model output as HTML', () => {
    const { fragment } = buildFragment('<img src=x onerror=alert(1)>你好', new Map());
    const div = document.createElement('div');
    div.append(fragment);
    expect(div.querySelector('img')).toBeNull();
    expect(div.textContent).toBe('<img src=x onerror=alert(1)>你好');
  });

  it('degrades gracefully on broken tags', () => {
    const a = document.createElement('a');
    const { fragment, exact } = buildFragment('点击<a1>这里</b2>继续', new Map([['a1', a]]));
    const div = document.createElement('div');
    div.append(fragment);
    expect(exact).toBe(false);
    expect(div.textContent).toBe('点击这里继续');
  });
});

describe('runs that are only markup', () => {
  it('serializes inline <style> as an atom so the run can be filtered out', () => {
    const body = html('<div><style>.a{color:red}</style><span class="x"></span></div><p>Real text here</p>');
    const out = collectRuns(body).map((r) => serializeRun(r.nodes, (el) => el.tagName === 'STYLE').text);
    expect(out.filter((t) => isTranslatable(t))).toEqual(['Real text here']);
  });
});

describe('formulas', () => {
  it('keeps a Wikipedia-style formula wrapper as one atom inside the sentence', () => {
    const body = html(
      '<p>where <span class="mwe-math-element"><span style="display:block">d</span><img alt="d"></span> is a positive even integer.</p>',
    );
    expect(texts(body)).toEqual(['where {{1}} is a positive even integer.']);
  });
});

describe('segment-wide wrappers', () => {
  it('strips a link that wraps the whole segment and re-applies it on render', () => {
    const body = html('<p><b><a href="/c/1">feat(docs): integrate the gateway</a></b></p>');
    const [run] = collectRuns(body);
    const { text, slots, outer } = serializeRun(run!.nodes);
    expect(text).toBe('feat(docs): integrate the gateway');
    expect(outer.map((e) => e.tagName)).toEqual(['B', 'A']);
    const { fragment } = buildFragment('feat(docs)：集成网关', slots, document, outer);
    const div = document.createElement('div');
    div.append(fragment);
    expect(div.innerHTML).toBe('<b><a href="/c/1">feat(docs)：集成网关</a></b>');
  });
  it('keeps tags that only wrap part of the segment', () => {
    const body = html('<p><a href="/x">Docs</a> and <a href="/y">more</a></p>');
    const [run] = collectRuns(body);
    expect(serializeRun(run!.nodes).text).toBe('<a1>Docs</a1> and <a2>more</a2>');
  });
});

describe('sloppy closing tags', () => {
  it('consumes a bare </a> instead of showing it as text', () => {
    const a = document.createElement('a');
    a.href = '/x';
    const { fragment } = buildFragment('自然<a3>语言处理</a>，生成', new Map([['a3', a]]));
    const div = document.createElement('div');
    div.append(fragment);
    expect(div.innerHTML).toBe('自然<a href="/x">语言处理</a>，生成');
  });
});

describe('code-only lead/trail', () => {
  const mdn = '<dl><dt><a href="/delay"><code>IntersectionObserver.delay</code></a> <span class="badge">Read only</span> <abbr><svg></svg></abbr></dt></dl>';
  it('sends only the prose and keeps code pieces for replace mode', () => {
    const body = html(mdn);
    const [run] = collectRuns(body);
    const s = serializeRun(run!.nodes);
    expect(s.text).toBe('Read only');
    expect(s.lead).toBe('<a2>{{1}}</a2>');
    expect(s.trail).toBe('{{3}}');
    const { fragment, exact } = buildFragment('只读', s.slots, document, s.outer, s);
    const div = document.createElement('div');
    div.append(fragment);
    expect(exact).toBe(true);
    expect(div.innerHTML).toBe(
      '<xt-peel><a href="/delay"><code>IntersectionObserver.delay</code></a></xt-peel> 只读 <xt-peel><abbr><svg></svg></abbr></xt-peel>',
    );
  });
  it('leaves sentences that merely start with code alone', () => {
    const body = html('<p><code>fetch()</code> returns a promise that resolves to the response.</p>');
    const [run] = collectRuns(body);
    const s = serializeRun(run!.nodes);
    expect(s.lead).toBe('{{1}}');
    expect(s.text).toBe('returns a promise that resolves to the response.');
  });
});
