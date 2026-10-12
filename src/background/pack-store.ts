// The only writer of pack data in storage.local. All mutations run through one
// queue, so concurrent saves (two tabs, an import during generation) never
// interleave, and every write bumps the pack revision.
import { browser } from 'wxt/browser';
import { PACK_VERSION, toIndexItem, toRuntime, validatePack, type PackIndexItem, type SitePack } from '../pack/format';
import { STORAGE } from '../pack/messages';
import { injectIntoOpenTabs, syncRegistrations } from './pack-registry';

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier store mutation has finished. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

// Lock order: pack operation → store queue → job/pending queues. Never acquire in reverse.
const operations = new Map<string, Promise<unknown>>();
export function packOperation<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = operations.get(id) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  const tail = next.catch(() => undefined);
  operations.set(id, tail);
  void tail.then(() => { if (operations.get(id) === tail) operations.delete(id); });
  return next;
}

const deleteHooks = new Set<(id: string) => void>();
export function onPackDelete(fn: (id: string) => void): void { deleteHooks.add(fn); }

/** Assign legacy installed packs an identity through the same store queue. */
export function ensurePackIdentity(id: string): Promise<SitePack | undefined> {
  return serial(async () => {
    const pack = await getPack(id);
    if (pack && !pack.lifecycleId) {
      pack.lifecycleId = crypto.randomUUID();
      await browser.storage.local.set({ [STORAGE.pack(id)]: pack });
    }
    return pack;
  });
}

export class RevisionConflict extends Error {}

/**
 * Run `fn` inside the store queue: nothing else reads or writes packs meanwhile.
 * Generation cancels through here, so once a cancel returns no commit of the old
 * job can still pass its "is this job current?" check.
 */
export function storeTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return serial(fn);
}

export async function listPacks(): Promise<PackIndexItem[]> {
  const r = await browser.storage.local.get(STORAGE.index);
  return (r[STORAGE.index] as PackIndexItem[] | undefined) ?? [];
}

export async function getPack(id: string): Promise<SitePack | undefined> {
  const r = await browser.storage.local.get(STORAGE.pack(id));
  return r[STORAGE.pack(id)] as SitePack | undefined;
}

async function writeIndex(index: PackIndexItem[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE.index]: index });
  await syncRegistrations(index).catch((e) => console.warn('[translucid] pack registration failed', e));
}

export interface SaveOptions {
  enabled?: boolean;
  /** Reject the save if the stored revision moved on (someone edited meanwhile). */
  expectRev?: number;
}

/**
 * Validate (again: the background trusts no caller) and store a pack, its runtime
 * form and its index entry. Returns the stored pack with its new revision.
 */
export function savePack(input: unknown, opts: SaveOptions = {}): Promise<{ pack: SitePack; warnings: string[] }> {
  return serial(async () => {
    const v = validatePack(input);
    if (!v.ok) throw new Error(v.errors.join('；'));
    const current = await getPack(v.pack.id);
    if (opts.expectRev !== undefined && (current?.rev ?? 0) !== opts.expectRev) {
      throw new RevisionConflict('语言包已被修改，请刷新后重试');
    }
    const pack = await write(v.pack, current, opts.enabled);
    return { pack, warnings: v.warnings };
  });
}

/** Store pack + runtime + index entry with the next revision (caller holds the queue). */
async function write(input: SitePack, current: SitePack | undefined, enabledOpt?: boolean, inject = true): Promise<SitePack> {
  const pack: SitePack = { ...input, lifecycleId: current?.lifecycleId || crypto.randomUUID(), rev: (current?.rev ?? input.rev) + 1 };
  const index = await listPacks();
  const prev = index.find((p) => p.id === pack.id);
  const enabled = enabledOpt ?? prev?.enabled ?? true;
  const item = toIndexItem(pack, enabled);
  const next = prev ? index.map((p) => (p.id === pack.id ? item : p)) : [...index, item];
  await browser.storage.local.set({ [STORAGE.pack(pack.id)]: pack, [STORAGE.runtime(pack.id)]: toRuntime(pack) });
  await writeIndex(next);
  if (enabled && inject && !prev) await injectIntoOpenTabs(pack.site.hosts);
  return pack;
}

