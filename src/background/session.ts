import {
  buildBatchMessages,
  buildPreprocessMessages,
  buildRefineDraftMessages,
  buildRefineImproveMessages,
} from '../prompt/assemble';
import { GENERAL_EXPERT_ID } from '../prompt/experts/builtin';
import { findHits, formatGlossary, KEEP, mergeGlossaries, parseGlossary } from '../prompt/glossary';
import { PROTOCOL_VERSION } from '../prompt/protocol';
import { findSiteRule, resolveExpert } from '../shared/match';
import { isMachineTranslation, providerReady } from '../shared/pricing';
import type { ToBackground, ToContent } from '../shared/messages';
import { polishChinese, stripMarkup } from '../shared/text';
import type { Expert, GlossaryEntry, PageContext, PageInfo, ProviderConfig, SegmentPayload, Settings } from '../shared/types';
import { packBatches, sleep } from './batching';
import { fallbackFor, mainProvider, providerGate, usableProvider } from './routing';
import { cacheDeleteMany, cacheGetMany, cachePut, sha256 } from './cache';
import { machineTranslate, mtSuitable } from './mt';
import { completeChat, HttpError, streamChat, type Usage } from './providers';
import { SegmentStreamParser } from './stream-parser';
import { recordUsage } from './usage';
import { sanitizeMarkup, tagsMatch, validateTranslation } from './validate';

interface Job {
  id: number;
  text: string;
  key: string;
  hits: GlossaryEntry[];
  /** 0 batch → 1 half batch → 2 alone → 3 alone without tags → give up */
  attempt: number;
}

/** `wxt build --mode debug` reports per-request metrics back to the page. */
const DEBUG = import.meta.env.MODE === 'debug';
const MAX_ATTEMPT = 3;
const STRUCTURAL = new Set(['empty', 'missing atoms', 'leaked segment tag']);
/** Inline tags or atoms: machine translation would mangle them. */
const MARKUP = /<\/?[a-z]\d+>|\{\{\d+\}\}/;
/** Machine translation handles many strings per request; batches can be much larger. */
const MT_BATCH_CHARS = 3000;
const MT_BATCH_SEGMENTS = 60;
/**
 * With a fallback configured, a batch that shows no first token by then (queue wait
 * included) moves to the fallback. Healthy providers answer in 0.5–1.5 s; the free
 * GLM tier under load took 24 s on TechPowerUp (2026-10-11).
 */
const FIRST_TOKEN_FALLBACK_MS = 8000;

/** Smallest follow-up batch when spreading a wave across parallel lanes. */
const MIN_BATCH_CHARS = 500;
const gate = providerGate;

/**
 * Follow-up batch size: spread the wave over the idle lanes the provider allows, so a
 * page with many components runs many short streams in parallel instead of a
 * few long ones (each batch streams its whole output; time grows with length).
 * RPM-limited providers keep full-size batches to save requests.
 */
export function laneBatchChars(totalChars: number, lanes: number, maxChars: number, rpm = 0): number {
  if (rpm > 0 && rpm < 60) return maxChars;
  return Math.min(maxChars, Math.max(MIN_BATCH_CHARS, Math.ceil(totalChars / Math.max(1, lanes))));
}

export interface PortLike {
  postMessage(msg: ToContent): void;
}

/** One per tab connection. Owns batching, warm-up, retries and cancellation for that page. */
export class TranslateSession {
  private abort = new AbortController();
  private warmStarted = false;
  private warm: Promise<void> = Promise.resolve();
  private pages = new Map<string, PageInfo>();
  private preprocessing = new Set<string>();
  private lastExpertId = '';

  constructor(
    private port: PortLike,
    private getSettings: () => Settings,
  ) {}

  dispose(): void {
    this.abort.abort();
  }

