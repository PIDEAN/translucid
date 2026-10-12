import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackRequest, PackResponse, PendingView } from '../src/pack/messages';
import { emptyPack, toIndexItem } from '../src/pack/format';
import { applyPackPatch } from '../src/pack/patch';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { Settings } from '../src/shared/types';

const env = vi.hoisted(() => ({
  stored: {} as Record<string, unknown>,
  listeners: [] as ((changes: Record<string, unknown>, area: string) => void)[],
  requests: [] as Record<string, unknown>[],
  getHook: undefined as undefined | (() => Promise<void>),
  setHook: undefined as undefined | (() => Promise<void>),
  send: undefined as undefined | ((r: Record<string, unknown>) => Promise<unknown>),
  tabSend: undefined as undefined | ((r: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    get: async (key: string) => { if (key === 'settings') await env.getHook?.(); return { [key]: structuredClone(env.stored[key]) }; },
    set: async (o: Record<string, unknown>) => { const frozen = structuredClone(o); await env.setHook?.(); Object.assign(env.stored, frozen); },
  }, onChanged: { addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => env.listeners.push(fn) } },
  runtime: { getManifest: () => ({ version: '0.1.0' }), getURL: (path: string) => `https://extension.invalid${path}`, sendMessage: async (r: Record<string, unknown>) => {
    env.requests.push(structuredClone(r));
    if (env.send) return env.send(r);
    if (r.type === 'cache-count') return { count: 0 };
    if (r.type === 'pack-list') return { ok: true, index: [] };
    return {};
  } },
  tabs: { query: async () => [{ id: 1, url: 'https://app.example.com/' }], sendMessage: async (_id: number, r: Record<string, unknown>) => env.tabSend?.(r) ?? null },
  commands: { getAll: async () => [] },
} }));

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
const input = (name: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`)!;
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); };
const navigate = async (hash: string) => { history.replaceState(null, '', hash); window.dispatchEvent(new Event('hashchange')); await flush(); };
const changes = async (key: string) => { for (const fn of env.listeners) fn({ [key]: { newValue: env.stored[key] } }, 'local'); await vi.advanceTimersByTimeAsync(210); await flush(); };

let registered: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  env.stored = { settings: structuredClone(DEFAULT_SETTINGS) };
  env.listeners = []; env.requests = []; env.getHook = env.setHook = undefined; env.send = env.tabSend = undefined;
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  registered = [];
  for (const target of [document, window]) {
    const real = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((event, fn, opts) => { registered.push({ target, type: event, fn, options: opts }); real(event, fn, opts); });
  }
});
afterEach(() => {
  for (const item of registered) item.target.removeEventListener(item.type, item.fn, item.options);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function options() {
  history.replaceState(null, '', '/options.html#/config/providers');
  await import('../entrypoints/options/main'); await flush();
}

function sitesBackend() {
  const a = emptyPack('a.example.com', 'ja'), b = emptyPack('b.example.com', 'ja');
  a.site.name = 'Site A'; b.site.name = 'Site B';
  const packs = new Map([[a.id, a], [b.id, b]]);
  const pending = new Map<string, PendingView[]>([[a.id, [candidate('Settings')]], [b.id, [candidate('Help')]]]);
  let intercept: ((r: PackRequest) => Promise<PackResponse> | undefined) | undefined;
  env.send = async (raw) => {
    const r = raw as unknown as PackRequest;
    const intercepted = intercept?.(r); if (intercepted) return intercepted;
    if (r.type === 'pack-list') return { ok: true, index: [...packs.values()].map((p) => toIndexItem(p, true)) };
    if (r.type === 'pack-get') return { ok: true, pack: structuredClone(packs.get(r.id)) };
    if (r.type === 'pack-pending-get') return { ok: true, pending: structuredClone(pending.get(r.id) ?? []) };
    if (r.type === 'pack-job-get') return { ok: true };
    if (r.type === 'pack-scan-status') return { ok: true, scan: { running: false } };
    if (r.type === 'pack-update') { const pack = applyPackPatch(packs.get(r.id)!, r.patch); packs.set(r.id, pack); return { ok: true, pack: structuredClone(pack) }; }
    if (r.type === 'pack-pending-clear' && r.keys) { pending.set(r.id, pending.get(r.id)!.filter((p) => !r.keys!.includes(p.key))); }
    return { ok: true };
  };
  return { a, b, packs, pending, intercept: (fn: typeof intercept) => { intercept = fn; } };
}
function candidate(src: string): PendingView { return { key: `text\u0001${src}`, kind: 'text', src, region: 'auto', flags: [], tier: 'high', count: 1, lastSeen: 1 }; }
async function sites(id: string, tab = 'review') { history.replaceState(null, '', `/sites.html#/site/${encodeURIComponent(id)}/${tab}`); await import('../entrypoints/sites/main'); await flush(); }
const plan = (id: string) => ({ ok: true as const, plan: { planId: id, messages: [], items: 1, destination: { name: 'Provider', model: 'm', baseURL: 'https://api.example.com' }, estimate: '0' } });

describe('Options save and pointer regressions', () => {
  it.each(['blur', 'contextmenu', 'dragend', 'watchdog'])('flushes a deferred options render after a lost pointer release via %s', async (ending) => {
    await options();
    document.querySelector<HTMLButtonElement>('[data-focus="prov-toggle:deepseek"]')!.click();
    const model = document.querySelector<HTMLInputElement>('.op-prov-open input[list]')!;
    type(model, 'custom-model');
    const save = button('保存');
    save.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    model.dispatchEvent(new Event('change', { bubbles: true }));
    expect(save.isConnected).toBe(true);
    if (ending === 'watchdog') await vi.advanceTimersByTimeAsync(1501);
    else {
      (ending === 'blur' ? window : document).dispatchEvent(new Event(ending, { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(save.isConnected).toBe(false);
    expect(document.querySelector<HTMLInputElement>('.op-prov-open input[list]')!.value).toBe('custom-model');
  });
  it('merges remote provider changes and keeps edits during both read and write dirty', async () => {
    await options();
    document.querySelector<HTMLButtonElement>('[data-focus="prov-toggle:deepseek"]')!.click();
    const key = input('DeepSeek API Key');
    type(key, 'first');
    const read = deferred<void>(), write = deferred<void>();
    env.getHook = () => read.promise;
    env.setHook = () => write.promise;
    button('保存').click(); await flush();
    type(key, 'during-read');
    const remote = env.stored.settings as Settings;
    remote.providers.find((p) => p.id === 'deepseek')!.detectedRegion = 'global';
    remote.providers.find((p) => p.id === 'anthropic')!.apiKey = 'remote';
    read.resolve(); await flush();
    type(key, 'during-write');
    write.resolve(); await flush();
    const written = env.stored.settings as Settings;
    expect(written.providers.find((p) => p.id === 'deepseek')).toMatchObject({ apiKey: 'first', detectedRegion: 'global' });
    expect(written.providers.find((p) => p.id === 'anthropic')!.apiKey).toBe('remote');
    expect(input('DeepSeek API Key').value).toBe('during-write');
    expect(document.getElementById('op-dirty')!.textContent).toBe('有未保存的更改');
    env.getHook = env.setHook = undefined;
    button('保存').click(); await flush();
    expect((env.stored.settings as Settings).providers.find((p) => p.id === 'deepseek')!.apiKey).toBe('during-write');
  });

  it('keeps the pressed Save button alive through a model input change until the click completes', async () => {
    await options();
    document.querySelector<HTMLButtonElement>('[data-focus="prov-toggle:deepseek"]')!.click();
    const model = document.querySelector<HTMLInputElement>('input[list="models-deepseek"]') ?? document.querySelector<HTMLInputElement>('.op-prov-open input[list]')!;
    type(model, 'custom-model');
    const save = button('保存');
    save.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    model.dispatchEvent(new Event('change', { bubbles: true }));
    expect(save.isConnected).toBe(true);
    save.dispatchEvent(new Event('pointerup', { bubbles: true }));
    save.click(); await flush();
    expect((env.stored.settings as Settings).providers.find((p) => p.id === 'deepseek')!.model).toBe('custom-model');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('op-dirty')!.textContent).toBe('所有更改已保存');
  });
});

describe('workbench asynchronous state', () => {
  it.each(['overview', 'history'])('shows a report refusal on %s without claiming completion or partial restoration', async (tab) => {
    const api = sitesBackend();
    api.intercept((r) => r.type === 'pack-scan-status' ? Promise.resolve({ ok: true, scan: {
      running: false,
      last: { at: 1, report: { refused: 'draft', visited: [], skipped: [], actions: 0, ms: 0, restore: 'partial', unrestored: [], strings: 0, content: 0 } },
    } }) : undefined);
    await sites(api.a.id, tab);
    expect(document.body.textContent).toContain('页面或窗口里可能有未保存的修改（先保存或关闭它）');
    expect(document.body.textContent).not.toMatch(/扫描已完成|部分恢复|已恢复原状/);
  });
  it('drops an older load after A → B → A navigation', async () => {
    const api = sitesBackend();
    const old = deferred<PackResponse>();
    let held = false;
    api.intercept((r) => { if (r.type === 'pack-get' && r.id === api.a.id && !held) { held = true; return old.promise; } });
    await sites(api.a.id);
    await navigate(`#/site/${api.b.id}/review`);
    expect(document.querySelector('h1')!.textContent).toContain('Site B');
    await navigate(`#/site/${api.a.id}/review`);
    old.resolve({ ok: true, pack: { ...api.a, site: { ...api.a.site, name: 'Stale A' } } }); await flush();
    expect(document.querySelector('h1')!.textContent).toContain('Site A');
    expect(document.querySelector('h1')!.textContent).not.toContain('Stale');
  });

  it('keeps settings drafts per site and saves only changes from their original base', async () => {
    const api = sitesBackend();
    await sites(api.a.id, 'settings');
    type(input('名称'), 'Local name');
    api.packs.set(api.a.id, { ...api.a, site: { ...api.a.site, description: 'Remote description' } });
    await navigate(`#/site/${api.b.id}/settings`);
    await navigate(`#/site/${api.a.id}/settings`);
    expect(input('名称').value).toBe('Local name');
    button('保存设置').click(); await flush();
    expect(env.requests.find((r) => r.type === 'pack-update')!.patch).toEqual({ name: 'Local name' });
    expect(api.packs.get(api.a.id)!.site.description).toBe('Remote description');
  });

  it('finishes a successful settings save after a newer storage reload without restoring stale response fields', async () => {
    const api = sitesBackend();
    await sites(api.a.id, 'settings');
    type(input('名称'), 'Committed name');
    const saved = deferred<PackResponse>();
    let oldResponse: PackResponse | undefined;
    api.intercept((r) => {
      if (r.type !== 'pack-update') return;
      const committed = applyPackPatch(api.packs.get(r.id)!, r.patch);
      oldResponse = { ok: true, pack: structuredClone(committed) };
      api.packs.set(r.id, { ...committed, site: { ...committed.site, description: 'Newer remote description' } });
      return saved.promise;
    });
    button('保存设置').click(); await flush();
    await changes(`pack:${api.a.id}`);
    saved.resolve(oldResponse!); await flush();
    expect(input('名称').value).toBe('Committed name');
    expect(input('应用描述').value).toBe('Newer remote description');
    const before = env.requests.filter((r) => r.type === 'pack-update').length;
    button('保存设置').click(); await flush();
    expect(env.requests.filter((r) => r.type === 'pack-update')).toHaveLength(before);
  });

  it('ignores an old-site change response without clearing the new site draft or navigating it', async () => {
    const api = sitesBackend();
    await sites(api.a.id, 'settings');
    type(input('名称'), 'A draft');
    const old = deferred<PackResponse>();
    api.intercept((r) => r.type === 'pack-update' && r.id === api.a.id ? old.promise : undefined);
    button('保存设置').click(); await flush();
    await navigate(`#/site/${api.b.id}/settings`);
    type(input('名称'), 'B draft');
    old.resolve({ ok: true, pack: { ...api.a, site: { ...api.a.site, name: 'A draft' } } }); await flush();
    expect(input('名称').value).toBe('B draft');
    expect(document.querySelector('h1')!.textContent).toContain('Site B');
  });

  it('does not include candidates that arrived while redraw is deferred in a bulk action', async () => {
    const api = sitesBackend();
    await sites(api.a.id);
    input('应用描述').focus();
    api.pending.get(api.a.id)!.push(candidate('New candidate'));
    await changes(`pending:${api.a.id}`);
    expect(document.querySelectorAll('.st-item')).toHaveLength(1);
    vi.stubGlobal('confirm', () => true);
    button('移除所选').click(); await flush();
    const sent = env.requests.find((r) => r.type === 'pack-pending-clear')!;
    expect(sent.keys).toEqual([candidate('Settings').key]);
  });

  it('flushes a deferred redraw after pointer cancellation and selects new candidates only when shown', async () => {
    const api = sitesBackend();
    await sites(api.a.id);
    const description = input('应用描述');
    description.focus();
    api.pending.get(api.a.id)!.push(candidate('New candidate'));
    await changes(`pending:${api.a.id}`);
    expect(document.querySelectorAll('.st-item')).toHaveLength(1);
    const translate = [...document.querySelectorAll('button')].find((b) => /翻译已选的/.test(b.textContent!))!;
    const preview = deferred<PackResponse>();
    api.intercept((r) => r.type === 'pack-plan' ? preview.promise : undefined);
    translate.click(); await flush();
    expect(env.requests.filter((r) => r.type === 'pack-plan').at(-1)!.keys).toEqual([candidate('Settings').key]);
    description.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    description.blur();
    await vi.advanceTimersByTimeAsync(130);
    expect(document.querySelectorAll('.st-item')).toHaveLength(1);
    document.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(130);
    expect(document.querySelectorAll('.st-item')).toHaveLength(2);
    expect([...document.querySelectorAll<HTMLInputElement>('.st-item input')].every((el) => el.checked)).toBe(true);
    preview.resolve(plan('old')); await flush();
    expect(button('确认发送并生成')).toBeUndefined();
  });

  it('restores manual review choices while applying defaults only to new visible candidates', async () => {
    const api = sitesBackend();
    await sites(api.a.id);
    const checkbox = document.querySelector<HTMLInputElement>('.st-item input')!;
    checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await navigate(`#/site/${api.b.id}/review`);
    api.pending.get(api.a.id)!.push(candidate('New candidate'));
    await navigate(`#/site/${api.a.id}/review`);
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.st-item input')];
    expect(boxes.map((el) => el.checked)).toEqual([false, true]);
  });

  it('rejects a generation or description preview when the description changed before it returned', async () => {
    const api = sitesBackend();
    await sites(api.a.id);
    const old = deferred<PackResponse>();
    api.intercept((r) => r.type === 'pack-plan' ? old.promise : undefined);
    [...document.querySelectorAll('button')].find((b) => /翻译已选的/.test(b.textContent!))!.click(); await flush();
    type(input('应用描述'), 'New description');
    old.resolve(plan('old')); await flush();
    expect(button('确认发送并生成')).toBeUndefined();
    const description = deferred<PackResponse>();
    api.intercept((r) => r.type === 'pack-describe-plan' ? description.promise : undefined);
    button('根据已选文字起草描述…').click(); await flush();
    type(input('应用描述'), 'Newer description');
    description.resolve(plan('old-description')); await flush();
    expect(button('确认发送')).toBeUndefined();
    expect(input('应用描述').value).toBe('Newer description');
  });

  it('accepts an unchanged preview and limits translation selection to the visible filter', async () => {
    const api = sitesBackend();
    api.pending.get(api.a.id)!.push({ ...candidate('Possible name'), tier: 'uncertain', flags: ['possible-name'] });
    await sites(api.a.id);
    api.intercept((r) => r.type === 'pack-plan' ? Promise.resolve(plan('current')) : undefined);
    [...document.querySelectorAll('button')].find((b) => /翻译已选的/.test(b.textContent!))!.click(); await flush();
    expect(button('确认发送并生成')).toBeDefined();
    [...document.querySelectorAll('button')].find((b) => b.textContent!.startsWith('需要留意'))!.click(); await flush();
    const checkbox = document.querySelector<HTMLInputElement>('.st-item input')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => /翻译已选的/.test(b.textContent!))!.click(); await flush();
    expect(env.requests.filter((r) => r.type === 'pack-plan').at(-1)!.keys).toEqual([candidate('Possible name').key]);
  });
});

describe('popup render ownership', () => {
  it('retries the same render key after an exception', async () => {
    env.tabSend = async () => ({ lang: 'en', enabled: false, estimate: 1, expertOverride: '', stats: { segments: 0, done: 0, errors: 0, pending: 0 } });
    env.send = async (r) => r.type === 'pack-list' ? { ok: true, index: [] } : {};
    history.replaceState(null, '', '/popup.html');
    const popup = await import('../entrypoints/popup/main'); await flush();
    env.tabSend = async () => ({ lang: 'ja', enabled: false, estimate: 1, expertOverride: '', stats: { segments: 0, done: 0, errors: 0, pending: 0 } });
    const replace = vi.spyOn(document.getElementById('app')!, 'replaceChildren').mockImplementationOnce(() => { throw new Error('render failure'); });
    await expect(popup.refresh(undefined, true)).rejects.toThrow('render failure');
    const before = env.requests.filter((r) => r.type === 'pack-list').length;
    await popup.refresh();
    expect(env.requests.filter((r) => r.type === 'pack-list')).toHaveLength(before + 1);
    replace.mockRestore();
    expect(document.querySelector('.pp-pack')).not.toBeNull();
  });
  it('does not clear a newer render key when an older render throws late', async () => {
    let lang = 'en';
    env.tabSend = async () => ({ lang, enabled: false, estimate: 1, expertOverride: '', stats: { segments: 0, done: 0, errors: 0, pending: 0 } });
    env.send = async (r) => r.type === 'pack-list' ? { ok: true, index: [] } : {};
    history.replaceState(null, '', '/popup.html');
    const popup = await import('../entrypoints/popup/main'); await flush();
    const old = deferred<unknown>(), next = deferred<unknown>();
    lang = 'ja';
    env.send = async (r) => r.type === 'pack-list' ? old.promise : {};
    const previous = popup.refresh(undefined, true); await flush();
    lang = 'fr';
    env.send = async (r) => r.type === 'pack-list' ? next.promise : {};
    const current = popup.refresh(undefined, true); await flush();
    const real = HTMLElement.prototype.setAttribute;
    const attr = vi.spyOn(HTMLElement.prototype, 'setAttribute').mockImplementation(function (this: HTMLElement, name, value) {
      if (name === 'role' && value === 'tabpanel') throw new Error('old render failure');
      return real.call(this, name, value);
    });
    const rejected = expect(previous).rejects.toThrow('old render failure');
    old.resolve({ ok: true, index: [] }); await rejected;
    attr.mockRestore();
    const count = env.requests.filter((r) => r.type === 'pack-list').length;
    await popup.refresh();
    expect(env.requests.filter((r) => r.type === 'pack-list')).toHaveLength(count);
    next.resolve({ ok: true, index: [] }); await current;
    expect(document.querySelector('.pp-pack')).not.toBeNull();
  });
  it('keeps the latest tab DOM and cache when a localization card finishes late', async () => {
    localStorage.setItem('translucid.popup.tab', 'page');
    env.tabSend = async (r) => r.type === 'get-state' ? { lang: 'en', enabled: false, estimate: 1, expertOverride: '', stats: { segments: 0, done: 0, errors: 0, pending: 0 } } : null;
    const old = deferred<unknown>();
    env.send = async (r) => r.type === 'pack-list' ? old.promise : r.type === 'pack-scan-status' ? { ok: true, scan: { running: false } } : r.type === 'pack-pending-get' ? { ok: true, pending: [] } : {};
    history.replaceState(null, '', '/popup.html');
    await import('../entrypoints/popup/main'); await flush();
    document.getElementById('pp-tab-site')!.click(); await flush();
    document.getElementById('pp-tab-page')!.click(); await flush();
    old.resolve({ ok: true, index: [] }); await flush();
    expect(document.getElementById('pp-panel')!.getAttribute('aria-labelledby')).toBe('pp-tab-page');
    expect(document.querySelector('.pp-big')!.textContent).toContain('翻译此页');
    expect(document.querySelector('.pp-pack')).toBeNull();
    await vi.advanceTimersByTimeAsync(850);
    expect(document.querySelector('.pp-big')!.textContent).toContain('翻译此页');
  });
  it('allows a slow localization render to finish despite repeated 800 ms polls', async () => {
    env.tabSend = async (r) => r.type === 'get-state' ? { lang: 'en', enabled: false, estimate: 1, expertOverride: '', stats: { segments: 0, done: 0, errors: 0, pending: 0 } } : null;
    const old = deferred<unknown>();
    env.send = async (r) => r.type === 'pack-list' ? old.promise : r.type === 'pack-scan-status' ? { ok: true, scan: { running: false } } : r.type === 'pack-pending-get' ? { ok: true, pending: [] } : {};
    history.replaceState(null, '', '/popup.html');
    await import('../entrypoints/popup/main'); await flush();
    // Initial render precedes main's poll installation; switch from an already rendered page.
    old.resolve({ ok: true, index: [] }); await flush();
    document.getElementById('pp-tab-page')!.click(); await flush();
    const slow = deferred<unknown>();
    env.send = async (r) => r.type === 'pack-list' ? slow.promise : r.type === 'pack-scan-status' ? { ok: true, scan: { running: false } } : r.type === 'pack-pending-get' ? { ok: true, pending: [] } : {};
    document.getElementById('pp-tab-site')!.click(); await flush();
    const before = env.requests.filter((r) => r.type === 'pack-list').length;
    await vi.advanceTimersByTimeAsync(2500);
    expect(env.requests.filter((r) => r.type === 'pack-list')).toHaveLength(before);
    slow.resolve({ ok: true, index: [] }); await flush();
    expect(document.getElementById('pp-panel')!.getAttribute('aria-labelledby')).toBe('pp-tab-site');
    expect(document.querySelector('.pp-pack')).not.toBeNull();
  });

});
