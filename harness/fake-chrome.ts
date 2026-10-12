// chrome.* stand-in so popup/options run in the harness. The tab side is a small
// simulation of the content script: commands change state the way the real
// Controller does, so popup interactions can be clicked through end to end.
import { emptyPack, toIndexItem } from '../src/pack/format';
import { buildUiBatchMessages } from '../src/prompt/ui-locale';
import type { TabCommand, TabState } from '../src/shared/messages';
import { loadOpenRouterFreeModels } from '../src/background/providers';

const params = new URLSearchParams(location.search);
const store: Record<string, unknown> = {};
const listeners: ((changes: Record<string, { newValue: unknown }>, area: string) => void)[] = [];
let cacheCount = 1234;

const tab: TabState = {
  enabled: params.get('state') === 'active',
  mode: 'bilingual',
  expertOverride: '',
  resolvedExpert: { id: 'academic', name: '学术' },
  stats: { segments: 259, done: 0, errors: 0, pending: 0 },
  firstPaintMs: null,
  avgTtftMs: null,
  lang: params.get('lang') ?? 'en',
  estimate: 259,
  pageInfo: null,
  selectionInSegment: params.get('selection') === '1',
};
const log: TabCommand[] = [];
(window as any).__tab = tab;
(window as any).__log = log;

function startTranslating() {
  tab.enabled = true;
  tab.estimate = null;
  tab.stats = { segments: 259, done: 0, errors: 0, pending: 12 };
  tab.firstPaintMs = null;
}

// Progress ticks while "translating": first paint, then batches, two failures.
setInterval(() => {
  if (!tab.enabled) return;
  const st = tab.stats;
  if (st.done < 74) {
    st.done = Math.min(74, st.done + 18);
    st.pending = st.done < 74 ? 10 : 0;
    tab.firstPaintMs ??= 1480;
    tab.avgTtftMs = 812;
    if (st.done >= 74 && !tab.pageInfo) {
      st.errors = 2;
      tab.pageInfo = {
        topic: 'Transformer architecture',
        scene: 'academic',
        terms: [
          { src: 'attention', tgt: '注意力' },
          { src: 'token', tgt: '词元' },
          { src: 'Transformer', tgt: 'KEEP' },
        ],
      };
    }
  }
}, 400);

