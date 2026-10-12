import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/prompt/assemble';

// In-memory storage.local shared by the store, pending pool and jobs.
const store = new Map<string, unknown>();
/** Test hooks: called on every storage write (may block it). */
let onSet: ((o: Record<string, unknown>) => void | Promise<void>) | undefined;
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (k: string | null) =>
          k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: structuredClone(store.get(k)) } : {},
        set: async (o: Record<string, unknown>) => {
          await onSet?.(o);
          for (const [k, v] of Object.entries(o)) store.set(k, structuredClone(v));
        },
        remove: async (k: string | string[]) => {
          for (const x of [k].flat()) store.delete(x);
        },
      },
    },
  },
}));
vi.mock('../src/background/pack-registry', () => ({ syncRegistrations: async () => {}, injectIntoOpenTabs: async () => {} }));
vi.mock('../src/background/usage', () => ({ recordUsage: () => {} }));

// Scripted model: translate every segment as "译:" + source, unless a test overrides it.
let reply: (segs: string[]) => string = (segs) => segs.map((s, i) => `<${i + 1}>译:${s}</${i + 1}>`).join('');
let calls: string[][] = [];
let prompts: string[] = [];
let gate: Promise<void> | undefined;
let describeCalls: ChatMessage[][] = [];
vi.mock('../src/background/providers', async (orig) => {
  const real = await orig<typeof import('../src/background/providers')>();
  return {
    ...real,
    async completeChat(_p: unknown, messages: ChatMessage[]) {
      describeCalls.push(messages);
      return { text: 'A chat assistant.', usage: { promptTokens: 1, cacheHitTokens: 0, completionTokens: 1 } };
    },
    async *streamChat(_p: unknown, messages: ChatMessage[]) {
      const segs = [...messages[1]!.content.matchAll(/<(\d+)>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
      calls.push(segs);
      prompts.push(messages[1]!.content);
      if (gate) await gate;
      yield reply(segs);
    },
  };
});

const { emptyPack, entryKey } = await import('../src/pack/format');
const { savePack, getPack, deletePack } = await import('../src/background/pack-store');
const { addCandidates } = await import('../src/background/pack-pending');
const { commit, createDescribePlan, createPlan, getJob, parseStrict, pauseInterruptedJobs, resumeJob, runDescribePlan, runJob, startJob, cancelJob } = await import('../src/background/pack-gen');
const { DEFAULT_SETTINGS } = await import('../src/shared/settings');

const settings = { ...DEFAULT_SETTINGS, providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, apiKey: 'k' })) };
const ID = 'app.example.com~ja';

async function seed(srcs: string[]) {
  const base = emptyPack('app.example.com', 'ja');
  const { pack } = await savePack({ ...base, regions: [{ id: 'r1', label: 'Sidebar', selector: 'nav' }] });
  await addCandidates(pack, srcs.map((src) => ({ kind: 'text' as const, src, region: 'r1', flags: [], tier: 'high' as const })));
  return srcs.map((s) => entryKey('text', s));
}

/** Preview, then confirm that preview (the only way to start a job). */
async function go(keys: string[], description: string, s = settings) {
  const plan = await createPlan({ packId: ID, keys, description }, s);
  return startJob(ID, plan.planId, s);
}

