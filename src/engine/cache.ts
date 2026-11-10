// Result cache, so a second check of the same citation costs no lookups.
// Keys are citation identifiers, normalised titles and the normalised words of the author part only; the cited
// text itself is not stored here.
// "Can't check" is never cached: it describes a bad moment, not the citation.
//
// The cache lives in memory (loaded from browser.storage.local once, on first use) and is written back
// in batches, so a check never waits on storage. It is capped by entry count and by approximate
// serialised size (no unlimitedStorage permission), oldest entries first out. A write that hits the
// storage quota drops the oldest quarter and retries once; after that the cache gives up silently, since
// it is only an optimisation. It writes its own key only: settings can never fail because of it.
import { browser } from 'wxt/browser';
import { TTL } from '../config';
import { authorZoneFingerprint } from '../core/authorZone';
import { stripArxivVersion } from '../core/identifiers';
import { journalLocator, journalNameExtraWords, locatorKey } from '../core/journalLocator';
import { normalizeTitle } from '../core/normalize';
import type { CheckResult, ParsedCitation, Status } from '../core/types';

export interface Cache {
  get(key: string): Promise<CheckResult | undefined>;
  /** `epoch` is the value of `epoch()` when the check began; a write from before a `clear` is dropped. */
  set(key: string, value: CheckResult, epoch?: number): Promise<void>;
  clear(): Promise<void>;
  /** Writes pending changes to storage now. */
  flush?(): Promise<void>;
  /** Changes whenever the cache is cleared. */
  epoch?(): number;
}

export type StoredCache = Cache & { flush(): Promise<void>; epoch(): number };

export const CACHE_KEY = 'refsure:cache';
export const CACHE_MAX_ENTRIES = 5000;
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const CACHE_FLUSH_MS = 500;
/** Fraction of the oldest entries dropped when storage reports it is full. */
const QUOTA_EVICT_FRACTION = 0.25;

/**
 * Every identifier present (DOI, then arXiv ID without its version), then normalised title + first
 * surname + year; with no identifier, the title part alone. The cited title, first surname and year are
 * part of an identifier key too: a verdict compares the citation with the record, so the same DOI cited
 * under another title must not inherit the first citation's verdict. Both identifiers are in the key
 * because a verdict looks both up: the same DOI beside a different arXiv ID can be a different verdict.
 * The verdict also rests on who the reference names (a DOI typo or a wrong identifier is caught by the names
 * not matching), so the key carries a fingerprint of the whole author zone: the same DOI, title and year cited
 * under other names must not inherit an earlier citation's verdict. A title-less reading also carries the words of its
 * journal's name that are not a journal's (journalNameExtraWords): they may be a title, compared with the record.
 */
export function cacheKey(c: ParsedCitation): string | undefined {
  const title = c.title === undefined ? '' : normalizeTitle(c.title);
  const zone = authorZoneFingerprint(c);
  // A title-less reading whose journal's name holds other words than a journal's is judged on them too (they may be a title).
  const extra = journalNameExtraWords(c);
  const detail = `${title}|${c.authors[0] ?? ''}|${c.year ?? ''}${zone === '' ? '' : `|${zone}`}${extra === '' ? '' : `|j:${extra}`}`;
  const ids: string[] = [];
  if (c.doi !== undefined) ids.push(`doi:${c.doi.toLowerCase()}`);
  if (c.arxivId !== undefined) ids.push(`arxiv:${stripArxivVersion(c.arxivId)}`);
  if (ids.length > 0) return `${ids.join('|')}|${detail}`;
  if (title !== '') return `t:${detail}`;
  // A journal citation with no title is the same article whenever journal, volume, page, year and names agree.
  const locator = journalLocator(c);
  return locator === undefined ? undefined : `j:${locatorKey(locator)}|${zone}${extra === '' ? '' : `|j:${extra}`}`;
}

type Stored = Omit<CheckResult, 'index' | 'label' | 'citedText'>;

interface Entry {
  k: string;
  /** Expiry time, ms since the epoch. */
  e: number;
  v: Stored;
}

/** An entry in memory, with its approximate serialised size. */
interface Held extends Entry {
  size: number;
}

function ttlFor(status: Status): number {
  switch (status) {
    // These all involved a retraction lookup, so they expire on the shorter retraction clock.
    case 'verified':
    case 'details_differ':
    case 'retracted':
      return TTL.retractionMs;
    case 'wrong_id':
      return TTL.recordMs;
    case 'not_found':
      return TTL.negativeMs;
    case 'cant_check':
      return 0;
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  const v = e['v'];
  return typeof e['k'] === 'string' && typeof e['e'] === 'number' && typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>)['status'] === 'string';
}

function held(entry: Entry): Held {
  return { ...entry, size: JSON.stringify(entry).length + 1 };
}

export function isQuotaError(error: unknown): boolean {
  return /quota/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
}

// Every cache in this context, so clearing history empties them all, not just the caller's.
const live = new Set<StoredCache>();

