// Site language pack generation jobs. The preview freezes a plan (request
// snapshot, batches, destination) under a planId; generation accepts only that
// planId, so what the user approved is what is sent. A job translates the plan
// in batches; every batch is checkpointed and its accepted strings merged into
// the pack in one store transaction (user-edited entries are never overwritten,
// responses arriving after a cancel are dropped). After a service-worker restart
// a running job becomes "paused": it only resumes when the user says so.
import { browser } from 'wxt/browser';
import { buildAppDescriptionMessages, buildUiBatchMessages, outlineOrder, UI_PROMPT_VERSION } from '../prompt/ui-locale';
import type { ChatMessage } from '../prompt/assemble';
import { mergeContextual, resolve, sanitizeText, toRuntime, type ContextualResult, type PackGlossaryEntry } from '../pack/format';
import { approvedLabels, batchUnits, consolidate, displayOrdered, retryBatches, unitsOf, type Occurrence, type PlanItem } from '../pack/units';
import { isMachineTranslation, providerReady } from '../shared/pricing';
import type { ProviderConfig, Settings } from '../shared/types';
import { sleep } from './batching';
import { clearPending, getPending, pendingKey } from './pack-pending';
import { ensurePackIdentity, getPack, mutatePack, onPackDelete, packOperation, storeTransaction } from './pack-store';
import { completeChat, HttpError, streamChat, type Usage } from './providers';
import { fallbackFor, mainProvider, providerGate } from './routing';
import { recordUsage } from './usage';
import { hasContactData, redactContactData } from '../pack/hardflags';
import { validateUiTranslation } from './validate-ui';

export type JobState = 'running' | 'paused' | 'done' | 'cancelled' | 'failed';

/** One translation: a string for one context, or shared by all the places listed in `members`. */
export type JobItem = PlanItem;

export interface JobBatch {
  ids: number[];
  /** Read-only neighbours (same question) sent as context. */
  context?: number[];
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  error?: string;
}

export interface JobMetrics {
  requests: number;
  retries: number;
  /** Wall time of the run so far. */
  ms: number;
  cachedTokens: number;
}

export interface PackJob {
  jobId: string;
  packId: string;
  lifecycleId?: string;
  /** The approved plan this job runs. */
  planId?: string;
  baseRev: number;
  providerId: string;
  /** Destination fingerprint (vendor, endpoint, model) shown in the approved preview. */
  providerKey?: string;
  /** Fallback provider shown in the approved preview (none: no fallback). */
  fallbackId?: string;
  fallbackKey?: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  /** Frozen request content exactly as the user approved it. */
  snapshot: {
    appName: string;
    host: string;
    description: string;
    targetLang: string;
    glossary: PackGlossaryEntry[];
    items: JobItem[];
    /** Structure labels allowed as context (approved strings only). */
    labels?: string[];
  };
  batches: JobBatch[];
  /** item index → accepted translation */
  results: Record<number, string>;
  failed: number[];
  error?: string;
  tokens: { prompt: number; completion: number };
  metrics?: JobMetrics;
}

export const jobKey = (packId: string) => `job:${packId}`;
export const planKey = (packId: string) => `plan:${packId}`;
/** An unconfirmed preview expires: the pending pool and settings move on. */
const PLAN_TTL_MS = 60 * 60_000;

/** A frozen preview: exactly what generation will send, and where. */
export interface PackPlan {
  planId: string;
  packId: string;
  lifecycleId?: string;
  createdAt: number;
  baseRev: number;
  providerId: string;
  providerKey: string;
  fallbackId?: string;
  fallbackKey?: string;
  snapshot: PackJob['snapshot'];
  batches: JobBatch[];
}
const BATCH_CHARS = 3200;
const BATCH_ITEMS = 120;
/** First try plus two retries; retries keep each string's group as read-only context. */
const MAX_ATTEMPTS = 3;
/** Parallel requests after the first batch (also bounded by the provider's own concurrency). */
const MAX_LANES = 4;

const running = new Map<string, AbortController>();
const describing = new Map<string, Set<AbortController>>();
onPackDelete((id) => {
  running.get(id)?.abort();
  for (const ctl of describing.get(id) ?? []) ctl.abort();
});