  async handle(msg: ToBackground): Promise<void> {
    switch (msg.type) {
      case 'translate':
        return this.translate(msg.ctx, msg.segments, msg.expertOverride);
      case 'preprocess':
        return this.preprocess(msg.ctx, msg.article);
      case 'refine':
        return this.refine(msg.ctx, msg.segment, msg.expertOverride);
      case 'purge':
        return this.purge(msg.ctx, msg.texts, msg.expertOverride);
      case 'reset':
        this.abort.abort();
        this.abort = new AbortController();
        this.warmStarted = false;
        this.warm = Promise.resolve();
        return;
    }
  }

  // ---------- resolution helpers ----------

  private expertFor(ctx: PageContext, override?: string): Expert {
    const s = this.getSettings();
    const byId = (id?: string) => (id ? s.experts.find((e) => e.id === id) : undefined);
    const site = findSiteRule(s.siteRules, ctx.host);
    let expert = byId(override) ?? byId(site?.expertId) ?? resolveExpert(s.experts, ctx.url, GENERAL_EXPERT_ID)!;
    // Use the preprocess scene guess only when nothing specific matched.
    const scene = this.pages.get(ctx.url)?.scene;
    if (expert.id === GENERAL_EXPERT_ID && scene) expert = byId(scene) ?? expert;
    if (expert.id !== this.lastExpertId) {
      this.lastExpertId = expert.id;
      this.port.postMessage({ type: 'expert', id: expert.id, name: expert.name });
    }
    return expert;
  }

  /** page terms < global glossary < site glossary */
  private glossaryFor(ctx: PageContext): GlossaryEntry[] {
    const s = this.getSettings();
    const site = findSiteRule(s.siteRules, ctx.host);
    return mergeGlossaries(this.pages.get(ctx.url)?.terms ?? [], parseGlossary(s.glossary), parseGlossary(site?.glossary));
  }

  private usable(id: string): ProviderConfig | undefined {
    return usableProvider(this.getSettings(), id);
  }

  private fallbackFor(p: ProviderConfig): ProviderConfig | undefined {
    return fallbackFor(this.getSettings(), p);
  }

  private mainProvider(): ProviderConfig {
    return mainProvider(this.getSettings());
  }

  private providerFor(text: string, hits: GlossaryEntry[] = [], scene?: string): ProviderConfig {
    const s = this.getSettings();
    if (s.shortTextProviderId && stripMarkup(text).trim().length <= s.shortTextMaxChars) {
      const short = this.usable(s.shortTextProviderId);
      // Machine translation gets plain UI phrases only; tags, glossary/page terms and
      // name-like strings need the LLM.
      if (short && !(isMachineTranslation(short) && (MARKUP.test(text) || hits.length || !mtSuitable(text, scene)))) return short;
    }
    return this.mainProvider();
  }

  private cacheKey(p: ProviderConfig, expert: Expert, hits: GlossaryEntry[], text: string): Promise<string> {
    return sha256([PROTOCOL_VERSION, p.id, p.model, expert.id, expert.rules, formatGlossary(hits), text].join('\u0001'));
  }

  // ---------- translate ----------

  private preprocessKey(provider: ProviderConfig, url: string): Promise<string> {
    return sha256(['pre', 1, provider.model, url].join('\u0001'));
  }

  /**
   * The MV3 worker is killed after ~30s idle, losing in-memory page info; a cached
   * preprocess result (scene, topic, terms) is restored with one IndexedDB read so
   * the scene applies from the first batch on revisits and after restarts.
   */
  private async restorePageInfo(ctx: PageContext): Promise<void> {
    if (this.pages.has(ctx.url) || this.getSettings().preprocess === 'off') return;
    const raw = (await cacheGetMany([await this.preprocessKey(this.mainProvider(), ctx.url)]).catch(() => []))[0];
    if (raw !== undefined) this.setPageInfo(ctx.url, parsePreprocess(raw, this.getSettings().experts));
  }

  private setPageInfo(url: string, info: PageInfo): void {
    this.pages.set(url, info);
    this.port.postMessage({ type: 'page-info', info });
  }