const settle = async (done: string[] = ['paused', 'done', 'cancelled', 'failed']) => {
  for (let i = 0; i < 50; i++) {
    const j = await getJob(ID);
    if (j && done.includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  return getJob(ID);
};

beforeEach(() => {
  store.clear();
  calls = [];
  prompts = [];
  gate = undefined;
  onSet = undefined;
  describeCalls = [];
  reply = (segs) => segs.map((s, i) => `<${i + 1}>译:${s}</${i + 1}>`).join('');
});

describe('parseStrict', () => {
  it('keeps closed tags in range and rejects duplicated ids', () => {
    const m = parseStrict('<1>A</1><2>B</2><2>B2</2><3>C</3><9>X</9><4>trunc', 4);
    expect([...m]).toEqual([
      [1, 'A'],
      [3, 'C'],
    ]);
  });
});

describe('generation jobs', () => {
  it('translates approved strings only, merges them and clears them from pending', async () => {
    const keys = await seed(['New chat', 'Settings', 'Mira private title']);
    await go(keys.slice(0, 2), 'Chat app');
    const job = await settle();
    expect(job!.state).toBe('done');
    expect(calls.flat()).toEqual(['New chat', 'Settings']);
    const pack = await getPack(ID);
    expect(pack!.entries.map((e) => [e.src, e.t])).toEqual([
      ['New chat', '译:New chat'],
      ['Settings', '译:Settings'],
    ]);
    expect(pack!.site.description).toBe('Chat app');
    const pending = store.get(`pending:${ID}`) as Record<string, unknown>;
    expect(Object.keys(pending)).toEqual([entryKey('text', 'Mira private title')]);
  });

  it('retries missing or invalid strings in smaller batches, then reports failures', async () => {
    const keys = await seed(['One', 'Two', '{n} files', 'Four']);
    // First reply drops "Two" and breaks the placeholder; the retries answer correctly except "{n} files".
    reply = (segs) => segs.map((s, i) => (s === 'Two' && calls.length === 1 ? '' : `<${i + 1}>${s === '{n} files' ? '文件' : `译:${s}`}</${i + 1}>`)).join('');
    await go(keys, '');
    const job = await settle();
    expect(job!.state).toBe('done');
    const pack = await getPack(ID);
    expect(pack!.entries.map((e) => e.src).sort()).toEqual(['Four', 'One', 'Two']);
    expect(job!.failed.map((i) => job!.snapshot.items[i]!.src)).toEqual(['{n} files']);
  });

  it('never overwrites an entry the user edited meanwhile', async () => {
    const keys = await seed(['Settings']);
    const pack = (await getPack(ID))!;
    await savePack({ ...pack, entries: [{ kind: 'text', src: 'Settings', t: '設定（手動）', status: 'edited' }] });
    await go(keys, '');
    await settle();
    expect((await getPack(ID))!.entries).toEqual([expect.objectContaining({ src: 'Settings', t: '設定（手動）', status: 'edited' })]);
  });

  it('stops when the pack is deleted during generation', async () => {
    const keys = await seed(['A label', 'B label']);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await go(keys, '');
    await new Promise((r) => setTimeout(r, 5));
    await deletePack(ID);
    release();
    const job = await settle();
    expect(job!.state).toBe('cancelled');
    expect(await getPack(ID)).toBeUndefined();
  });

  it('pauses after a worker restart and resumes only when asked; cancel ends it', async () => {
    const keys = await seed(['Alpha', 'Beta']);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await go(keys, '');
    // Simulate a restart: the stored job says running, but this "new worker" runs nothing.
    const stored = (await getJob(ID))!;
    store.set(`job:${ID}`, { ...stored, state: 'running' });
    release();
    await settle();
    store.set(`job:${ID}`, { ...stored, state: 'running', results: {}, batches: stored.batches.map((b) => ({ ...b, status: 'pending' })) });
    await pauseInterruptedJobs();
    expect((await getJob(ID))!.state).toBe('paused');
    await resumeJob(ID, settings);
    expect((await settle(['done', 'failed']))!.state).toBe('done');

    store.set(`job:${ID}`, { ...stored, state: 'paused' });
    await cancelJob(ID);
    expect((await getJob(ID))!.state).toBe('cancelled');
    await expect(resumeJob(ID, settings)).rejects.toThrow();
    await runJob(ID, settings); // a cancelled job never runs again
    expect((await getJob(ID))!.state).toBe('cancelled');
  });

  it('refuses a second job while one is unfinished, and machine translation as provider', async () => {
    const keys = await seed(['Alpha']);
    store.set(`job:${ID}`, { state: 'paused', packId: ID });
    await expect(go(keys, '')).rejects.toThrow('未完成');
    store.delete(`job:${ID}`);
    const mtOnly = { ...settings, activeProviderId: 'google-translate', providers: settings.providers.map((p) => (p.vendor === 'google-translate' ? p : { ...p, apiKey: '' })) };
    await expect(go(keys, '', mtOnly)).rejects.toThrow('机翻');
  });

  it('runs only the frozen preview: forged, reused, expired or drifted plans are refused', async () => {
    const keys = await seed(['Alpha', 'Beta']);
    await expect(startJob(ID, 'forged', settings)).rejects.toThrow('预览已失效');
    const plan = await createPlan({ packId: ID, keys: keys.slice(0, 1), description: '' }, settings);
    // The main provider changed after the preview: the destination is no longer what was shown.
    const other = settings.providers.find((p) => p.id !== settings.activeProviderId && p.vendor !== 'google-translate' && p.vendor !== 'microsoft-translator')!;
    await expect(startJob(ID, plan.planId, { ...settings, activeProviderId: other.id })).rejects.toThrow('服务商设置已更改');
    // A changed selection is invisible to the frozen plan: only the previewed string is sent.
    await startJob(ID, plan.planId, settings);
    await settle();
    expect(calls.flat()).toEqual(['Alpha']);
    await expect(startJob(ID, plan.planId, settings)).rejects.toThrow('预览已失效'); // one-shot
    const stale = await createPlan({ packId: ID, keys, description: '' }, settings);
    store.set(`plan:${ID}`, { ...(store.get(`plan:${ID}`) as object), createdAt: Date.now() - 2 * 3600_000 });
    await expect(startJob(ID, stale.planId, settings)).rejects.toThrow('预览已失效');
  });

  it('drops a response that arrives after cancel', async () => {
    const keys = await seed(['Late one']);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await go(keys, '');
    await new Promise((r) => setTimeout(r, 5));
    await cancelJob(ID);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect((await getJob(ID))!.state).toBe('cancelled');
    expect((await getPack(ID))!.entries).toEqual([]);
  });

  it('commits atomically: parallel lanes and an intervening edit all survive', async () => {
    const keys = await seed(['One', 'Two', 'Three']);
    const job = await go(keys, '');
    await settle();
    // Re-run commits for a fresh job identity concurrently with a user edit.
    store.set(`job:${ID}`, { ...job, state: 'running' });
    const edit = (async () => {
      const { mutatePack } = await import('../src/background/pack-store');
      await mutatePack(ID, (p) => ({ ...p, entries: [...p.entries.filter((e) => e.src !== 'Two'), { kind: 'text', src: 'Two', t: '二（手動）', status: 'edited' }] }));
    })();
    await Promise.all([
      commit(job, new Map([[0, '一']]), 'm'),
      edit,
      commit(job, new Map([[1, '二'], [2, '三']]), 'm'),
    ]);
    const t = Object.fromEntries((await getPack(ID))!.entries.map((e) => [e.src, e.t]));
    expect(t).toEqual({ One: '一', Two: '二（手動）', Three: '三' });
    // A different job identity is stale: nothing is merged.
    expect(await commit({ ...job, jobId: 'other' }, new Map([[0, 'X']]), 'm')).toBe('stale');
  });

  it('stores context variants from structured items', async () => {
    const keys = await seed(['Medium']);
    const job = await go(keys, '');
    await settle();
    const ctxJob = {
      ...job,
      snapshot: { ...job.snapshot, items: [
        { kind: 'text' as const, src: 'Medium', region: 'r1', area: 'x', ctx: 'g:size1' },
        { kind: 'text' as const, src: 'Medium', region: 'r1', area: 'x', ctx: 'g:wid22' },
      ] },
    };
    store.set(`job:${ID}`, { ...ctxJob, state: 'running' });
    await commit(ctxJob, new Map([[0, '中'], [1, '适中']]), 'm');
    const entries = (await getPack(ID))!.entries.filter((e) => e.src === 'Medium').map((e) => [e.ctx, e.t]).sort();
    // The earlier generic translation (contexts unknown) stays as the fallback for unseen contexts.
    expect(entries).toEqual(expect.arrayContaining([['g:size1', '中'], ['g:wid22', '适中'], [undefined, '译:Medium']]));
    expect(entries).toHaveLength(3);
  });

  it('retries a missing answer together with its question, ids in reading order', async () => {
    const { pack } = await savePack(emptyPack('app.example.com', 'ja'));
    const w = (role: string) => ({ surface: 'dialog: Settings', section: 'Account', group: 'What best describes your work?', groupRole: 'select', role });
    await addCandidates(pack, [
      { kind: 'text', src: 'Theme', region: 'auto', flags: [], tier: 'high', ctx: 's:them1', where: { surface: 'dialog: Settings', role: 'heading' } },
      { kind: 'text', src: 'Engineering', region: 'auto', flags: [], tier: 'high', ctx: 'g:work1', where: w('value') },
      { kind: 'text', src: 'What best describes your work?', region: 'auto', flags: [], tier: 'high', ctx: 'g:work1', where: w('label') },
    ]);
    const { pendingKey } = await import('../src/background/pack-pending');
    const keys = Object.values(store.get(`pending:${ID}`) as Record<string, Parameters<typeof pendingKey>[0]>).map(pendingKey);
    reply = (segs) => segs.map((x, i) => (x === 'Engineering' && calls.length === 1 ? '' : `<${i + 1}>译:${x}</${i + 1}>`)).join('');
    await go(keys, '');
    expect((await settle())!.state).toBe('done');
    // First request: ids read top to bottom, the question is the group line.
    const ids = [...prompts[0]!.matchAll(/<(\d+)>/g)].map((m) => Number(m[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(prompts[0]).toMatch(/select <\d+>What best describes your work\?<\/\d+>/);
    // The retry asks only for Engineering, with its question quoted as context.
    expect(calls[1]).toEqual(['Engineering']);
    expect(prompts[1]).toContain('select "What best describes your work?"');
    const after = (await getPack(ID))!;
    expect(after.entries.find((e) => e.src === 'Engineering')!.t).toBe('译:Engineering');
    expect(after.contexts[entryKey('text', 'Engineering')]).toEqual(['g:work1']);
    expect(store.get(`pending:${ID}`)).toEqual({});
  });

  it('never checkpoints a batch as done before its strings are in the pack (parallel lanes)', async () => {
    const srcs = Array.from({ length: 300 }, (_, i) => `Label number ${i}`);
    const keys = await seed(srcs);
    const lanes = { ...settings, providers: settings.providers.map((p) => (p.id === settings.activeProviderId ? { ...p, concurrency: 4 } : p)) };
    let checked = 0;
    // Every job checkpoint: whatever it calls done must already be in the stored pack.
    onSet = async (o) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      const job = o[`job:${ID}`] as { batches: { ids: number[]; status: string }[]; snapshot: { items: { src: string }[] } } | undefined;
      if (!job) return;
      const have = new Set(((store.get(`pack:${ID}`) as { entries: { src: string }[] }).entries ?? []).map((e) => e.src));
      for (const b of job.batches) if (b.status === 'done') for (const i of b.ids) expect(have.has(job.snapshot.items[i]!.src)).toBe(true);
      checked++;
    };
    await go(keys, '', lanes);
    const job = await settle(['done', 'failed']);
    expect(job!.state).toBe('done');
    expect(job!.batches.length).toBeGreaterThanOrEqual(3);
    expect(checked).toBeGreaterThan(3);
    expect((await getPack(ID))!.entries).toHaveLength(300);
  });

  it('once cancel returns, the old job can no longer write', async () => {
    const keys = await seed(['One', 'Two']);
    const job = await go(keys, '');
    await settle();
    store.set(`job:${ID}`, { ...job, state: 'running' });
    // The commit is mid-write (pack write blocked) when the user cancels.
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    onSet = async (o) => {
      if (`pack:${ID}` in o) await blocked;
    };
    const order: string[] = [];
    const c1 = commit(job, new Map([[0, 'X1']]), 'm').then((r) => order.push(`commit:${r}`));
    await new Promise((r) => setTimeout(r, 5));
    const cancel = cancelJob(ID).then(() => order.push('cancelled'));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]); // cancel waits for the commit that already passed its check
    release();
    await Promise.all([c1, cancel]);
    expect(order).toEqual(['commit:ok', 'cancelled']);
    onSet = undefined;
    expect(await commit(job, new Map([[1, 'X2']]), 'm')).toBe('stale');
    expect((await getPack(ID))!.entries.find((e) => e.src === 'Two')?.t).not.toBe('X2');
  });

  it('a preview is bound to the destination itself, not just the provider id', async () => {
    const keys = await seed(['Alpha']);
    const plan = await createPlan({ packId: ID, keys, description: '' }, settings);
    const moved = { ...settings, providers: settings.providers.map((p) => (p.id === plan.providerId ? { ...p, baseURL: 'https://elsewhere.example.com/v1' } : p)) };
    await expect(startJob(ID, plan.planId, moved)).rejects.toThrow('服务商设置已更改');
    // A job whose provider changed model after the start pauses instead of sending elsewhere.
    const plan2 = await createPlan({ packId: ID, keys, description: '' }, settings);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await startJob(ID, plan2.planId, settings);
    await new Promise((r) => setTimeout(r, 5));
    const stored = (await getJob(ID))!;
    release();
    await settle();
    store.set(`job:${ID}`, { ...stored, state: 'paused' });
    const remodeled = { ...settings, providers: settings.providers.map((p) => (p.id === plan2.providerId ? { ...p, model: 'other-model' } : p)) };
    await runJob(ID, remodeled);
    const after = (await getJob(ID))!;
    expect(after.state).toBe('paused');
    expect(after.error).toContain('地址或模型已更改');
  });

  it('the description draft sends exactly the previewed request, once', async () => {
    const keys = await seed(['New chat', 'Settings']);
    const { plan } = await createDescribePlan(ID, keys, settings);
    expect(JSON.stringify(plan.messages)).toContain('New chat');
    expect(describeCalls).toHaveLength(0); // previewing sends nothing
    await expect(runDescribePlan(ID, 'forged', settings)).rejects.toThrow('预览已失效');
    expect(await runDescribePlan(ID, plan.planId, settings)).toBe('A chat assistant.');
    expect(describeCalls).toEqual([plan.messages]);
    await expect(runDescribePlan(ID, plan.planId, settings)).rejects.toThrow('预览已失效');
  });
});

describe('installed data migration', () => {
  it('upgrades stored v1 packs once, keeping their authorization, and cancels unfinished v1 jobs', async () => {
    const { migrateInstalled, listPacks } = await import('../src/background/pack-store');
    const { toIndexItem, PACK_VERSION } = await import('../src/pack/format');
    const v1 = { ...emptyPack('app.example.com', 'ja'), version: 1, options: { hydration: 'after-idle' }, entries: [{ kind: 'text', src: 'Open', t: '開く', status: 'auto' }] };
    delete (v1 as Record<string, unknown>).surfaces;
    delete (v1 as Record<string, unknown>).contexts;
    store.set(`pack:${ID}`, v1);
    store.set(`packrt:${ID}`, { id: ID, map: {} });
    store.set('packIndex', [toIndexItem(v1 as never, true)]);
    store.set(`job:${ID}`, { jobId: 'old', packId: ID, state: 'paused' });
    expect(await migrateInstalled()).toBe(1);
    const pack = (await getPack(ID))!;
    expect(pack.version).toBe(PACK_VERSION);
    expect(pack.options).toEqual({ hydration: 'after-idle', learn: false, scope: 'regions' });
    expect(pack.entries).toHaveLength(1);
    expect((store.get(`packrt:${ID}`) as { scope: string }).scope).toBe('regions');
    expect((await getJob(ID))!.state).toBe('cancelled');
    expect(await migrateInstalled()).toBe(0); // idempotent
    expect((await listPacks())[0]!.enabled).toBe(true);
  });

  it('cancels old unfinished jobs even when the pack upgrade itself already happened', async () => {
    const { migrateInstalled } = await import('../src/background/pack-store');
    const { toIndexItem, toRuntime } = await import('../src/pack/format');
    const pack = emptyPack('app.example.com', 'ja');
    store.set(`pack:${ID}`, pack);
    store.set(`packrt:${ID}`, toRuntime(pack));
    store.set('packIndex', [toIndexItem(pack, true)]);
    store.set(`job:${ID}`, { jobId: 'old', packId: ID, state: 'paused' });
    expect(await migrateInstalled()).toBe(1); // legacy v2 gets a lifecycle identity
    expect((await getPack(ID))!.lifecycleId).toBeTruthy();
    expect(await migrateInstalled()).toBe(0);
    expect((await getJob(ID))!.state).toBe('cancelled');
  });

  it('deletes expired candidates from storage, not just from the view', async () => {
    const { getPending, PENDING_TTL_MS } = await import('../src/background/pack-pending');
    await seed(['Old one', 'Fresh one']);
    const raw = store.get(`pending:${ID}`) as Record<string, { lastSeen: number; src: string }>;
    for (const v of Object.values(raw)) if (v.src === 'Old one') v.lastSeen = Date.now() - PENDING_TTL_MS - 1000;
    store.set(`pending:${ID}`, raw);
    expect((await getPending(ID)).map((p) => p.src)).toEqual(['Fresh one']);
    expect(Object.values(store.get(`pending:${ID}`) as Record<string, { src: string }>).map((v) => v.src)).toEqual(['Fresh one']);
  });
});


describe('release-review generation regressions', () => {
  it('rejects contact data before acceptance, retries it and retains pending without storing it in the job', async () => {
    const keys = await seed(['Support']);
    reply = () => '<1>support@example.org</1>';
    await go(keys, '');
    const job = (await settle())!;
    expect(calls).toHaveLength(3);
    expect(job.state).toBe('failed');
    expect(job.results).toEqual({});
    expect(job.failed).toEqual([0]);
    expect(JSON.stringify(job)).not.toContain('support@example.org');
    expect((await getPack(ID))!.entries).toEqual([]);
    expect(Object.keys(store.get(`pending:${ID}`) as object)).toEqual(keys);
  });

  it('counts only translations that survived validation and were actually persisted', async () => {
    const keys = await seed(['Support']);
    await go(keys, '');
    const job = (await settle())!;
    const { mutatePack } = await import('../src/background/pack-store');
    await mutatePack(ID, (p) => ({ ...p, entries: [{ kind: 'text', src: 'Support', t: '手動', status: 'edited' }] }));
    await addCandidates({ ...(await getPack(ID))!, entries: [] }, [{ kind: 'text', src: 'Support', region: 'r1', flags: [], tier: 'high' }]);
    store.set(`job:${ID}`, { ...job, state: 'running' });
    const accepted = new Map([[0, '新しい訳']]);
    expect(await commit(job, accepted, 'm')).toBe('ok');
    expect(accepted.size).toBe(0);
    expect(Object.keys(store.get(`pending:${ID}`) as object)).toEqual(keys);
  });

  it('allocates and preserves a local lifecycle identity, ignoring imported identities', async () => {
    await seed(['Support']);
    const first = (await getPack(ID))!;
    expect(first.lifecycleId).toBeTruthy();
    const edited = (await savePack({ ...first, lifecycleId: 'forged', site: { ...first.site, name: 'Changed' } })).pack;
    expect(edited.lifecycleId).toBe(first.lifecycleId);
    await deletePack(ID);
    const recreated = (await savePack({ ...first, lifecycleId: first.lifecycleId })).pack;
    expect(recreated.lifecycleId).not.toBe(first.lifecycleId);
  });

  it('invalidates all previews on delete and refuses a restored preview from the old lifecycle', async () => {
    const keys = await seed(['Support']);
    const plan = await createPlan({ packId: ID, keys, description: '' }, settings);
    const desc = await createDescribePlan(ID, keys, settings);
    const oldDescription = store.get(`describePlan:${ID}`);
    await deletePack(ID);
    expect(store.has(`plan:${ID}`)).toBe(false);
    expect(store.has(`describePlan:${ID}`)).toBe(false);
    await seed(['Support']);
    store.set(`plan:${ID}`, plan);
    store.set(`describePlan:${ID}`, oldDescription);
    await expect(startJob(ID, plan.planId, settings)).rejects.toThrow('预览已失效');
    await expect(runDescribePlan(ID, desc.plan.planId, settings)).rejects.toThrow('预览已失效');
    expect(calls).toHaveLength(0);
    expect(describeCalls).toHaveLength(0);
  });

  it('starts a recreated pack job while an aborted old request is still outstanding', async () => {
    const keys = await seed(['Support']);
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    const old = await go(keys, '');
    await new Promise((r) => setTimeout(r, 5));
    await deletePack(ID);
    const recreatedKeys = await seed(['Settings']);
    gate = undefined;
    await go(recreatedKeys, '');
    expect((await settle())!.state).toBe('done');
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect((await getPack(ID))!.entries.map((e) => e.src)).toEqual(['Settings']);
    expect(await commit(old, new Map([[0, '遅い']]), 'm')).toBe('stale');
    expect((await getJob(ID))!.state).toBe('done');
  });

  it('consumes concurrent generation and description confirmations at most once', async () => {
    const keys = await seed(['Support']);
    const plan = await createPlan({ packId: ID, keys, description: '' }, settings);
    const starts = await Promise.allSettled([startJob(ID, plan.planId, settings), startJob(ID, plan.planId, settings)]);
    expect(starts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await settle();
    expect(calls).toHaveLength(1);
    await addCandidates({ ...(await getPack(ID))!, entries: [] }, [{ kind: 'text', src: 'Support', region: 'r1', flags: [], tier: 'high' }]);
    const desc = await createDescribePlan(ID, keys, settings);
    const drafts = await Promise.allSettled([runDescribePlan(ID, desc.plan.planId, settings), runDescribePlan(ID, desc.plan.planId, settings)]);
    expect(drafts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(describeCalls).toHaveLength(1);
  });

  it('sanitizes legacy personal skip labels using the reason, not title regexes', async () => {
    const { sanitizeReport } = await import('../src/background/pack-scan');
    const report = sanitizeReport({ skipped: [{ label: 'Budget review', reason: '指向个人内容', count: 2 }] });
    expect(report!.skipped).toEqual([{ label: '个人内容链接', reason: '指向个人内容', count: 2 }]);
    expect(JSON.stringify(report)).not.toContain('Budget');
  });

  it('preserves only recognized draft refusals in sanitized scan reports', async () => {
    const { sanitizeReport } = await import('../src/background/pack-scan');
    expect(sanitizeReport({ refused: 'draft' })!.refused).toBe('draft');
    expect(sanitizeReport({ refused: 'private free text' })!.refused).toBeUndefined();
  });
});