export function createCache(now: () => number = Date.now, maxEntries: number = CACHE_MAX_ENTRIES, maxBytes: number = CACHE_MAX_BYTES): StoredCache {
  /** Oldest first. Undefined until loaded. */
  let mem: Map<string, Held> | undefined;
  let loading: Promise<void> | undefined;
  let bytes = 0;
  let dirty = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removing = false;
  // Storage jobs (flush, clear) run one at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = queue.then(job, job);
    queue = result.catch(() => undefined);
    return result;
  };

  const reset = (): void => {
    mem = new Map();
    loading = Promise.resolve();
    bytes = 0;
    dirty = false;
    epoch++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  async function ensureLoaded(): Promise<Map<string, Held>> {
    loading ??= (async () => {
      let entries: Entry[] = [];
      try {
        const stored = (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY];
        const list = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>)['entries'] : undefined;
        entries = Array.isArray(list) ? list.filter(isEntry) : [];
      } catch {
        // Unreadable storage: start empty.
      }
      // A clear that happened while reading wins.
      if (mem !== undefined) return;
      mem = new Map();
      for (const entry of entries) {
        const h = held(entry);
        mem.set(h.k, h);
        bytes += h.size;
      }
      trim();
    })();
    await loading;
    return mem ?? new Map();
  }

  function drop(key: string): void {
    const h = mem?.get(key);
    if (h === undefined) return;
    mem?.delete(key);
    bytes -= h.size;
  }

  function trim(): void {
    if (mem === undefined) return;
    for (const key of mem.keys()) {
      if (mem.size <= maxEntries && bytes <= maxBytes) break;
      drop(key);
    }
  }

  function scheduleFlush(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      void flush();
    }, CACHE_FLUSH_MS);
  }

  async function write(): Promise<void> {
    if (mem === undefined) return;
    const t = now();
    for (const [key, h] of mem) if (h.e <= t) drop(key);
    const entries = [...mem.values()].map(({ k, e, v }) => ({ k, e, v }));
    await browser.storage.local.set({ [CACHE_KEY]: { entries } });
  }

  function flush(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const scheduledIn = epoch;
    return enqueue(async () => {
      if (!dirty || mem === undefined || scheduledIn !== epoch) return;
      dirty = false;
      try {
        await write();
      } catch (error) {
        if (scheduledIn !== epoch) return;
        if (!isQuotaError(error)) {
          dirty = true;
          return;
        }
        // Storage is full: drop the oldest quarter and try once more, then give up.
        let toDrop = Math.ceil((mem?.size ?? 0) * QUOTA_EVICT_FRACTION);
        for (const key of mem?.keys() ?? []) {
          if (toDrop-- <= 0) break;
          drop(key);
        }
        try {
          await write();
        } catch {
          dirty = true;
        }
      }
    });
  }

  const cache: StoredCache = {
    async get(key) {
      const m = await ensureLoaded();
      const hit = m.get(key);
      if (hit === undefined || hit.e <= now()) return undefined;
      // The per-paper fields are filled in by the caller.
      return { index: 0, label: '', citedText: '', ...hit.v };
    },

    async set(key, value, forEpoch) {
      const ttl = ttlFor(value.status);
      if (ttl === 0) return;
      const m = await ensureLoaded();
      if (forEpoch !== undefined && forEpoch !== epoch) return;
      const v: Stored = { status: value.status, reason: value.reason, ...(value.match !== undefined && { match: value.match }), diffs: value.diffs, notes: value.notes, sourcesSearched: value.sourcesSearched, sourcesFailed: value.sourcesFailed, links: value.links };
      drop(key);
      const h = held({ k: key, e: now() + ttl, v });
      m.set(key, h);
      bytes += h.size;
      trim();
      dirty = true;
      scheduleFlush();
    },

    flush,

    epoch: () => epoch,

    clear() {
      reset();
      return enqueue(async () => {
        removing = true;
        try {
          await browser.storage.local.remove(CACHE_KEY);
        } finally {
          removing = false;
        }
      });
    },
  };

  // The panel's clear goes to the background (`history:clear`), which clears its own caches through clearAllCaches.
  // A removal made any other way, by another context or another cache object, must not leave this one serving what
  // it still holds: forget it too.
  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[CACHE_KEY];
    if (area === 'local' && change !== undefined && (change.newValue === undefined || change.newValue === null) && !removing) reset();
  });

  live.add(cache);
  return cache;
}

let shared: StoredCache | undefined;

/** The cache the extension itself uses: one per context, so its memory is shared by every run. */
export function defaultCache(): StoredCache {
  shared ??= createCache();
  return shared;
}

/** Empties every cache in this context, in memory and in storage. Rejects if any could not be cleared. */
export async function clearAllCaches(): Promise<void> {
  // Also remove the stored blob directly: a cache from an earlier run of this context may not exist yet.
  const settled = await Promise.allSettled([browser.storage.local.remove(CACHE_KEY), ...[...live].map((c) => c.clear())]);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}