export async function getJob(packId: string): Promise<PackJob | undefined> {
  return (await browser.storage.local.get(jobKey(packId)))[jobKey(packId)] as PackJob | undefined;
}

let jobQueue: Promise<unknown> = Promise.resolve();
function serialJob<T>(fn: () => Promise<T>): Promise<T> {
  const next = jobQueue.then(fn, fn);
  jobQueue = next.catch(() => undefined);
  return next;
}

async function putJob(job: PackJob): Promise<void> {
  await serialJob(async () => {
    job.updatedAt = Date.now();
    await browser.storage.local.set({ [jobKey(job.packId)]: job });
  });
}

/** Checkpoint a running job unless it was cancelled or replaced meanwhile. */
async function saveProgress(job: PackJob): Promise<boolean> {
  return storeTransaction(() => serialJob(async () => {
    const pack = await getPack(job.packId);
    if (!pack || !job.lifecycleId || pack.lifecycleId !== job.lifecycleId) return false;
    const stored = await getJob(job.packId);
    if (!stored || stored.jobId !== job.jobId || stored.state === 'cancelled') return false;
    job.updatedAt = Date.now();
    await browser.storage.local.set({ [jobKey(job.packId)]: job });
    return true;
  }));
}

/** Where requests go: a changed vendor, endpoint or model is a different destination than the one previewed. */
export const destinationKey = (p: ProviderConfig) => JSON.stringify([p.vendor, p.baseURL.replace(/\/+$/, ''), p.model]);

/** The provider with this id, only if it still points where the preview said. */
function approvedProvider(s: Settings, id: string | undefined, key: string | undefined): ProviderConfig | undefined {
  if (!id) return undefined;
  const p = packProvider(s, id);
  return p && (key === undefined || destinationKey(p) === key) ? p : undefined;
}

/** Provider for packs: the main LLM (never machine translation), ready to use. */
export function packProvider(s: Settings, id?: string): ProviderConfig | undefined {
  const p = id ? s.providers.find((x) => x.id === id) : mainProvider(s);
  return p && providerReady(p) && !isMachineTranslation(p) ? p : undefined;
}

export interface StartInput {
  packId: string;
  /** pendingKey (string + context) of the approved pending occurrences. */
  keys: string[];
  description: string;
}