  /** Delete the cache entries these texts would hit with the current provider/expert/glossary. */
  private async purge(ctx: PageContext, texts: string[], override?: string): Promise<void> {
    const expert = this.expertFor(ctx, override);
    const glossary = this.glossaryFor(ctx);
    const keys = await Promise.all(
      texts.map((t) => {
        const hits = findHits(glossary, t);
        return this.cacheKey(this.providerFor(t, hits, expert.id), expert, hits, t);
      }),
    );
    await cacheDeleteMany(keys).catch(() => {});
    this.port.postMessage({ type: 'purged' });
  }

  private async translate(ctx: PageContext, segments: SegmentPayload[], override?: string): Promise<void> {
    const signal = this.abort.signal;
    await this.restorePageInfo(ctx);
    const expert = this.expertFor(ctx, override);
    const glossary = this.glossaryFor(ctx);

    const prepared = await Promise.all(
      segments.map(async (seg) => {
        const hits = findHits(glossary, seg.text);
        const provider = this.providerFor(seg.text, hits, expert.id);
        return { seg, provider, hits, key: await this.cacheKey(provider, expert, hits, seg.text) };
      }),
    );
    const cached = await cacheGetMany(prepared.map((p) => p.key)).catch(() => prepared.map(() => undefined));
    if (signal.aborted) return;

    const byProvider = new Map<ProviderConfig, Job[]>();
    prepared.forEach((p, i) => {
      const hit = cached[i];
      if (hit !== undefined) {
        this.port.postMessage({ type: 'result', id: p.seg.id, text: hit, cached: true });
        return;
      }
      const list = byProvider.get(p.provider) ?? [];
      list.push({ id: p.seg.id, text: p.seg.text, key: p.key, hits: p.hits, attempt: 0 });
      byProvider.set(p.provider, list);
    });

    await Promise.all([...byProvider].map(([provider, jobs]) => this.schedule(ctx, expert, provider, jobs, signal)));
  }

  /**
   * The first batch of a page is small (fast first paint) and goes out alone;
   * the rest wait until it starts streaming so DeepSeek can build its prefix
   * cache for the shared system prompt before the parallel burst.
   */
  private async schedule(ctx: PageContext, expert: Expert, provider: ProviderConfig, jobs: Job[], signal: AbortSignal) {
    const s = this.getSettings();
    if (isMachineTranslation(provider)) {
      // No prompt cache to warm and no reason to wait for the LLM's first batch.
      await Promise.all(packBatches(jobs, MT_BATCH_CHARS, MT_BATCH_SEGMENTS).map((b) => this.runMachineBatch(ctx, expert, provider, b, signal)));
      return;
    }
    const tasks: Promise<void>[] = [];
    let rest = jobs;
    if (!this.warmStarted) {
      this.warmStarted = true;
      const first = packBatches(jobs, s.firstBatchChars, s.firstBatchSegments)[0]!;
      rest = jobs.slice(first.length);
      let signalWarm!: () => void;
      this.warm = Promise.race([new Promise<void>((r) => (signalWarm = r)), sleep(4000)]);
      tasks.push(this.runBatch(ctx, expert, provider, first, signal, signalWarm));
    }
    if (rest.length) {
      await this.warm;
      const g = gate(provider);
      const total = rest.reduce((n, j) => n + j.text.length, 0);
      // Split across idle lanes only: while earlier waves still occupy the gate, splitting
      // finer just queues more requests, each paying its own time to first token.
      const chars = laneBatchChars(total, Math.max(1, g.freeLanes), s.batchChars, g.rpm);
      for (const batch of packBatches(rest, chars, s.batchSegments)) {
        tasks.push(this.runBatch(ctx, expert, provider, batch, signal));
      }
    }
    await Promise.all(tasks);
  }

