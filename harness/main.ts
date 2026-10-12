// Dev harness: runs the real content Controller inside an iframe against saved
// pages, with a fake background that echoes "译：" + the serialized text so
// placement, inline tags, modes and dynamic content can be checked in a browser.
import { Controller, type Transport } from '../src/content/controller';
import type { ToBackground, ToContent } from '../src/shared/messages';
import transCss from '../src/styles/trans.css?raw';

const SAMPLE = `<!doctype html><html lang="en"><head><title>Sample article</title>
<style>body{font:16px/1.6 Georgia,serif;max-width:720px;margin:24px auto;padding:0 16px}nav a{margin-right:12px}.card{display:block;border:1px solid #ddd;padding:8px;margin:8px 0}</style></head><body>
<nav><a href="#">Home</a><a href="#">Pricing</a><a href="#">Docs</a></nav>
<h1>Attention Is Still All You Need</h1>
<p>Transformers replaced recurrence with <a href="https://example.com">self-attention</a>, and the <b>results</b> were striking. Run <code>pip install torch</code> to follow along.<sup><a href="#r1">[1]</a></sup></p>
<div>Mixed container text before a block <p>An inner paragraph that must be translated on its own.</p> and trailing words after it.</div>
<ul><li>First bullet with <em>emphasis</em> inside.</li><li>Second bullet item text.</li></ul>
<a class="card" href="#"><div>Card title wrapped by a link</div><div>Card body text, also wrapped by the same link.</div></a>
<pre>const notTranslated = "code block";</pre>
<p class="notranslate">This paragraph is marked notranslate.</p>
<p>已经是中文的段落不会被翻译。</p>
<blockquote>Line one of a quote<br>line two of the same quote</blockquote>
<table><tr><td>Cell with text</td><td>42</td></tr></table>
<dl><dt><a href="#delay"><code>IntersectionObserver.delay</code></a> <span style="border:1px solid #999;border-radius:4px;padding:0 4px;font-size:12px">Read only</span> <abbr title="Experimental"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="teal"/></svg></abbr></dt><dd>An integer indicating the minimum delay between notifications from this observer.</dd></dl>
${Array.from({ length: 30 }, (_, i) => `<p>Filler paragraph number ${i + 1} to test lazy translation while scrolling down the page.</p>`).join('')}
<div id="feed"></div>
</body></html>`;

const frame = document.getElementById('frame') as HTMLIFrameElement;
const stats = document.getElementById('stats')!;
const flaky = document.getElementById('flaky') as HTMLInputElement;
let controller: Controller | null = null;
let requests = 0;
let sentSegments = 0;

class FakeTransport implements Transport {
  onMessage: ((msg: ToContent) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  send(msg: ToBackground): void {
    if (msg.type !== 'translate' && msg.type !== 'refine') return;
    requests++;
    const segs = msg.type === 'translate' ? msg.segments : [msg.segment];
    sentSegments += segs.length;
    setTimeout(() => {
      for (const s of segs) {
        if (flaky.checked && s.id % 3 === 0) {
          this.onMessage?.({ type: 'error', ids: [s.id], message: '模拟失败' });
          continue;
        }
        const text = `译：${s.text}`;
        this.onMessage?.(msg.type === 'refine' ? { type: 'refined', id: s.id, text: `精翻：${s.text}` } : { type: 'result', id: s.id, text });
      }
    }, 350);
  }
}

async function load(page: string) {
  controller?.stop();
  let html = SAMPLE;
  let base = '';
  if (page !== 'sample') {
    html = await (await fetch(`/fixtures/${page}.html`)).text();
    base = { wiki: 'https://en.wikipedia.org/', hn: 'https://news.ycombinator.com/', github: 'https://github.com/' }[page] ?? '';
  }
  // Strip scripts so fixtures are static; keep stylesheets for realistic layout.
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  if (base) html = html.replace(/<head[^>]*>/i, (m) => `${m}<base href="${base}">`);
  frame.srcdoc = html;
  await new Promise((r) => (frame.onload = r));
  const doc = frame.contentDocument!;
  const style = doc.createElement('style');
  style.textContent = transCss;
  doc.head.append(style);
  requests = sentSegments = 0;
  controller = new Controller(new FakeTransport(), { mode: 'bilingual', transStyle: 'faded', preprocess: 'off' }, doc);
  (window as any).controller = controller;
}

setInterval(() => {
  if (!controller) return;
  const s = controller.state();
  stats.textContent = `${s.enabled ? 'ON' : 'OFF'} · ${s.mode} · segs ${s.stats.segments} · done ${s.stats.done} · err ${s.stats.errors} · requests ${requests} · sent ${sentSegments}`;
}, 300);

document.getElementById('toggle')!.onclick = () => controller?.toggle();
document.getElementById('mode')!.onclick = () => controller?.setMode(controller.mode === 'replace' ? 'bilingual' : 'replace');
(document.getElementById('style') as HTMLSelectElement).onchange = (e) => controller?.setStyle((e.target as HTMLSelectElement).value as any);
(document.getElementById('page') as HTMLSelectElement).onchange = (e) => load((e.target as HTMLSelectElement).value);
document.getElementById('mutate')!.onclick = () => {
  const doc = frame.contentDocument!;
  const feed = doc.getElementById('feed') ?? doc.body;
  const p = doc.createElement('p');
  p.innerHTML = `Dynamically inserted post at ${new Date().toLocaleTimeString('en-US')} with a <a href="#">link</a>.`;
  feed.prepend(p);
  p.scrollIntoView({ block: 'center' });
};

void load(new URLSearchParams(location.search).get('page') ?? 'sample');