// ---------- site language pack sample data (Options › 站点语言包) ----------
const samplePack = {
  ...emptyPack('app.example.com', 'ja', Date.now()),
  site: { hosts: ['app.example.com'], scopes: ['/'], name: 'Example Chat', description: 'An AI chat assistant with projects and file uploads.' },
  regions: [{ id: 'r1', label: '导航（Sidebar）', selector: 'nav[aria-label="Sidebar"]' }, { id: 'overlays', label: '弹出菜单 / 对话框 / 提示', builtin: 'overlays' as const }],
  entries: [
    { kind: 'text' as const, src: 'New chat', t: '新しいチャット', status: 'auto' as const },
    { kind: 'placeholder' as const, src: 'Search chats', t: 'チャットを検索', status: 'edited' as const },
  ],
  rev: 3,
};
const samplePending = [
  { kind: 'text', src: 'Projects', region: 'r1', flags: [], count: 3, lastSeen: Date.now() },
  { kind: 'text', src: 'Upgrade plan', region: 'r1', flags: [], count: 2, lastSeen: Date.now() },
  { kind: 'text', src: 'Trip planning with Mira', region: 'r1', flags: ['personal-link'], count: 1, lastSeen: Date.now() },
  { kind: 'text', src: 'mira.chen@example.org', region: 'r1', flags: ['email'], count: 1, lastSeen: Date.now() },
  { kind: 'text', src: 'Rename', region: 'overlays', flags: [], count: 1, lastSeen: Date.now() },
  { kind: 'aria-label', src: 'Open settings', region: 'overlays', flags: [], count: 1, lastSeen: Date.now() },
];
function fakePack(msg: any) {
  switch (msg.type) {
    case 'pack-list':
      return { ok: true, index: [toIndexItem(samplePack, true)] };
    case 'pack-get':
      return { ok: true, pack: samplePack };
    case 'pack-pending-get':
      return { ok: true, pending: samplePending };
    case 'pack-job-get':
      return { ok: true, job: undefined };
    case 'pack-plan': {
      const items = samplePending.filter((p) => msg.keys.includes(`${p.kind}\u0001${p.src}`)).map((p) => ({ kind: p.kind as any, src: p.src, area: p.region === 'r1' ? '导航（Sidebar）' : 'popup menu / dialog / tooltip' }));
      const messages = [buildUiBatchMessages({ targetLang: 'ja', appName: samplePack.site.name, host: 'app.example.com', description: msg.description, glossary: [], items })];
      return { ok: true, plan: { messages, items: items.length, destination: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash' }, estimate: '约 900 tokens，¥0.01' } };
    }
    default:
      return { ok: true };
  }
}

(globalThis as any).chrome = {
  runtime: {
    id: 'harness',
    getManifest: () => ({ version: '0.2.0' }),
    getURL: (p: string) => p,
    sendMessage: async (msg: any) => {
      if (msg.type === 'openrouter-free-models') {
        try {
          return { models: await loadOpenRouterFreeModels() };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e) };
        }
      }
      if (msg.type === 'usage')
        return {
          [new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0')]: {
            deepseek: { requests: 42, promptTokens: 120000, cacheHitTokens: 64000, completionTokens: 90000, ttftMs: 34000, ttftCount: 42, cost: 0.83, currency: '¥' },
            gemini: { requests: 5, promptTokens: 10000, cacheHitTokens: 0, completionTokens: 8000, ttftMs: 4000, ttftCount: 5, cost: 0.0145, currency: '$' },
            'opencode-go': { requests: 9, promptTokens: 30000, cacheHitTokens: 0, completionTokens: 20000, ttftMs: 7000, ttftCount: 9, cost: 0, currency: '$', subscriptionEquiv: 0.033 },
          },
        };
      if (typeof msg.type === 'string' && msg.type.startsWith('pack-')) return fakePack(msg);
      if (msg.type === 'cache-count') return { count: cacheCount };
      if (msg.type === 'cache-clear') {
        cacheCount = 0;
        return { ok: true };
      }
      if (msg.type === 'test-provider') {
        await new Promise((r) => setTimeout(r, 300));
        if (!msg.provider.apiKey) return { error: `${msg.provider.name} 未配置 API Key` };
        const region = msg.provider.baseURL.includes('deepseek.com') ? (params.get('region') ?? 'cn') : undefined;
        return { text: '发布小而可回滚的改动。', ms: 812, usage: { promptTokens: 30, completionTokens: 9 }, region };
      }
      return { ok: true };
    },
    openOptionsPage: () => log.push({ type: 'get-state' }),
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => {
        Object.assign(store, JSON.parse(JSON.stringify(o)));
        for (const l of listeners) l(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { newValue: v }])), 'local');
      },
    },
    onChanged: { addListener: (l: any) => listeners.push(l) },
  },
  tabs: {
    query: async () => [{ id: 1, url: params.get('url') ?? 'https://en.wikipedia.org/wiki/Transformer_(deep_learning)' }],
    sendMessage: async (_id: number, cmd: TabCommand) => {
      if (params.get('unsupported') === '1') throw new Error('no receiver');
      log.push(cmd);
      switch (cmd.type) {
        case 'toggle':
          if (tab.enabled) tab.enabled = false;
          else startTranslating();
          break;
        case 'set-enabled':
          if (cmd.enabled) startTranslating();
          else {
            tab.enabled = false;
            tab.estimate = 259;
          }
          break;
        case 'set-mode':
          tab.mode = cmd.mode;
          break;
        case 'set-expert':
          tab.expertOverride = cmd.expertId;
          tab.stats.done = 0;
          break;
        case 'retry-failed':
          tab.stats.errors = 0;
          break;
        case 'purge-page':
          tab.stats.done = 0;
          tab.pageInfo = null;
          break;
        case 'refine-selection':
          break;
      }
      return JSON.parse(JSON.stringify(tab));
    },
  },
};
