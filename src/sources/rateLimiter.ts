// Paces requests to one lookup service: a minimum gap between request starts,
// a cap on requests in flight, and a way to back off when the service asks.

export interface RateLimiter {
  /** Runs `fn` when a slot is free. Aborting `signal` drops it from the queue unstarted. */
  schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Lowers the rate to what the service's `x-rate-limit-*` headers announce. Never raises it. */
  updateFromHeaders(headers: Headers): void;
  /** Starts nothing new for `ms` (for example after a 429), at most 30 s. A shorter pause never cuts a longer one. */
  pauseFor(ms: number): void;
}

interface Job {
  run: () => void;
}

/** No wait, whether computed from a rate or from a service's request, is allowed to exceed this. */
export const MAX_DELAY_MS = 30_000;
/** Slowest rate we will ever apply (one request a minute; the delay cap makes it effectively 1 per 30 s). */
const MIN_RATE_PER_SEC = 1 / 60;
/** Headers outside these bounds are noise or an attack, not a rate limit: ignore them. */
const PLAUSIBLE_LIMIT = { min: 1, max: 1_000_000 };
const MAX_PLAUSIBLE_INTERVAL_SECONDS = 86_400;

const INTERVAL_UNITS_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 };

/** "1s", "10s", "1m", or bare seconds. */
function parseIntervalSeconds(value: string | null): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  const seconds = Number(match[1]) * (INTERVAL_UNITS_SECONDS[(match[2] ?? '').toLowerCase()] ?? 1);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function createRateLimiter(options: { ratePerSec: number; maxConcurrent: number }): RateLimiter {
  const { maxConcurrent } = options;
  if (!Number.isFinite(options.ratePerSec) || options.ratePerSec <= 0) {
    throw new RangeError('ratePerSec must be a positive number');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }

  let ratePerSec = Math.max(options.ratePerSec, MIN_RATE_PER_SEC);
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];

  function pump(): void {
    if (timer !== undefined) return;
    while (queue.length > 0 && active < maxConcurrent) {
      const now = Date.now();
      const readyAt = Math.max(lastStartAt + Math.min(1000 / ratePerSec, MAX_DELAY_MS), pausedUntil);
      if (now < readyAt) {
        timer = setTimeout(() => {
          timer = undefined;
          pump();
        }, readyAt - now);
        return;
      }
      const job = queue.shift();
      if (!job) return;
      lastStartAt = now;
      active += 1;
      job.run();
    }
  }

  function schedule<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        const at = queue.indexOf(job);
        if (at === -1) return;
        queue.splice(at, 1);
        reject(abortReason(signal as AbortSignal));
      };
      const job: Job = {
        run: () => {
          signal?.removeEventListener('abort', onAbort);
          let result: Promise<T>;
          try {
            result = Promise.resolve(fn());
          } catch (error) {
            result = Promise.reject(error);
          }
          result.then(resolve, reject).finally(() => {
            active -= 1;
            pump();
          });
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(job);
      pump();
    });
  }

  function updateFromHeaders(headers: Headers): void {
    const limit = Number(headers.get('x-rate-limit-limit'));
    const intervalSeconds = parseIntervalSeconds(headers.get('x-rate-limit-interval'));
    if (!Number.isFinite(limit) || limit < PLAUSIBLE_LIMIT.min || limit > PLAUSIBLE_LIMIT.max) return;
    if (intervalSeconds === undefined || intervalSeconds > MAX_PLAUSIBLE_INTERVAL_SECONDS) return;
    ratePerSec = Math.max(MIN_RATE_PER_SEC, Math.min(ratePerSec, limit / intervalSeconds));
  }

  function pauseFor(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(ms, MAX_DELAY_MS));
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      pump();
    }
  }

  return { schedule, updateFromHeaders, pauseFor };
}