/**
 * Atomic read–modify–write: `fn` gets the stored pack and returns the new one
 * (or undefined to leave it unchanged) inside the store queue, so concurrent
 * generation lanes and user edits never overwrite each other.
 */
export function mutatePack(id: string, fn: (pack: SitePack) => SitePack | undefined | Promise<SitePack | undefined>): Promise<SitePack | undefined> {
  return serial(async () => {
    const current = await getPack(id);
    if (!current) return undefined;
    const next = await fn(structuredClone(current));
    if (!next) return current;
    const v = validatePack(next);
    if (!v.ok) throw new Error(v.errors.join('；'));
    return write(v.pack, current, undefined, false);
  });
}

/**
 * One-time, idempotent upgrade of installed data (v1 → v2): packs, runtime
 * projections and index entries. v1 packs keep the scope the user authorized
 * (approved regions, no background learning). Unfinished v1 generation jobs are
 * cancelled because their request snapshots predate structured planning.
 */
export function migrateInstalled(): Promise<number> {
  return serial(async () => {
    let migrated = 0;
    const index = await listPacks();
    for (const item of index) {
      // Unfinished jobs from before plan binding can never run: checked every start, independently
      // of the pack upgrade (an upgrade interrupted halfway must not leave them resumable).
      const jobKey = `job:${item.id}`;
      const job = (await browser.storage.local.get(jobKey))[jobKey] as { state?: string; planId?: string } | undefined;
      if (job && !job.planId && (job.state === 'running' || job.state === 'paused')) {
        await browser.storage.local.set({ [jobKey]: { ...job, state: 'cancelled', error: '格式已升级，请重新预览后生成' } });
      }
      const raw = (await browser.storage.local.get(STORAGE.pack(item.id)))[STORAGE.pack(item.id)] as { version?: number; lifecycleId?: string } | undefined;
      const rt = (await browser.storage.local.get(STORAGE.runtime(item.id)))[STORAGE.runtime(item.id)] as { scope?: string } | undefined;
      if (!raw || (raw.version === PACK_VERSION && rt?.scope && raw.lifecycleId)) continue;
      const v = validatePack(raw);
      if (!v.ok) continue;
      v.pack.lifecycleId = raw.lifecycleId || crypto.randomUUID();
      await browser.storage.local.set({ [STORAGE.pack(item.id)]: v.pack, [STORAGE.runtime(item.id)]: toRuntime(v.pack) });
      migrated++;
    }
    return migrated;
  });
}

export function deletePack(id: string): Promise<void> {
  for (const hook of deleteHooks) hook(id);
  return packOperation(id, () => serial(async () => {
    for (const hook of deleteHooks) hook(id);
    const jobKey = `job:${id}`;
    const job = (await browser.storage.local.get(jobKey))[jobKey] as { state?: string } | undefined;
    if (job) await browser.storage.local.set({ [jobKey]: { ...job, state: 'cancelled', error: '语言包已被删除' } });
    await browser.storage.local.remove([`plan:${id}`, `describePlan:${id}`]);
    const index = (await listPacks()).filter((p) => p.id !== id);
    // Index first: open tabs see the pack disappear and restore the page.
    await writeIndex(index);
    await browser.storage.local.remove([STORAGE.pack(id), STORAGE.runtime(id)]);
  }));
}

export function setPackEnabled(id: string, enabled: boolean): Promise<void> {
  return serial(async () => {
    const index = await listPacks();
    const item = index.find((p) => p.id === id);
    if (!item) throw new Error('语言包不存在');
    await writeIndex(index.map((p) => (p.id === id ? { ...p, enabled } : p)));
    if (enabled) await injectIntoOpenTabs(item.hosts);
  });
}

/** After install/update/browser start: registrations must match the stored index. */
export async function reconcilePacks(): Promise<void> {
  await migrateInstalled().catch((e) => console.warn('[translucid] pack migration failed', e));
  await syncRegistrations(await listPacks()).catch((e) => console.warn('[translucid] pack registration failed', e));
}