  /** Free machine translation; anything it fails or mistranslates structurally goes to the main LLM. */
  private async runMachineBatch(ctx: PageContext, expert: Expert, provider: ProviderConfig, jobs: Job[], signal: AbortSignal): Promise<void> {
    const t0 = performance.now();
    let outs: string[] | undefined;
    try {
      outs = await gate(provider).run(() => machineTranslate(provider, jobs.map((j) => j.text), signal), signal);
      recordUsage(provider, undefined, performance.now() - t0);
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof HttpError && e.throttled) gate(provider).backoff(e.retryAfterMs);
      console.debug('[xt] machine translation failed, falling back to the main provider', e);
    }
    const fallback: Job[] = [];
    jobs.forEach((job, i) => {
      const raw = outs?.[i] ?? '';
      const v = validateTranslation(job.text, raw);
      if (!v.ok && !v.soft) {
        fallback.push(job);
        return;
      }
      const text = this.getSettings().autoSpace ? polishChinese(raw) : raw;
      this.port.postMessage({ type: 'result', id: job.id, text });
      void cachePut(job.key, text).catch(() => {});
    });
    if (DEBUG) {
      this.port.postMessage({
        type: 'metric',
        data: { model: provider.model, kind: 'mt', segments: jobs.length, totalMs: Math.round(performance.now() - t0), accepted: jobs.length - fallback.length },
      });
    }
    // Same cache key: a reload then serves the LLM result without asking the engine again.
    if (fallback.length && !signal.aborted) await this.runBatch(ctx, expert, this.mainProvider(), fallback, signal);
  }

  private async runBatch(
    ctx: PageContext,
    expert: Expert,
    provider: ProviderConfig,
    jobs: Job[],
    signal: AbortSignal,
    onFirstToken?: () => void,
  ): Promise<void> {
    const fallback = this.fallbackFor(provider);
    // Provider keeps failing with 429/overload: skip the queue and go straight to the fallback.
    if (fallback && gate(provider).tripped) return this.runBatch(ctx, expert, fallback, jobs, signal, onFirstToken);
    const plain = jobs[0]!.attempt >= MAX_ATTEMPT;
    const sources = jobs.map((j) => (plain ? stripMarkup(j.text).replace(/\s+/g, ' ').trim() : j.text));
    const hits = mergeGlossaries(...jobs.map((j) => j.hits));
    const messages = buildBatchMessages({
      expert,
      glossary: hits,
      title: ctx.title,
      topic: this.pages.get(ctx.url)?.topic,
      segments: sources,
    });

    const accepted = new Set<number>();
    const failed: Job[] = [];
    const t0 = performance.now();
    let ttft = 0;
    let usage: Usage | undefined;
    const rejects: { id: number; reason: string; src: string; out: string }[] = [];
    const accept = (idx: number, raw: string) => {
      const job = jobs[idx];
      if (!job || accepted.has(idx)) return;
      const clean = sanitizeMarkup(sources[idx]!, raw);
      const text = this.getSettings().autoSpace ? polishChinese(clean) : clean;
      const v = validateTranslation(sources[idx]!, text, job.hits);
      const lenient = !v.ok && ((v.soft && job.attempt >= 1) || (job.attempt >= 2 && !STRUCTURAL.has(v.reason)));
      if (v.ok || lenient) {
        accepted.add(idx);
        this.port.postMessage({ type: 'result', id: job.id, text, plain });
        void cachePut(job.key, text).catch(() => {});
      } else {
        console.debug('[xt] reject', job.id, v.reason, { src: sources[idx], out: text });
        if (DEBUG) rejects.push({ id: job.id, reason: v.reason, src: sources[idx]!, out: text });
      }
    };

    for (let httpTry = 0; ; httpTry++) {
      const parser = new SegmentStreamParser();
      // Per-attempt abort: page navigation, or no first token in time when a fallback exists.
      const attempt = new AbortController();
      const onAbort = () => attempt.abort();
      signal.addEventListener('abort', onAbort);
      let slow = false;
      const slowTimer = fallback
        ? setTimeout(() => {
            slow = true;
            attempt.abort();
          }, Math.max(0, FIRST_TOKEN_FALLBACK_MS - (performance.now() - t0)))
        : undefined;
      try {
        await gate(provider).run(async () => {
          if (attempt.signal.aborted) throw new DOMException('aborted', 'AbortError');
          let first = true;
          for await (const delta of streamChat(provider, messages, attempt.signal, (u) => (usage = u))) {
            if (first) {
              first = false;
              clearTimeout(slowTimer);
              ttft = performance.now() - t0;
              onFirstToken?.();
            }
            for (const seg of parser.push(delta)) accept(seg.id - 1, seg.text);
          }
          for (const seg of parser.end()) accept(seg.id - 1, seg.text);
          recordUsage(provider, usage, ttft);
        }, attempt.signal);
        clearTimeout(slowTimer);
        signal.removeEventListener('abort', onAbort);
        gate(provider).success();
        break;
      } catch (e) {
        clearTimeout(slowTimer);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return;
        if (slow) {
          // Too slow to start: count it like a throttle so the breaker can trip, then overflow.
          gate(provider).backoff();
          console.debug('[xt] no first token in time, overflowing to fallback', fallback!.id);
          const pending = jobs.filter((_, i) => !accepted.has(i));
          if (pending.length) await this.runBatch(ctx, expert, fallback!, pending, signal, onFirstToken);
          return;
        }
        const retryable = !(e instanceof HttpError) || e.retryable;
        // 429/503/529 slow the whole provider down (shared gate); the gate then also delays this retry.
        if (e instanceof HttpError && e.throttled) gate(provider).backoff(e.retryAfterMs);
        // With a fallback configured, retry the main provider once at most (auth errors,
        // refusals and bad requests not at all): the page should not wait on a struggling API.
        if (fallback && (!retryable || httpTry >= 1)) {
          console.debug('[xt] switching to fallback provider', fallback.id, e);
          const pending = jobs.filter((_, i) => !accepted.has(i));
          if (pending.length) await this.runBatch(ctx, expert, fallback, pending, signal, onFirstToken);
          return;
        }
        if (retryable && httpTry < 3) {
          // Exponential backoff with jitter so parallel batches do not retry in lockstep.
          const base = e instanceof HttpError && e.retryAfterMs ? e.retryAfterMs : 1000 * 2 ** httpTry;
          await sleep(base * (0.8 + Math.random() * 0.4), signal);
          continue;
        }
        onFirstToken?.();
        const pending = jobs.filter((_, i) => !accepted.has(i));
        this.port.postMessage({ type: 'error', ids: pending.map((j) => j.id), message: String((e as Error).message ?? e) });
        return;
      }
    }
    onFirstToken?.();
    if (!DEBUG) {
      this.port.postMessage({ type: 'metric', data: { ttftMs: Math.round(ttft), totalMs: Math.round(performance.now() - t0) } });
    } else {
      this.port.postMessage({
        type: 'metric',
        data: {
          model: provider.model,
          expert: expert.id,
          attempt: jobs[0]!.attempt,
          segments: jobs.length,
          chars: sources.reduce((n, s) => n + s.length, 0),
          ttftMs: Math.round(ttft),
          totalMs: Math.round(performance.now() - t0),
          accepted: accepted.size,
          // [prompt, cacheHit, completion]; plain array because some tooling redacts *token* keys.
          tok: usage ? [usage.promptTokens, usage.cacheHitTokens, usage.completionTokens] : null,
          rejects,
        },
      });
    }

    jobs.forEach((j, i) => {
      if (!accepted.has(i)) failed.push(j);
    });
    if (!failed.length || signal.aborted) return;

    const next = failed.map((j) => ({ ...j, attempt: j.attempt + 1 }));
    const give = next.filter((j) => j.attempt > MAX_ATTEMPT);
    if (give.length) this.port.postMessage({ type: 'error', ids: give.map((j) => j.id), message: '多次重试后译文仍未通过校验' });
    const retry = next.filter((j) => j.attempt <= MAX_ATTEMPT);
    if (!retry.length) return;

    // Retry ladder: half the batch, then one by one, then one by one without tags.
    const size = retry[0]!.attempt === 1 ? Math.max(1, Math.ceil(jobs.length / 2)) : 1;
    const s = this.getSettings();
    await Promise.all(
      packBatches(retry, s.batchChars, size).map((b) => this.runBatch(ctx, expert, provider, b, signal)),
    );
  }

  // ---------- preprocess ----------

  private async preprocess(ctx: PageContext, article: string): Promise<void> {
    const s = this.getSettings();
    if (s.preprocess === 'off' || this.pages.has(ctx.url) || this.preprocessing.has(ctx.url)) return;
    const provider = this.mainProvider();
    if (!providerReady(provider)) return;
    this.preprocessing.add(ctx.url);
    try {
      const key = await this.preprocessKey(provider, ctx.url);
      const t0 = performance.now();
      let raw = (await cacheGetMany([key]))[0];
      const cachedPre = raw !== undefined;
      if (raw === undefined) {
        const sceneIds = s.experts.map((e) => e.id);
        const res = await completeChat(provider, buildPreprocessMessages(ctx.title, article, sceneIds), this.abort.signal);
        recordUsage(provider, res.usage);
        raw = res.text;
        void cachePut(key, raw).catch(() => {});
      }
      const info = parsePreprocess(raw, s.experts);
      this.setPageInfo(ctx.url, info);
      if (DEBUG) {
        this.port.postMessage({
          type: 'metric',
          data: { kind: 'preprocess', cached: cachedPre, ms: Math.round(performance.now() - t0), ...info },
        });
      }
    } catch (e) {
      console.debug('[xt] preprocess failed', e);
    } finally {
      this.preprocessing.delete(ctx.url);
    }
  }

  // ---------- 精翻 ----------

  private async refine(ctx: PageContext, seg: SegmentPayload, override?: string): Promise<void> {
    const s = this.getSettings();
    const provider = this.usable(s.refineProviderId) ?? this.mainProvider();
    const expert = this.expertFor(ctx, override);
    const hits = findHits(this.glossaryFor(ctx), seg.text);
    const input = { expert, glossary: hits, title: ctx.title, topic: this.pages.get(ctx.url)?.topic, source: seg.text };
    try {
      const draft = await completeChat(provider, buildRefineDraftMessages(input), this.abort.signal, 'deep');
      recordUsage(provider, draft.usage);
      const improved = await completeChat(provider, buildRefineImproveMessages(input, draft.text), this.abort.signal, 'deep');
      recordUsage(provider, improved.usage);
      // Prefer the improved text unless it broke the inline tags the draft kept.
      const best = !tagsMatch(seg.text, improved.text) && tagsMatch(seg.text, draft.text) ? draft.text : improved.text;
      const text = s.autoSpace ? polishChinese(sanitizeMarkup(seg.text, best)) : sanitizeMarkup(seg.text, best);
      this.port.postMessage({ type: 'refined', id: seg.id, text });
      // Overwrite the normal cache entry so the refined version survives reloads.
      const main = this.providerFor(seg.text, hits, expert.id);
      void cachePut(await this.cacheKey(main, expert, hits, seg.text), text).catch(() => {});
    } catch (e) {
      if (!this.abort.signal.aborted) {
        this.port.postMessage({ type: 'error', ids: [seg.id], message: `精翻失败：${(e as Error).message}` });
      }
    }
  }
}

export function parsePreprocess(raw: string, experts: Expert[]): PageInfo {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { terms: [] };
  try {
    const j = JSON.parse(m[0]);
    const terms: GlossaryEntry[] = Array.isArray(j.terms)
      ? j.terms
          .filter((t: any) => typeof t?.src === 'string' && typeof t?.tgt === 'string' && t.src.trim() && t.tgt.trim())
          .slice(0, 15)
          .map((t: any) => ({ src: t.src.trim(), tgt: t.tgt.trim() === 'KEEP' ? KEEP : t.tgt.trim() }))
          // A term that is itself markup would corrupt tag validation.
          .filter((t: GlossaryEntry) => !/<\/?[a-z]?\d+>|\{\{\d+\}\}/.test(t.src))
      : [];
    const scene = typeof j.scene === 'string' && experts.some((e) => e.id === j.scene) ? j.scene : undefined;
    return { topic: typeof j.topic === 'string' ? j.topic.slice(0, 300) : undefined, terms, scene };
  } catch {
    return { terms: [] };
  }
}
