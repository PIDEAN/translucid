/** Greedy packing by character budget and segment count. A single oversized item gets its own batch. */
export function packBatches<T extends { text: string }>(items: T[], maxChars: number, maxSegments: number): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const item of items) {
    const len = item.text.length;
    if (cur.length && (chars + len > maxChars || cur.length >= maxSegments)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(item);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(public limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * Per-provider admission control: a concurrency cap, an optional
 * requests-per-minute window, and back-off after rate-limit errors (pause new
 * requests for Retry-After, halve concurrency, restore after a quiet minute).
 */
export class ProviderGate {
  private active = 0;
  /** Callers waiting for a slot (queued or sleeping on RPM / back-off). */
  private queued = 0;
  private waiters: (() => void)[] = [];
  private starts: number[] = [];
  private pausedUntil = 0;
  private throttledUntil = 0;
  private reduced = 1;
  /** Consecutive rate-limit / overload errors since the last success. */
  private strikes = 0;

  constructor(
    public concurrency: number,
    public rpm = 0,
    private now: () => number = Date.now,
  ) {}

  /** Concurrency in force right now (reduced for a minute after a 429). */
  get limit(): number {
    return this.throttledUntil > this.now() ? Math.min(this.concurrency, this.reduced) : this.concurrency;
  }

  /** Lanes nobody is using or waiting for; new work should be split across these only. */
  get freeLanes(): number {
    return Math.max(0, this.limit - this.active - this.queued);
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.queued++;
    try {
      await this.acquire(signal);
    } finally {
      this.queued--;
    }
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  /** Waits for a slot; an abort while queued rejects and leaves the queue (overflow to a fallback). */
  private async acquire(signal?: AbortSignal): Promise<void> {
    const aborted = () => new DOMException('aborted', 'AbortError');
    for (;;) {
      if (signal?.aborted) throw aborted();
      if (this.active >= this.limit) {
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            const i = this.waiters.indexOf(wake);
            if (i >= 0) this.waiters.splice(i, 1);
            reject(aborted());
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          this.waiters.push(wake);
        });
        continue;
      }
      const now = this.now();
      const wait = Math.max(this.pausedUntil - now, this.rpmWait(now));
      if (wait > 0) {
        await sleep(wait, signal);
        continue;
      }
      this.active++;
      if (this.rpm > 0) this.starts.push(now);
      return;
    }
  }

  private rpmWait(now: number): number {
    if (this.rpm <= 0) return 0;
    while (this.starts.length && now - this.starts[0]! >= 60_000) this.starts.shift();
    return this.starts.length < this.rpm ? 0 : this.starts[0]! + 60_000 - now;
  }

  /**
   * Circuit breaker: repeatedly throttled within the back-off minute (free tiers under
   * load answer 429 "model overloaded" for minutes). New work should go elsewhere.
   */
  get tripped(): boolean {
    return this.strikes >= 2 && this.throttledUntil > this.now();
  }

  success(): void {
    this.strikes = 0;
  }

  /** Rate limited or overloaded: pause, then run at half concurrency for a minute. */
  backoff(retryAfterMs?: number): void {
    const now = this.now();
    this.strikes++;
    this.pausedUntil = Math.max(this.pausedUntil, now + (retryAfterMs ?? 2000));
    this.reduced = Math.max(1, Math.floor(this.limit / 2));
    this.throttledUntil = now + 60_000;
  }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