/** Build the request snapshot and its batches from approved pending strings. */
export async function buildSnapshot(input: StartInput): Promise<{ snapshot: PackJob['snapshot']; batches: JobBatch[]; baseRev: number; lifecycleId: string }> {
  const pack = await ensurePackIdentity(input.packId);
  if (!pack) throw new Error('语言包不存在');
  const pending = await getPending(input.packId);
  const wanted = new Set(input.keys);
  const area = new Map(pack.regions.map((r) => [r.id, r.builtin ? 'popup menu / dialog / tooltip' : r.label]));
  const occurrences: Occurrence[] = pending
    .filter((p) => wanted.has(pendingKey(p)))
    .map((p) => ({
      key: pendingKey(p),
      kind: p.kind,
      src: p.src,
      region: p.region,
      area: area.get(p.region) ?? 'interface',
      ...(p.ctx ? { ctx: p.ctx } : {}),
      ...(p.where ? { where: p.where } : {}),
    }));
  if (!occurrences.length) throw new Error('没有选中要翻译的文字');
  const items = consolidate(occurrences);
  const batches = batchUnits(items, unitsOf(items), BATCH_CHARS, BATCH_ITEMS).map((b) => ({
    ...displayOrdered(items, b, outlineOrder),
    status: 'pending' as const,
    attempts: 0,
  }));
  return {
    snapshot: {
      appName: pack.site.name,
      host: pack.site.hosts[0]!,
      description: redactContactData(input.description),
      targetLang: pack.targetLang,
      glossary: pack.glossary,
      items,
      labels: approvedLabels(items, pack.entries.map((e) => e.src)),
    },
    batches,
    baseRev: pack.rev,
    lifecycleId: pack.lifecycleId!,
  };
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Freeze a preview: the returned plan is the only thing `startJob` will run. */
export async function createPlan(input: StartInput, s: Settings): Promise<PackPlan> {
  return packOperation(input.packId, async () => {
    const provider = packProvider(s);
    if (!provider) throw new Error('正文服务商未配置或不可用（机翻不能用于语言包）');
    const fb = fallbackFor(s, provider);
    const fallback = fb && packProvider(s, fb.id);
    const built = await buildSnapshot(input);
    const plan: PackPlan = {
      planId: newId(),
      packId: input.packId,
      lifecycleId: built.lifecycleId,
      createdAt: Date.now(),
      baseRev: built.baseRev,
      providerId: provider.id,
      providerKey: destinationKey(provider),
      ...(fallback ? { fallbackId: fallback.id, fallbackKey: destinationKey(fallback) } : {}),
      snapshot: built.snapshot,
      batches: built.batches,
    };
    await browser.storage.local.set({ [planKey(input.packId)]: plan });
    return plan;
  });
}

export async function getPlan(packId: string): Promise<PackPlan | undefined> {
  return (await browser.storage.local.get(planKey(packId)))[planKey(packId)] as PackPlan | undefined;
}

/** Start the job for an approved preview. Anything that changed since the preview is refused. */
export async function startJob(packId: string, planId: string, s: Settings): Promise<PackJob> {
  return packOperation(packId, async () => {
    const existing = await getJob(packId);
    if (existing && (existing.state === 'running' || existing.state === 'paused')) throw new Error('已有未完成的生成任务，请先继续或取消');
    const plan = await getPlan(packId);
    if (!plan || plan.planId !== planId || Date.now() - plan.createdAt > PLAN_TTL_MS) throw new Error('预览已失效，请重新预览后再确认');
    const currentPack = await getPack(packId);
    if (!currentPack || !plan.lifecycleId || currentPack.lifecycleId !== plan.lifecycleId) throw new Error('预览已失效，请重新预览');
    const provider = approvedProvider(s, plan.providerId, plan.providerKey);
    if (!provider || packProvider(s)?.id !== plan.providerId) throw new Error('服务商设置已更改，请重新预览');
    if ((plan.fallbackId && !approvedProvider(s, plan.fallbackId, plan.fallbackKey)) || (!plan.fallbackId && fallbackUsable(s, provider))) {
      throw new Error('备用服务商设置已更改，请重新预览');
    }
    await browser.storage.local.remove(planKey(packId));
    // The confirmed description becomes part of the pack.
    await mutatePack(packId, (pack) =>
      pack.site.description === plan.snapshot.description ? undefined : { ...pack, site: { ...pack.site, description: plan.snapshot.description } },
    );
    const job: PackJob = {
      jobId: newId(),
      packId,
      lifecycleId: plan.lifecycleId,
      planId: plan.planId,
      baseRev: plan.baseRev,
      providerId: provider.id,
      providerKey: plan.providerKey,
      ...(plan.fallbackId ? { fallbackId: plan.fallbackId, fallbackKey: plan.fallbackKey } : {}),
      state: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: plan.snapshot,
      batches: plan.batches,
      results: {},
      failed: [],
      tokens: { prompt: 0, completion: 0 },
    };
    await putJob(job);
    void runJob(packId, s);
    return job;
  });
}

function fallbackUsable(s: Settings, provider: ProviderConfig): boolean {
  const fb = fallbackFor(s, provider);
  return !!fb && !!packProvider(s, fb.id);
}

/** Parse a complete reply strictly: closed tags only, ids 1..n, any duplicated id rejected. */
export function parseStrict(raw: string, n: number): Map<number, string> {
  const clean = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
  const seen = new Map<number, string[]>();
  for (const m of clean.matchAll(/<(\d+)>([\s\S]*?)<\/\1>/g)) {
    const id = Number(m[1]);
    if (id < 1 || id > n) continue;
    seen.set(id, [...(seen.get(id) ?? []), m[2]!.trim()]);
  }
  const out = new Map<number, string>();
  for (const [id, texts] of seen) if (texts.length === 1) out.set(id, texts[0]!);
  return out;
}

/** The exact request for one batch (the preview shows these for the planned batches). */
export function batchMessages(snapshot: PackJob['snapshot'], batch: Pick<JobBatch, 'ids' | 'context'>): ChatMessage[] {
  return buildUiBatchMessages({
    ...snapshot,
    items: batch.ids.map((i) => snapshot.items[i]!),
    context: batch.context?.map((i) => snapshot.items[i]!),
    labels: new Set(snapshot.labels ?? []),
  });
}

async function translateBatch(
  provider: ProviderConfig,
  job: PackJob,
  batch: JobBatch,
  signal: AbortSignal,
): Promise<{ accepted: Map<number, string>; usage?: Usage }> {
  const ids = batch.ids;
  const items = ids.map((i) => job.snapshot.items[i]!);
  const messages = batchMessages(job.snapshot, batch);
  let raw = '';
  let usage: Usage | undefined;
  await providerGate(provider).run(async () => {
    for await (const delta of streamChat(provider, messages, signal, (u) => (usage = u))) raw += delta;
  }, signal);
  providerGate(provider).success();
  const parsed = parseStrict(raw, items.length);
  const accepted = new Map<number, string>();
  parsed.forEach((rawText, pos) => {
    const text = sanitizeText(rawText).trim();
    const item = items[pos - 1]!;
    if (!hasContactData(text) && validateUiTranslation(item.src, text, job.snapshot.targetLang, job.snapshot.glossary).ok) accepted.set(ids[pos - 1]!, text);
  });
  return { accepted, usage };
}

/**
 * Merge accepted strings into the pack in one store transaction. The job must
 * still be the stored, uncancelled job at that moment; otherwise the response
 * is late and dropped. Returns 'gone' when the pack was deleted.
 */
export async function commit(job: PackJob, accepted: Map<number, string>, model: string): Promise<'ok' | 'stale' | 'gone'> {
  return packOperation(job.packId, async () => {
    for (const [i, t] of accepted) if (!job.snapshot.items[i] || hasContactData(sanitizeText(t))) accepted.delete(i);
    if (!accepted.size) return 'ok';
    let stale = false;
    const now = Date.now();
    const results: ContextualResult[] = [];
    const keys: string[] = [];
    for (const [i, t] of accepted) {
      const it = job.snapshot.items[i]!;
      const base = { kind: it.kind, src: it.src, t, region: it.region, ...(it.where ? { where: it.where } : {}) };
      // A shared translation is recorded for every place it covers (context membership).
      const ctxs = it.ctx ? [it.ctx] : (it.members ?? []);
      if (ctxs.length) for (const ctx of ctxs) results.push({ ...base, ctx });
      else results.push(base);
    }
    const saved = await mutatePack(job.packId, async (pack) => {
      const stored = await getJob(job.packId);
      if (!job.lifecycleId || pack.lifecycleId !== job.lifecycleId || !stored || stored.jobId !== job.jobId || stored.state === 'cancelled') {
        stale = true;
        return undefined;
      }
      const merged = mergeContextual(pack, results, now);
      merged.generator = { ...merged.generator, model, promptVersion: UI_PROMPT_VERSION };
      return merged;
  });
  if (!saved) return 'gone';
  if (stale) return 'stale';
  // Validation and entry limits may discard results; only persisted translations count.
  const runtime = toRuntime(saved);
  keys.length = 0;
  for (const [i, t] of accepted) {
    const item = job.snapshot.items[i]!;
    const ctxs = item.ctx ? [item.ctx] : item.members ?? [];
    const persisted = (ctxs.length ? ctxs : ['']).every((ctx) => resolve(runtime, item.kind, item.src, () => ctx ? [ctx] : []) === t);
    if (persisted) keys.push(...(item.keys ?? []));
    else accepted.delete(i);
  }
  await clearPending(job.packId, keys);
  return 'ok';
  });
}

export async function runJob(packId: string, s: Settings): Promise<void> {
  if (running.get(packId) && !running.get(packId)!.signal.aborted) return;
  const ctl = new AbortController();
  running.set(packId, ctl);
  try {
    const job = await getJob(packId);
    if (!job || job.state === 'done' || job.state === 'cancelled') return;
    // Only the approved destination: a changed provider (or its endpoint or model) needs a new preview.
    const provider = approvedProvider(s, job.providerId, job.providerKey);
    if (!provider) {
      job.state = 'paused';
      job.error = packProvider(s, job.providerId) ? '服务商的地址或模型已更改，请取消后重新预览' : '服务商不可用，请检查设置后继续';
      await saveProgress(job);
      return;
    }
    job.state = 'running';
    job.error = undefined;
    job.metrics ??= { requests: 0, retries: 0, ms: 0, cachedTokens: 0 };
    if (!(await saveProgress(job))) return;
    const t0 = Date.now() - job.metrics.ms;
    let stop = false;
    const taken = new Set<JobBatch>();

    /** Translate one batch, record results, queue retries, commit. False: stop the whole job. */
    const process = async (batch: JobBatch): Promise<boolean> => {
      let used = provider;
      let result: Awaited<ReturnType<typeof translateBatch>> | undefined;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        try {
          job.metrics!.requests++;
          result = await translateBatch(used, job, batch, ctl.signal);
        } catch (e) {
          if (ctl.signal.aborted) return false;
          if (e instanceof HttpError && e.throttled) providerGate(used).backoff(e.retryAfterMs);
          // Switch after the first failure, but only to the fallback shown in the approved preview.
          const fb = job.fallbackId && used.id !== job.fallbackId ? approvedProvider(s, job.fallbackId, job.fallbackKey) : undefined;
          if (fb) used = fb;
          if (e instanceof HttpError && !e.retryable && !fb) {
            batch.status = 'failed';
            batch.error = e.message;
            break;
          }
          await sleep(1000 * 2 ** attempt, ctl.signal);
        }
      }
      if (ctl.signal.aborted) return false;
      if (result) {
        if (result.usage) {
          recordUsage(used, result.usage);
          job.tokens.prompt += result.usage.promptTokens;
          job.tokens.completion += result.usage.completionTokens;
          job.metrics!.cachedTokens += result.usage.cacheHitTokens;
        }
        // Commit first. The shared job (checkpointed by every lane) only learns that this batch is
        // done once its strings are in the pack; a restart before that re-translates the batch.
        const outcome = await commit(job, result.accepted, used.model);
        if (outcome === 'stale') return false;
        if (outcome === 'gone') {
          job.state = 'cancelled';
          job.error = '语言包已被删除';
          await saveProgress(job);
          return false;
        }
        for (const [i, t] of result.accepted) job.results[i] = t;
        batch.status = 'done';
        const missing = batch.ids.filter((i) => !result!.accepted.has(i));
        if (missing.length) {
          const attempts = batch.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) job.failed.push(...missing);
          else {
            // Retry with each string's question as read-only context, never as an orphan.
            const retries = retryBatches(job.snapshot.items, missing, BATCH_CHARS, BATCH_ITEMS);
            job.metrics!.retries += retries.length;
            job.batches.push(...retries.map((b) => ({ ...displayOrdered(job.snapshot.items, b, outlineOrder), status: 'pending' as const, attempts })));
          }
        }
      } else {
        batch.status = 'failed';
        batch.error ??= '多次重试后仍失败';
        job.failed.push(...batch.ids);
      }
      job.metrics!.ms = Date.now() - t0;
      return saveProgress(job);
    };

    const lane = async () => {
      while (!stop && !ctl.signal.aborted) {
        const batch = job.batches.find((b) => b.status === 'pending' && !taken.has(b));
        if (!batch) return;
        taken.add(batch);
        if (!(await process(batch))) stop = true;
      }
    };

    // First batch alone (it warms provider caches), then parallel lanes.
    const first = job.batches.find((b) => b.status === 'pending');
    if (first) {
      taken.add(first);
      if (!(await process(first))) return;
    }
    const lanes = Math.max(1, Math.min(MAX_LANES, provider.concurrency || 1));
    await Promise.all(Array.from({ length: lanes }, lane));
    if (stop || ctl.signal.aborted) return;
    const stored = await getJob(packId);
    if (stored?.jobId === job.jobId && stored.state === 'running') {
      job.state = job.failed.length && !Object.keys(job.results).length ? 'failed' : 'done';
      job.metrics!.ms = Date.now() - t0;
      await saveProgress(job);
    }
  } finally {
    if (running.get(packId) === ctl) running.delete(packId);
  }
}

