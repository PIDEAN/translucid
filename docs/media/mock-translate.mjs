// OpenAI-compatible streaming endpoint for the README media only (port 5302).
// It answers with hand-written Simplified Chinese from zh-dictionary.json instead of calling a model, so the
// captured frames show real translations. A site-pack request's outline gives each string its question
// (radios "Text size" › opt Medium), and the "context" table picks a different translation per question.
// GET /control?delay=ms slows replies (to show progress); unknown strings come back unchanged.
// The same endpoint also listens with TLS on 5303 under a throwaway self-signed certificate, so the browser can
// map the DeepSeek preset's address onto it (see launch() in lib.ts) and the frames show a real-looking URL.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dict = JSON.parse(readFileSync(new URL('./zh-dictionary.json', import.meta.url), 'utf8'));
const plain = { ...dict.ui, ...dict.journal };
const norm = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const GROUP = /^(\s*)(radios|select|menu|tabs|field|group|nav|listbox|toolbar)\s+(?:"([^"]+)"|<\d+>([\s\S]*?)<\/\d+>)/;

/** Translate every <n>…</n> of a request, using the enclosing group label as context when there is one. */
function translate(user) {
  const out = [];
  const stack = []; // [{ indent, label }]
  for (const line of user.split('\n')) {
    const indent = line.match(/^\s*/)[0].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const g = line.match(GROUP);
    for (const m of line.matchAll(/<(\d+)>([\s\S]*?)<\/\1>/g)) {
      const src = norm(m[2]);
      const ctx = stack.at(-1)?.label;
      const t = (ctx && dict.context[`${ctx}::${src}`]) ?? plain[src] ?? src;
      out.push(`<${m[1]}>${t}</${m[1]}>`);
    }
    if (g) stack.push({ indent, label: norm(g[3] ?? g[4] ?? '') });
  }
  return out.join('\n');
}

let delay = 0;
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/control') {
    if (url.searchParams.has('delay')) delay = Number(url.searchParams.get('delay'));
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' }).end();
    return;
  }
  if (url.pathname !== '/v1/chat/completions') return void res.writeHead(404).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body);
  const out = translate(messages.at(-1)?.content ?? '');
  if (delay) await new Promise((r) => setTimeout(r, delay));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
  // Stream in small pieces with a short pause, like a real model.
  for (let i = 0; i < out.length; i += 24) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.slice(i, i + 24) } }] })}\n\n`);
    if (delay) await new Promise((r) => setTimeout(r, 12));
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 60 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

createServer(handle).listen(5302, () => console.log('media translator on http://localhost:5302'));
const dir = mkdtempSync(join(tmpdir(), 'translucid-media-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=api.deepseek.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
const tls = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
rmSync(dir, { recursive: true, force: true });
createTlsServer(tls, handle).listen(5303, () => console.log('media translator on https://localhost:5303'));
