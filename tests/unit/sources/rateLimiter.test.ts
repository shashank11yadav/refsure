import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRateLimiter } from '../../../src/sources/rateLimiter';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function at(values: number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`no start recorded at index ${index}`);
  return value;
}

/** A job that records when it started and finishes after `ms`. */
function timedJob(starts: number[], ms: number) {
  return async () => {
    starts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
}

describe('createRateLimiter', () => {
  test('limiter never exceeds ratePerSec and maxConcurrent', async () => {
    const limiter = createRateLimiter({ ratePerSec: 2, maxConcurrent: 2 });
    const starts: number[] = [];
    let running = 0;
    let peak = 0;
    const job = async () => {
      starts.push(Date.now());
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      running -= 1;
    };
    const all = Promise.all(Array.from({ length: 6 }, () => limiter.schedule(job)));
    await vi.advanceTimersByTimeAsync(20_000);
    await all;

    expect(peak).toBeLessThanOrEqual(2);
    expect(starts).toHaveLength(6);
    // At most ratePerSec starts in any one-second window.
    for (const t of starts) {
      expect(starts.filter((s) => s >= t && s < t + 1000).length).toBeLessThanOrEqual(2);
    }
  });

  test('starts are spaced by 1/ratePerSec even with spare concurrency', async () => {
    const limiter = createRateLimiter({ ratePerSec: 1, maxConcurrent: 5 });
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 3 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(at(starts, 1) - at(starts, 0)).toBeGreaterThanOrEqual(1000);
    expect(at(starts, 2) - at(starts, 1)).toBeGreaterThanOrEqual(1000);
  });

  test('passes through results and rejections, and a failed job frees its slot', async () => {
    const limiter = createRateLimiter({ ratePerSec: 10, maxConcurrent: 1 });
    const results = Promise.allSettled([
      limiter.schedule(() => Promise.resolve(42)),
      limiter.schedule(() => Promise.reject(new Error('boom'))),
      limiter.schedule(() => {
        throw new Error('sync boom');
      }),
      limiter.schedule(() => Promise.resolve('ok')),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const settled = await results;
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'fulfilled']);
    expect(settled[0]).toMatchObject({ value: 42 });
    expect(settled[1]).toMatchObject({ reason: { message: 'boom' } });
    expect(settled[2]).toMatchObject({ reason: { message: 'sync boom' } });
    expect(settled[3]).toMatchObject({ value: 'ok' });
  });

  test('limiter lowers its rate from x-rate-limit-limit / x-rate-limit-interval headers', async () => {
    const limiter = createRateLimiter({ ratePerSec: 3, maxConcurrent: 3 });
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '2s' }));
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 3 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(at(starts, 1) - at(starts, 0)).toBeGreaterThanOrEqual(2000);
    expect(at(starts, 2) - at(starts, 1)).toBeGreaterThanOrEqual(2000);
  });

  test('headers never raise the rate above the configured one', async () => {
    const limiter = createRateLimiter({ ratePerSec: 1, maxConcurrent: 3 });
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '50', 'x-rate-limit-interval': '1s' }));
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 2 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(at(starts, 1) - at(starts, 0)).toBeGreaterThanOrEqual(1000);
  });

  test('understands minute intervals and ignores malformed headers', async () => {
    const limiter = createRateLimiter({ ratePerSec: 3, maxConcurrent: 3 });
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': 'lots', 'x-rate-limit-interval': 'soon' }));
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '0', 'x-rate-limit-interval': '1s' }));
    limiter.updateFromHeaders(new Headers());
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '6', 'x-rate-limit-interval': '1m' })); // 0.1/s
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 2 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    expect(at(starts, 1) - at(starts, 0)).toBeGreaterThanOrEqual(10_000);
  });

  test('pauseFor delays jobs that have not started', async () => {
    const limiter = createRateLimiter({ ratePerSec: 100, maxConcurrent: 5 });
    limiter.pauseFor(3000);
    const starts: number[] = [];
    const t0 = Date.now();
    const p = limiter.schedule(() => Promise.resolve(void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(2999);
    expect(starts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(at(starts, 0) - t0).toBeGreaterThanOrEqual(3000);
  });

  test('a later, shorter pause never shortens an earlier one', async () => {
    const limiter = createRateLimiter({ ratePerSec: 100, maxConcurrent: 5 });
    limiter.pauseFor(5000);
    limiter.pauseFor(100);
    const starts: number[] = [];
    const p = limiter.schedule(() => Promise.resolve(void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(4999);
    expect(starts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(starts).toHaveLength(1);
  });

  test('aborting the signal rejects queued jobs without calling fn', async () => {
    const limiter = createRateLimiter({ ratePerSec: 1, maxConcurrent: 1 });
    const first = limiter.schedule(() => new Promise<void>((resolve) => setTimeout(resolve, 5000)));
    const fn = vi.fn(() => Promise.resolve('never'));
    const controller = new AbortController();
    const queued = limiter.schedule(fn, controller.signal);
    const assertion = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    expect(fn).not.toHaveBeenCalled();
  });

  test('an already-aborted signal rejects immediately without calling fn', async () => {
    const limiter = createRateLimiter({ ratePerSec: 10, maxConcurrent: 1 });
    const fn = vi.fn(() => Promise.resolve('never'));
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.schedule(fn, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  test('an aborted job does not block the jobs behind it', async () => {
    const limiter = createRateLimiter({ ratePerSec: 1, maxConcurrent: 1 });
    const first = limiter.schedule(() => Promise.resolve(1));
    const controller = new AbortController();
    const middle = limiter.schedule(() => Promise.resolve(2), controller.signal);
    const last = limiter.schedule(() => Promise.resolve(3));
    const assertion = expect(middle).rejects.toBeDefined();
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(5000);
    await expect(first).resolves.toBe(1);
    await expect(last).resolves.toBe(3);
  });

  test('rejects nonsensical settings', () => {
    expect(() => createRateLimiter({ ratePerSec: 0, maxConcurrent: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ ratePerSec: Number.NaN, maxConcurrent: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ ratePerSec: 1, maxConcurrent: 0 })).toThrow(RangeError);
  });

  test('a tiny or absurd rate header cannot stall the queue', async () => {
    const limiter = createRateLimiter({ ratePerSec: 3, maxConcurrent: 3 });
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '0.0000001', 'x-rate-limit-interval': '1s' }));
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '999999999s' }));
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': 'Infinity', 'x-rate-limit-interval': '1s' }));
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 3 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(5000);
    await all;
    expect(starts).toHaveLength(3);
  });

  test('a plausible but very slow rate is floored and no gap exceeds 30 s', async () => {
    const limiter = createRateLimiter({ ratePerSec: 3, maxConcurrent: 3 });
    limiter.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '3600s' }));
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 3 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(61_000);
    await all;
    expect(at(starts, 1) - at(starts, 0)).toBeLessThanOrEqual(30_000);
    expect(at(starts, 2) - at(starts, 1)).toBeLessThanOrEqual(30_000);
    expect(at(starts, 1) - at(starts, 0)).toBeGreaterThanOrEqual(1000);
  });

  test('a configured rate below the floor is raised to it', async () => {
    const limiter = createRateLimiter({ ratePerSec: 1e-9, maxConcurrent: 1 });
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 2 }, () => limiter.schedule(timedJob(starts, 1))));
    await vi.advanceTimersByTimeAsync(31_000);
    await all;
    expect(starts).toHaveLength(2);
  });

  test('pauseFor is capped at 30 s', async () => {
    const limiter = createRateLimiter({ ratePerSec: 100, maxConcurrent: 5 });
    limiter.pauseFor(3_600_000);
    const starts: number[] = [];
    const p = limiter.schedule(() => Promise.resolve(void starts.push(Date.now())));
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(starts).toHaveLength(1);
  });
});