export async function cancelJob(packId: string): Promise<void> {
  running.get(packId)?.abort();
  // Inside the store queue: a commit that already passed its job check finishes first, and
  // every later commit sees the cancel. (Store queue before job queue, as everywhere.)
  await storeTransaction(async () => {
    const job = await getJob(packId);
    if (job && (job.state === 'running' || job.state === 'paused')) {
      job.state = 'cancelled';
      await putJob(job);
    }
  });
}

export async function resumeJob(packId: string, s: Settings): Promise<void> {
  const job = await getJob(packId);
  const pack = await getPack(packId);
  if (!job || !job.lifecycleId || job.lifecycleId !== pack?.lifecycleId || (job.state !== 'paused' && job.state !== 'running')) throw new Error('没有可继续的任务');
  void runJob(packId, s);
}

/** After a service-worker restart nothing is running: mark interrupted jobs as paused. */
export async function pauseInterruptedJobs(): Promise<void> {
  await storeTransaction(async () => {
    const all = await browser.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith('job:')) continue;
      const job = v as PackJob;
      const pack = await getPack(job.packId);
      if (job.state === 'running' && !running.has(job.packId)) {
        job.state = job.lifecycleId && job.lifecycleId === pack?.lifecycleId ? 'paused' : 'cancelled';
        job.error = job.state === 'paused' ? '扩展后台曾被重启，任务已暂停' : '语言包已被删除或格式已升级，请重新预览';
        await putJob(job);
      }
    }
  });
}

