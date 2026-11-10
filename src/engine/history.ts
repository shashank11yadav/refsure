// The last check of each paper, so reopening a paper shows its results at once.
// Local only, capped by count and by size (no unlimitedStorage permission), and switched off by
// `historyEnabled`. Clearing it also clears the result cache.
import { browser } from 'wxt/browser';
import type { CheckResult, CheckSummary } from '../core/types';
import { clearAllCaches, isQuotaError } from './cache';
import { getSettings } from './settings';

export const HISTORY_KEY = 'refsure:history';
export const HISTORY_MAX_PAPERS = 50;
export const HISTORY_MAX_BYTES = 3 * 1024 * 1024;
const QUOTA_EVICT_FRACTION = 0.25;

interface Saved {
  summary: CheckSummary;
  results: CheckResult[];
}

function isSaved(value: unknown): value is Saved {
  if (typeof value !== 'object' || value === null) return false;
  const { summary, results } = value as Record<string, unknown>;
  if (typeof summary !== 'object' || summary === null || !Array.isArray(results)) return false;
  const paper = (summary as Record<string, unknown>)['paper'];
  return typeof paper === 'object' && paper !== null && typeof (paper as Record<string, unknown>)['key'] === 'string';
}

async function load(): Promise<Saved[]> {
  const stored = (await browser.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  const papers = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>)['papers'] : undefined;
  return Array.isArray(papers) ? papers.filter(isSaved) : [];
}

// Saves and clears are read-modify-write on one key; run them one at a time, in order.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job, job);
  queue = result.catch(() => undefined);
  return result;
}

let epoch = 0;

/**
 * Changes whenever history is cleared. A caller reads it when a check starts and passes it to
 * `saveSummary`, so a check that was running during a clear cannot bring the cleared data back.
 */
export function getHistoryEpoch(): number {
  return epoch;
}

const sizeOf = (papers: Saved[]): number => JSON.stringify({ papers }).length;

/**
 * Keeps the last check of each paper. Never rejects for storage reasons: history is a convenience, so a
 * full or failing store means the check is simply not remembered.
 */
export async function saveSummary(s: CheckSummary, results: CheckResult[], forEpoch?: number): Promise<void> {
  if (forEpoch !== undefined && forEpoch !== epoch) return;
  if (!(await getSettings()).historyEnabled) return;
  await enqueue(async () => {
    if (forEpoch !== undefined && forEpoch !== epoch) return;
    const added: Saved = { summary: s, results };
    // Oldest first: the most recently finished check is the last to be dropped.
    let papers = [...(await load()).filter((saved) => saved.summary.paper.key !== s.paper.key), added].sort(
      (a, b) => (a.summary.finishedAt ?? a.summary.startedAt) - (b.summary.finishedAt ?? b.summary.startedAt),
    );
    papers = papers.slice(-HISTORY_MAX_PAPERS);
    while (papers.length > 1 && sizeOf(papers) > HISTORY_MAX_BYTES) papers = papers.slice(1);
    // One check alone over the cap is not kept.
    if (sizeOf(papers) > HISTORY_MAX_BYTES) return;
    try {
      await browser.storage.local.set({ [HISTORY_KEY]: { papers } });
    } catch (error) {
      if (!isQuotaError(error)) return;
      // Storage is full: drop the oldest quarter and try once more.
      const keep = papers.slice(Math.ceil(papers.length * QUOTA_EVICT_FRACTION));
      try {
        await browser.storage.local.set({ [HISTORY_KEY]: { papers: keep } });
      } catch {
        console.warn('[RefSure] Could not save check history');
      }
    }
  });
}

export async function getLast(paperKey: string): Promise<{ summary: CheckSummary; results: CheckResult[] } | undefined> {
  if (!(await getSettings()).historyEnabled) return undefined;
  return (await load()).find((saved) => saved.summary.paper.key === paperKey);
}

/**
 * Deletes every saved check and every cached lookup result. Both are attempted even if one fails; the
 * first failure is then reported. Saves that began before this call are ignored (see `getHistoryEpoch`).
 */
export async function clearHistory(): Promise<void> {
  epoch++;
  const settled = await Promise.allSettled([enqueue(() => browser.storage.local.remove(HISTORY_KEY)), clearAllCaches()]);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}
