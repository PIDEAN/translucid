// Minimal OpenAI-compatible streaming endpoint for end-to-end tests.
// Translates each <n>…</n> segment as "[<lang>] source". GET /control?delay=ms slows replies,
// /control?reset=1 clears the request log, GET /requests returns every request body received
// (privacy checks happen here, where service-worker traffic is visible).
import { createServer } from 'node:http';

let delay = 0;
let log = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/control') {
    if (url.searchParams.has('delay')) delay = Number(url.searchParams.get('delay'));
    if (url.searchParams.has('reset')) log = [];
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
    return;
  }
  if (url.pathname === '/requests') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(log));
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' }).end();
    return;
  }
  if (url.pathname !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { messages } = JSON.parse(body);
  log.push({ messages });
  const system = messages[0]?.content ?? '';
  const lang = (system.match(/\(([a-zA-Z-]+)\)\./) ?? [])[1] ?? 'xx';
  const user = messages.at(-1)?.content ?? '';
  // Page translation puts one segment per line; site packs put them inside an indented outline.
  const segs = [...user.matchAll(/<(\d+)>([\s\S]*?)<\/\1>/g)].map((m) => [m[1], m[2]]);
  const out = segs.map(([id, s]) => `<${id}>[${lang}] ${s}</${id}>`).join('\n');
  if (delay) await new Promise((r) => setTimeout(r, delay));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
  for (let i = 0; i < out.length; i += 40) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.slice(i, i + 40) } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
server.listen(5301, () => console.log('mock llm on http://localhost:5301'));