// ---------- app description draft ----------

const describeKey = (packId: string) => `describePlan:${packId}`;

interface DescribePlan {
  planId: string;
  lifecycleId: string;
  createdAt: number;
  providerId: string;
  providerKey: string;
  messages: ChatMessage[];
}

/** Freeze the description request (approved strings only) so the user sees exactly what is sent. */
export async function createDescribePlan(packId: string, keys: string[], s: Settings): Promise<{ plan: DescribePlan; provider: ProviderConfig; items: number }> {
  return packOperation(packId, async () => {
    const provider = packProvider(s);
    if (!provider) throw new Error('正文服务商未配置或不可用（机翻不能用于语言包）');
    const built = await buildSnapshot({ packId, keys, description: '' });
    const srcs = [...new Set(built.snapshot.items.map((i) => i.src))];
    const plan: DescribePlan = {
      planId: newId(),
      lifecycleId: built.lifecycleId,
      createdAt: Date.now(),
      providerId: provider.id,
      providerKey: destinationKey(provider),
      messages: buildAppDescriptionMessages(built.snapshot.appName, built.snapshot.host, srcs),
    };
    await browser.storage.local.set({ [describeKey(packId)]: plan });
    return { plan, provider, items: Math.min(srcs.length, 80) };
  });
}

/** Send the frozen description request (one shot). */
export async function runDescribePlan(packId: string, planId: string, s: Settings): Promise<string> {
  const ctl = new AbortController();
  const { plan, provider } = await packOperation(packId, async () => {
    const plan = (await browser.storage.local.get(describeKey(packId)))[describeKey(packId)] as DescribePlan | undefined;
    const pack = await getPack(packId);
    if (!plan || plan.planId !== planId || Date.now() - plan.createdAt > PLAN_TTL_MS || !pack || !plan.lifecycleId || plan.lifecycleId !== pack.lifecycleId) throw new Error('预览已失效，请重新预览');
    const provider = approvedProvider(s, plan.providerId, plan.providerKey);
    if (!provider) throw new Error('服务商设置已更改，请重新预览');
    await browser.storage.local.remove(describeKey(packId));
    const active = describing.get(packId) ?? new Set<AbortController>();
    active.add(ctl);
    describing.set(packId, active);
    return { plan, provider };
  });
  try {
    const res = await completeChat(provider, plan.messages, ctl.signal);
    const pack = await getPack(packId);
    if (ctl.signal.aborted || pack?.lifecycleId !== plan.lifecycleId) throw new Error('语言包已被删除，请重新预览');
    recordUsage(provider, res.usage);
    return redactContactData(res.text.replace(/\s+/g, ' ').slice(0, 600));
  } finally {
    const active = describing.get(packId);
    active?.delete(ctl);
    if (!active?.size) describing.delete(packId);
  }
}
