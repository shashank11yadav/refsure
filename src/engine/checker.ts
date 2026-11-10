// Checks references against the lookup services (DESIGN section 7.2).
//
// The rules that keep this honest:
//  * "Not found" needs every required source to have answered. A source that failed, was offline, or ran
//    out of budget turns the result into "Can't check" (classify enforces it; this file reports faithfully).
//  * A failed retraction lookup never says "retracted"; the match keeps its status with a note.
//  * "Can't check" is never cached. With history off, nothing is cached at all.
//  * Only a strong match (almost the same title, genuinely agreeing authors, a compatible year; see isStrongMatch)
//    can be called Retracted or trigger a retraction lookup, whether it was found by id or by search. A near miss
//    is shown as Details differ at most. The search stops only on a strong match.
//  * An identifier whose record has no usable title says nothing: it is never a Wrong ID.
//  * A journal citation with no title is looked up in Crossref by journal, volume, page and year. It can become
//    Verified or Retracted; every other outcome leaves it Can't check, as it was (lookUpByJournal). So is a Nature-style
//    entry that its title path leaves Not found or unreadable, for a record that carries its title. Any other titled
//    entry with a full locator that the title path leaves Not found gets one locator request, for such a record too.
//  * A PDF entry cut from a line that held two (RawReference.partial) is never Not found, Wrong ID or Details differ.
//  * An entry that cites several works is Can't check, unless its first part is a complete work: then that part is
//    checked alone, and its Verified is still shown as Can't check (firstWork.ts).
//  * UrlNotAllowedError is a bug in the caller, so it is never swallowed.
import { parseCitation } from '../core/parseCitation';
import { cantCheck, carriesCitedTitle, citesLaterVersion, classify, comparedWith, effectiveCitation, hasTitle, hasUsableTitle, isConfidentMatch, isCredibleTitle, isOldPaperVerdict, isStrongMatch, isUnreadable, isVerifiedOnlyLookup, isWrongId, LOCATOR_NO_RECORD, locatorVerdict, pickBest, pickStrong, preLookupVerdict, SEVERAL_WORKS_REASON, UNREADABLE, verifiedOnlyVerdict, type Verdict } from '../core/classify';
import { firstWorkOf, firstWorkVerdict } from '../core/firstWork';
import { arxivUrl, doiUrl, openreviewUrl, stripArxivVersion } from '../core/identifiers';
import { carriesLocatorNumbers, journalLocator, locatorMatch, locatorNamesAuthors, locatorReadingPastNonPaperDoi, matchesLocator, mayBeJournalStart, natureStyleLocatorReading, titledLocatorReading, titleIsJournal } from '../core/journalLocator';
import { locatorFirstSurname, publisherDoi } from '../core/locatorHints';
import { emptyCounts, joinAnd, SOURCE_NAME } from '../core/status';
import { REQUIRED_SOURCES } from '../core/types';
import type { CheckResult, CheckSummary, PaperInfo, ParsedCitation, RawReference, SourceName, Status, WorkRecord } from '../core/types';
import { RATE } from '../config';
import { arxiv } from '../sources/arxiv';
import { crossref } from '../sources/crossref';
import { dblp } from '../sources/dblp';
import { RefusedRedirectError, setRetryRule, SourceError, UrlNotAllowedError } from '../sources/http';
import { openalex } from '../sources/openalex';
import { openreview } from '../sources/openreview';
import { abortReason } from '../sources/rateLimiter';
import { retraction } from '../sources/retraction';
import type { Source } from '../sources/source';
import { cacheKey, defaultCache, type Cache } from './cache';
import { applyOpenAlexKey, getSettings } from './settings';

export interface EngineDeps {
  sources: Record<SourceName, Source> & {
    arxiv: Source & { lookupMany?(ids: string[], signal?: AbortSignal): Promise<Map<string, WorkRecord>> };
    /**
     * Candidates for a journal citation with no title; a source without it simply never matches one. `searchLocatorAgain`
     * is the one further request made when the first candidates hold no match.
     */
    crossref: Source & {
      searchLocator?(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]>;
      searchLocatorAgain?(c: ParsedCitation, signal?: AbortSignal): Promise<WorkRecord[]>;
    };
  };
  retraction: { check: typeof retraction.check };
  cache: Cache;
  now: () => number;
}

/** Cheapest and most permissive first; metered OpenAlex last (DESIGN section 7.2). */
const SEARCH_ORDER: readonly SourceName[] = ['crossref', 'arxiv', 'openreview', 'dblp', 'openalex'];
/** References in flight at once. The per-source gates, not this, decide how hard any one service is hit. */
const REFERENCE_WORKERS = 12;
const AMBIGUOUS_COPIES = "Two records match this reference and one of them is retracted. Couldn't tell which one is meant";
const OFFLINE_REASON = 'You appear to be offline. Check your connection and try again';

// One sources object for the life of the context: the per-source gates are keyed on it, so every run shares them.
const DEFAULT_SOURCES: EngineDeps['sources'] = { crossref, arxiv, openreview, dblp, openalex };

export function defaultDeps(): EngineDeps {
  return { sources: DEFAULT_SOURCES, retraction, cache: defaultCache(), now: Date.now };
}

// ------------------------------------------------------------------ helpers

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** At most `max` calls to one source at a time, in arrival order. Waiting callers leave the queue on abort. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (this.active < this.max) {
      this.active++;
    } else {
      // The slot is handed over by the call that finishes, so `active` never overshoots `max`.
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const i = this.waiting.indexOf(wake);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(abortReason(signal));
        };
        this.waiting.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    try {
      throwIfAborted(signal);
      return await fn();
    } finally {
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.active--;
      else waiter();
    }
  }
}

// Per sources object, so every check run against the same sources shares the same gates.
const gateSets = new WeakMap<object, Record<SourceName, Gate>>();

function gatesFor(sources: EngineDeps['sources']): Record<SourceName, Gate> {
  let gates = gateSets.get(sources);
  if (gates === undefined) {
    gates = {
      crossref: new Gate(RATE.crossref.maxConcurrent),
      arxiv: new Gate(RATE.arxiv.maxConcurrent),
      openreview: new Gate(RATE.openreview.maxConcurrent),
      dblp: new Gate(RATE.dblp.maxConcurrent),
      openalex: new Gate(RATE.openalex.maxConcurrent),
    };
    gateSets.set(sources, gates);
  }
  return gates;
}

/** Raised inside a reference's check when a source reports the browser is offline. */
class OfflineSignal extends Error {}

/** A source with a passing fault counts as failing once this many of its lookups in a row failed (after any retries). */
export const SOURCE_DOWN_AFTER = 2;

/**
 * A failure that will repeat for the rest of the run however often the source is asked: a Retry-After wait, a spent
 * budget or a refusal. Such a source fails, but says nothing about whether the network is up. An `unavailable` answer
 * (a bot check, but also a one-off error page) lasts only once it repeats (OutageWatch.failed).
 */
function isLasting(error: unknown): boolean {
  return error instanceof SourceError && (error.blockedUntil !== undefined || error.kind === 'budget_exhausted' || error.kind === 'forbidden');
}

function isUnavailable(error: unknown): boolean {
  return error instanceof SourceError && error.kind === 'unavailable';
}

/**
 * Whether every required source is failing at once during one run. While that holds, lookups are sent once each, without
 * http.ts's retries and backoff, so an outage reaches the early stop (HALT_AFTER) sooner and with fewer requests; the
 * stop itself is decided as before. Any answer, from any source, clears every count and brings the retries back.
 *
 * A source with a passing fault (a timeout, a 5xx, a network error) counts as failing after SOURCE_DOWN_AFTER failed
 * lookups in a row; failures of lookups that were in flight together count once, so one hiccup that catches a source's
 * concurrent requests is one failure. A source with a lasting fault (isLasting, or an `unavailable` answer seen twice)
 * counts as failing at once, but it never makes the run look all down by itself while another required source answers:
 * that one must be failing too.
 */
export class OutageWatch {
  /** Advances with every counted failure and every answer. */
  private seq = 0;
  private readonly sources = new Map<SourceName, { streak: number; countedAt: number; lasting: boolean; unavailable: boolean }>();
  /**
   * What each required source last said in this run, kept until it answers itself (an answer elsewhere, from DBLP say,
   * lifts no wait, budget or bot check): `lasting` for a lasting fault or a second `unavailable` in a row; `passing` for
   * a network error, a timeout, a server error or a rate limit.
   */
  private readonly lastWord = new Map<SourceName, 'lasting' | 'passing' | 'unavailable' | 'other'>();

  /** Taken when a lookup is sent; handed back to `failed`. */
  started(): number {
    return this.seq;
  }

  answered(source?: SourceName): void {
    this.seq++;
    this.sources.clear();
    if (source !== undefined) this.lastWord.delete(source);
  }

  failed(source: SourceName, startedAt: number, error: unknown): void {
    const state = this.sources.get(source) ?? { streak: 0, countedAt: 0, lasting: false, unavailable: false };
    const repeatedUnavailable = isUnavailable(error) && state.unavailable;
    if (isUnavailable(error)) state.unavailable = true;
    if (isLasting(error) || repeatedUnavailable) state.lasting = true;
    else if (startedAt >= state.countedAt) {
      // Sent after the last counted failure of this source: a failure of its own, not one more of the same moment.
      this.seq++;
      state.streak++;
      state.countedAt = this.seq;
    }
    this.sources.set(source, state);
    if (!REQUIRED_SOURCES.includes(source)) return;
    const before = this.lastWord.get(source);
    const kind = error instanceof SourceError ? error.kind : undefined;
    if (isLasting(error) || (isUnavailable(error) && (before === 'unavailable' || before === 'lasting'))) this.lastWord.set(source, 'lasting');
    else if (isUnavailable(error)) this.lastWord.set(source, 'unavailable');
    else this.lastWord.set(source, kind === 'network' || kind === 'timeout' || kind === 'rate_limited' ? 'passing' : 'other');
  }

  get allFailing(): boolean {
    return REQUIRED_SOURCES.every((source) => {
      const state = this.sources.get(source);
      return state !== undefined && (state.lasting || state.streak >= SOURCE_DOWN_AFTER);
    });
  }

  /**
   * Every required source but one is switched off for the run by a lasting fault (a wait, a spent budget, a bot check),
   * and that one, the run's only way to an answer, is failing for a passing fault. Its lookups keep their retries, and a
   * stop waits out ONE_SOURCE_PATIENCE_MS (runCheck): a short outage of the last source must not end the run.
   */
  get oneSourceLeft(): boolean {
    const left = REQUIRED_SOURCES.filter((source) => this.lastWord.get(source) !== 'lasting');
    return left.length === 1 && left.every((source) => this.lastWord.get(source) === 'passing');
  }

  /** Whether a lookup may be retried now: not while every required source is failing, unless only one is left. */
  get retriesAllowed(): boolean {
    return !this.allFailing || this.oneSourceLeft;
  }
}

function isWorkRecord(value: unknown): value is WorkRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r['title'] === 'string' && Array.isArray(r['authors']) && Array.isArray(r['notes']);
}

interface ArxivPrefetch {
  /** The ids the batch asked for. An id outside it (skipped as cached, since gone) is looked up on its own. */
  requested: ReadonlySet<string>;
  records: Map<string, WorkRecord>;
  /** Ids whose lookup failed, also when asked again, with the error: their references report arXiv as failed. */
  failed: Map<string, unknown>;
}

/** What a run wants to hear from each reference's lookups. */
interface RunHooks {
  /** A source ran out of budget or was rate limited. */
  onLimited?: (source: SourceName) => void;
  /** A source asked not to be contacted until `until` (ms since the epoch); see SourceError.blockedUntil. */
  onBlocked?: (source: SourceName, until: number) => void;
  watch?: OutageWatch;
}

/** What one reference's lookups found, and which sources could not answer. */
class Evidence {
  readonly searched = new Set<SourceName>();
  readonly failed = new Set<SourceName>();
  readonly limited = new Set<SourceName>();
  /** Set when two strong matches, one of them retracted, could not be told apart (pickStrong). */
  ambiguous = false;

  constructor(
    private readonly deps: EngineDeps,
    private readonly signal: AbortSignal,
    private readonly hooks: RunHooks = {},
  ) {}

  /** The required sources that failed: the ones whose silence keeps a reference from being Not found. */
  requiredFailed(): SourceName[] {
    return [...this.failed].filter((s) => REQUIRED_SOURCES.includes(s));
  }

  /** Records a failure of `source`. Aborts, offline and programming errors do not become "failed". */
  fail(source: SourceName, error: unknown): void {
    throwIfAborted(this.signal);
    if (error instanceof UrlNotAllowedError) throw error;
    if (error instanceof OfflineSignal) throw error;
    if (error instanceof SourceError) {
      if (error.kind === 'offline') throw new OfflineSignal();
      if (error.kind === 'budget_exhausted' || error.kind === 'rate_limited') {
        this.limited.add(source);
        this.hooks.onLimited?.(source);
      }
      if (error.blockedUntil !== undefined) this.hooks.onBlocked?.(source, error.blockedUntil);
    } else {
      // A source that breaks its contract is treated as one that could not answer.
      console.warn(`[RefSure] ${source} failed unexpectedly (${error instanceof Error ? error.name : 'unknown'})`);
    }
    this.failed.add(source);
  }

  private call<T>(source: SourceName, fn: (s: Source, signal: AbortSignal) => Promise<T>): Promise<T> {
    const watch = this.hooks.watch;
    return gatesFor(this.deps.sources)[source].run(async () => {
      const startedAt = watch?.started() ?? 0;
      try {
        const answer = await fn(this.deps.sources[source], this.signal);
        watch?.answered(source);
        return answer;
      } catch (error) {
        // An abort, an offline browser or a refused address says nothing about the service.
        const offline = error instanceof SourceError && error.kind === 'offline';
        if (!this.signal.aborted && !offline && !(error instanceof UrlNotAllowedError)) watch?.failed(source, startedAt, error);
        throw error;
      }
    }, this.signal);
  }

  async lookupById(source: SourceName, c: ParsedCitation): Promise<WorkRecord | undefined> {
    try {
      const found = await this.call(source, (s, signal) => s.lookupById(c, signal));
      if (found !== null && !isWorkRecord(found)) throw new SourceError('bad_response', source, 'Malformed record');
      this.searched.add(source);
      return found ?? undefined;
    } catch (error) {
      this.fail(source, error);
      return undefined;
    }
  }

  /** The source's best candidate: a strong one first, then a confident one, then the closest title. */
  async search(source: SourceName, c: ParsedCitation): Promise<WorkRecord | undefined> {
    // A title with nothing to search for sends no request, so the source must not count as searched.
    if (!hasTitle(c)) return undefined;
    try {
      const found = await this.call(source, (s, signal) => s.search(c, signal));
      if (!Array.isArray(found) || !found.every(isWorkRecord)) throw new SourceError('bad_response', source, 'Malformed search results');
      this.searched.add(source);
      const strong = pickStrong(c, found.filter((r) => isStrongMatch(c, r, 'search')));
      if (strong === 'ambiguous') {
        this.ambiguous = true;
        return undefined;
      }
      return strong ?? pickBest(c, found.filter((r) => isConfidentMatch(c, r, 'search'))) ?? pickBest(c, found);
    } catch (error) {
      this.fail(source, error);
      return undefined;
    }
  }

  /** Crossref's candidates for a journal citation with no title (`again`: the further request); undefined when it could not answer. */
  async locatorSearch(c: ParsedCitation, again = false): Promise<WorkRecord[] | undefined> {
    const crossrefSource = this.deps.sources.crossref;
    const search = (again ? crossrefSource.searchLocatorAgain : crossrefSource.searchLocator)?.bind(crossrefSource);
    if (search === undefined) return undefined;
    try {
      const found = await this.call('crossref', (_s, signal) => search(c, signal));
      if (!Array.isArray(found) || !found.every(isWorkRecord)) throw new SourceError('bad_response', 'crossref', 'Malformed search results');
      this.searched.add('crossref');
      return found;
    } catch (error) {
      this.fail('crossref', error);
      return undefined;
    }
  }

  async retractionOf(match: WorkRecord): Promise<Awaited<ReturnType<typeof retraction.check>> | 'unknown'> {
    try {
      throwIfAborted(this.signal);
      return await this.deps.retraction.check(match, this.signal);
    } catch (error) {
      throwIfAborted(this.signal);
      if (error instanceof UrlNotAllowedError) throw error;
      if (error instanceof SourceError && error.kind === 'offline') throw new OfflineSignal();
      // Like a failing source: anything else that breaks the contract is logged by name only and read as "could not check".
      if (!(error instanceof SourceError)) console.warn(`[RefSure] retraction lookup failed unexpectedly (${error instanceof Error ? error.name : 'unknown'})`);
      return 'unknown';
    }
  }
}

/** The same cache for reading, with writes dropped: used while history is off. */
function withoutWrites(cache: Cache): Cache {
  return {
    get: (key) => cache.get(key),
    set: () => Promise.resolve(),
    clear: () => cache.clear(),
    ...(cache.epoch !== undefined && { epoch: () => cache.epoch?.() ?? 0 }),
  };
}

function buildLinks(records: WorkRecord[], noticeDoi: string | undefined): CheckResult['links'] {
  const links: CheckResult['links'] = [];
  const add = (label: string, make: () => string): void => {
    try {
      const url = make();
      if (!links.some((l) => l.url === url)) links.push({ label, url });
    } catch {
      // An identifier the builders reject is simply not linked.
    }
  };
  for (const r of records) {
    if (r.doi !== undefined) add('DOI', () => doiUrl(r.doi ?? ''));
    if (r.arxivId !== undefined) add('arXiv', () => arxivUrl(stripArxivVersion(r.arxivId ?? '')));
    if (r.openreviewId !== undefined) add('OpenReview', () => openreviewUrl(r.openreviewId ?? ''));
  }
  if (noticeDoi !== undefined) {
    try {
      const url = doiUrl(noticeDoi);
      links.push({ label: 'Retraction notice', url });
    } catch {
      // not linked
    }
  }
  return links;
}

function result(ref: RawReference, verdict: Verdict, extra: { match?: WorkRecord; searched?: Iterable<SourceName>; failed?: Iterable<SourceName>; links?: CheckResult['links'] } = {}): CheckResult {
  return {
    index: ref.index,
    label: ref.label,
    citedText: ref.text,
    status: verdict.status,
    reason: verdict.reason,
    ...(extra.match !== undefined && { match: extra.match }),
    diffs: verdict.diffs,
    notes: verdict.notes,
    sourcesSearched: [...(extra.searched ?? [])],
    sourcesFailed: [...(extra.failed ?? [])],
    links: extra.links ?? [],
  };
}

/** The browser went offline during the lookups: nothing is known about the reference. */
function offlineResult(ref: RawReference, evidence: Evidence): CheckResult {
  return result(ref, cantCheck(OFFLINE_REASON), { searched: evidence.searched, failed: evidence.requiredFailed() });
}

/** Says which service ran out and, where it is known, when it comes back. OpenAlex is the one with a daily budget. */
function limitReason(limited: Iterable<SourceName>): string {
  const sources = [...limited];
  if (sources.length === 1 && sources[0] === 'openalex') return "OpenAlex's free daily search limit is used up. Try again tomorrow.";
  const names = sources.map((s) => SOURCE_NAME[s]);
  if (names.length === 1) return `${names[0]}'s lookup limit is reached for now. Try again later.`;
  return `The lookup limits of ${joinAnd(names)} are reached for now. Try again later.`;
}

// ------------------------------------------------------------------ one reference

/** Said of a PDF entry cut from a line that held two, where it would otherwise be Not found, Wrong ID or Details differ. */
const PARTIAL_ENTRY_REASON = "This entry was cut from a line of the PDF that held two references, so it may be mixed with the one next to it and couldn't be checked reliably";
// What a partial entry's words cannot support: they may be another entry's (its DOI, its locator, its year).
const NOT_ON_PARTIAL: ReadonlySet<Status> = new Set(['not_found', 'wrong_id', 'details_differ']);

/**
 * A PDF entry cut in the middle of a line (RawReference.partial) may hold words of another entry, its DOI or locator
 * included: it is never Not found, Wrong ID or Details differ. It can still be Verified or Retracted.
 */
async function checkParsed(
  ref: RawReference,
  c: ParsedCitation,
  deps: EngineDeps,
  signal: AbortSignal,
  prefetch: ArxivPrefetch | undefined,
  hooks?: RunHooks,
): Promise<CheckResult> {
  const checked = await checkWhole(ref, c, deps, signal, prefetch, hooks);
  if (ref.partial !== true || !NOT_ON_PARTIAL.has(checked.status)) return checked;
  return { ...checked, ...cantCheck(PARTIAL_ENTRY_REASON), links: [] };
}

async function checkWhole(
  ref: RawReference,
  c: ParsedCitation,
  deps: EngineDeps,
  signal: AbortSignal,
  prefetch: ArxivPrefetch | undefined,
  hooks?: RunHooks,
): Promise<CheckResult> {
  throwIfAborted(signal);

  // 1. Cases that need no lookup are decided before anything leaves the machine. The one exception is a journal
  // citation with no title, which cannot be searched by title but can by journal, volume, page and year.
  const early = preLookupVerdict(c);
  // An entry that cites several works whose first part is complete on its own: that part is checked alone.
  const first = early?.reason === SEVERAL_WORKS_REASON ? firstWorkOf(c) : undefined;
  if (first !== undefined) return checkFirstWork(ref, first, deps, signal, hooks);
  const byJournal = early !== undefined && deps.sources.crossref.searchLocator !== undefined && journalLocator(c) !== undefined;
  // A Nature-style entry whose title cannot be used is looked up by its locator too, for a record that carries that title.
  const nature = early !== undefined && !byJournal && isUnreadable(early) && deps.sources.crossref.searchLocator !== undefined ? natureStyleLocatorReading(c) : undefined;
  // A book, thesis, ISBN-bearing proceedings entry or IACR ePrint with a real title may still be verified by Crossref.
  const verifiedOnly = !byJournal && nature === undefined && isVerifiedOnlyLookup(c, early);
  if (early !== undefined && !byJournal && nature === undefined && !verifiedOnly) return result(ref, early);

  // 2. Cache.
  const epoch = deps.cache.epoch?.();
  const key = cacheKey(c);
  if (key !== undefined) {
    const hit = await deps.cache.get(key).catch(() => undefined);
    throwIfAborted(signal);
    if (hit !== undefined) return { ...hit, index: ref.index, label: ref.label, citedText: ref.text };
  }

  const evidence = new Evidence(deps, signal, hooks);
  try {
    const checked =
      early === undefined
        ? await lookUp(ref, c, deps, prefetch, evidence)
        : verifiedOnly
          ? await lookUpVerifiedOnly(ref, c, early, evidence)
          : nature !== undefined
            ? await lookUpByJournal(ref, nature, early, evidence, c)
            : await lookUpByJournal(ref, c, early, evidence);
    if (key !== undefined && checked.cacheable && checked.result.status !== 'cant_check') {
      // Not awaited: the caller gets the result now and the cache catches up in its own time.
      deps.cache.set(key, checked.result, epoch).catch(() => undefined);
    }
    return checked.result;
  } catch (error) {
    if (error instanceof OfflineSignal) {
      return offlineResult(ref, evidence);
    }
    throw error;
  }
}

/**
 * The first work of an entry that cites several, checked alone as any reference is (from step 3 on). Its verdict is
 * turned into the entry's (firstWorkVerdict): a Verified becomes Can't check, the rest say they are about the first
 * work. Nothing is cached: the cache key is the entry's, and the result is not the entry's own.
 */
async function checkFirstWork(ref: RawReference, first: ParsedCitation, deps: EngineDeps, signal: AbortSignal, hooks?: RunHooks): Promise<CheckResult> {
  const evidence = new Evidence(deps, signal, hooks);
  try {
    const { result: checked } = await lookUp(ref, first, deps, undefined, evidence);
    const verdict = firstWorkVerdict({ status: checked.status, reason: checked.reason, diffs: checked.diffs, notes: checked.notes });
    const shown = verdict.status === 'cant_check' ? undefined : checked.match;
    return result(ref, verdict, { ...(shown !== undefined && { match: shown }), searched: checked.sourcesSearched, failed: checked.sourcesFailed, links: shown === undefined ? [] : checked.links });
  } catch (error) {
    if (error instanceof OfflineSignal) {
      return offlineResult(ref, evidence);
    }
    throw error;
  }
}

/**
 * A journal citation with no title, looked up by Crossref on its journal, volume, page and year. It ends in Verified or
 * Retracted when exactly one record carries all of them, and otherwise in Can't check, whatever went wrong: the one it
 * had (`unreadable`), or one that says no record was found at the locator. This path never says Not found, Wrong ID or
 * Details differ.
 *
 * When Crossref's first answers hold no record that matches (with one named author, errata of the same volume can fill
 * them), it is asked once more (searchLocatorAgain). Those answers only join the candidates; the one match must still
 * be the only one among all of them.
 */
async function lookUpByJournal(ref: RawReference, c: ParsedCitation, unreadable: Verdict, evidence: Evidence, titled?: ParsedCitation): Promise<{ result: CheckResult; cacheable: boolean; titleMayBeJournal?: boolean }> {
  const locator = journalLocator(c);
  const title = titled?.title;
  // A Nature-style "title" may be the start of the journal's name ("Zeitschrift für angew. Math. Mech."): a record whose
  // journal name accounts for it, with an author the entry names, is the article as much as one carrying the title.
  const asJournal = (r: WorkRecord, authors: boolean): boolean => locator !== undefined && title !== undefined && titleIsJournal(c, locator, title, r, authors);
  let candidates = locator === undefined ? undefined : await evidence.locatorSearch(c);
  if (locator !== undefined && candidates !== undefined && !candidates.some((r) => matchesLocator(c, locator, r) || asJournal(r, true))) {
    const more = await evidence.locatorSearch(c, true);
    if (more !== undefined) candidates = [...candidates, ...more];
  }
  const all = candidates ?? [];
  const byName = locator === undefined || candidates === undefined ? undefined : locatorMatch(c, locator, candidates);
  const asJournalMatches = titled === undefined ? [] : all.filter((r) => asJournal(r, true));
  const match = titled === undefined ? byName : byName !== undefined && carriesCitedTitle(titled, byName) ? byName : asJournalMatches.length === 1 ? asJournalMatches[0] : undefined;
  if (match === undefined || locator === undefined) {
    // No record bears the entry out. Its "title" may still be the journal's: a record at the locator whose journal name
    // accounts for it (another author, say), or no record at the locator at all and a "title" shaped like the start of a
    // journal's name. The title path's Not found is then not to be trusted (lookUp).
    const holders = locator === undefined ? [] : all.filter((r) => carriesLocatorNumbers(c, locator, r));
    const titleMayBeJournal = title !== undefined && (holders.some((r) => asJournal(r, false)) || (holders.length === 0 && locator !== undefined && mayBeJournalStart(locator, title)));
    // A title-less entry whose locator was read and that Crossref answered for, with no record at that volume, page and
    // year, says so: it was read, there is just nothing there. A failed request or a record there that is another
    // article keeps the message it had.
    const noRecord = titled === undefined && locator !== undefined && candidates !== undefined && !evidence.failed.has('crossref') && holders.length === 0 && isUnreadable(unreadable);
    const verdict: Verdict = noRecord ? cantCheck(LOCATOR_NO_RECORD) : unreadable;
    return { result: result(ref, verdict), cacheable: false, titleMayBeJournal };
  }
  const retractionResult = await evidence.retractionOf(match);
  const verdict = locatorVerdict(c, match, retractionResult, match === byName ? locatorNamesAuthors(c, locator, match) : true);
  if (verdict.status === 'cant_check') return { result: result(ref, verdict), cacheable: false };
  const notice = retractionResult !== 'unknown' && retractionResult.retracted ? retractionResult.noticeDoi : undefined;
  const searched = titled === undefined ? ['crossref' as const] : evidence.searched;
  return { result: result(ref, verdict, { match, searched, links: buildLinks([match], notice) }), cacheable: retractionResult !== 'unknown' };
}

/**
 * The record that Crossref's locator request (searchLocatorAgain, one request) brings for a titled reference read without
 * its title (titledLocatorReading): one that carries the whole locator (journal, volume, first page, year and, when named,
 * an author) and the cited title by the usual title rule. Two strong ones that cannot be told apart, one retracted, are
 * 'ambiguous'. Undefined when there is none, or when the request failed (the evidence then says Crossref failed).
 */
async function titledLocatorMatch(c: ParsedCitation, reading: ParsedCitation, evidence: Evidence): Promise<WorkRecord | 'ambiguous' | undefined> {
  const locator = journalLocator(reading);
  if (locator === undefined) return undefined;
  // The further request when it has something to go on (the built DOI, the first author's surname), otherwise the plain
  // one ("G. E. Hinton and R. R. Salakhutdinov. Title. Science 313, 504" names no author before a comma): one either way.
  const again = publisherDoi(reading, locator) !== undefined || locatorFirstSurname(reading, locator) !== undefined;
  const found = await evidence.locatorSearch(reading, again);
  if (found === undefined) return undefined;
  const carrying = found.filter((r) => matchesLocator(reading, locator, r) && carriesCitedTitle(c, r));
  return pickStrong(c, carrying.filter((r) => isStrongMatch(c, r, 'search'))) ?? pickBest(c, carrying);
}

/**
 * A book, thesis, ISBN-bearing proceedings entry or IACR ePrint, looked up by its title in Crossref only: Crossref holds
 * books and chapters, the preprint servers do not, and OpenAlex searches are metered. Verified when the record agrees
 * as a search match must; any other outcome leaves the Can't check it had. This path never says Not found, Wrong ID,
 * Details differ or Retracted (verifiedOnlyVerdict).
 */
async function lookUpVerifiedOnly(ref: RawReference, c: ParsedCitation, unchecked: Verdict, evidence: Evidence): Promise<{ result: CheckResult; cacheable: boolean }> {
  const found = await evidence.search('crossref', c);
  const verdict = found === undefined ? undefined : verifiedOnlyVerdict(c, found);
  if (found === undefined || verdict === undefined) return { result: result(ref, unchecked), cacheable: false };
  return { result: result(ref, verdict, { match: found, searched: ['crossref'], links: buildLinks([found], undefined) }), cacheable: true };
}

/**
 * The title searched in every source, cheapest first. A strong match ends the search; otherwise every source's best
 * candidate is returned. Two copies that cannot be told apart (evidence.ambiguous) end it too.
 */
async function searchByTitle(c: ParsedCitation, evidence: Evidence): Promise<{ strong?: WorkRecord; candidates: WorkRecord[] }> {
  const candidates: WorkRecord[] = [];
  for (const source of SEARCH_ORDER) {
    // OpenAlex searches are metered (about 100 a day per network address without a key). None is spent on a "title"
    // that could never be called Not found (names, a venue, a line cut short): unless a free source matched it, the
    // reference is unreadable whatever OpenAlex would say.
    if (source === 'openalex' && !isCredibleTitle(c.title ?? '')) break;
    const found = await evidence.search(source, c);
    if (evidence.ambiguous) break;
    if (found === undefined) continue;
    if (isStrongMatch(c, found, 'search')) return { strong: found, candidates };
    candidates.push(found);
  }
  return { candidates };
}

async function lookUp(ref: RawReference, c: ParsedCitation, deps: EngineDeps, prefetch: ArxivPrefetch | undefined, evidence: Evidence): Promise<{ result: CheckResult; cacheable: boolean }> {
  let match: WorkRecord | undefined;
  let matchedVia: 'id' | 'search' | undefined;
  let idResolvedTo: WorkRecord | undefined;

  // 3. Identifier lookups. A record whose title is a different paper's is a Wrong ID, even if the other id is fine.
  const resolved: WorkRecord[] = [];
  if (c.doi !== undefined) {
    const viaCrossref = await evidence.lookupById('crossref', c);
    const record = viaCrossref ?? (await evidence.lookupById('openalex', c));
    if (record !== undefined) resolved.push(record);
  }
  if (c.arxivId !== undefined) {
    let record: WorkRecord | undefined;
    if (prefetch?.requested.has(stripArxivVersion(c.arxivId))) {
      if (prefetch.failed.has(stripArxivVersion(c.arxivId))) evidence.fail('arxiv', prefetch.failed.get(stripArxivVersion(c.arxivId)));
      else {
        evidence.searched.add('arxiv');
        record = prefetch.records.get(stripArxivVersion(c.arxivId));
      }
    } else {
      record = await evidence.lookupById('arxiv', c);
    }
    if (record !== undefined && isWorkRecord(record)) resolved.push(record);
  }
  // A record with no usable title cannot be compared with the citation: it is no evidence either way.
  const citedTitle = hasTitle(c);
  const usable = resolved.filter(hasUsableTitle);
  const idUnusable = usable.length < resolved.length;
  // A dataset, software or collection under another name (nonPaper) is no sign of a wrong identifier, and no reason to
  // skip the title search: the reference is searched by its own title (or matched by another identifier it cites), and
  // the record is kept aside for the verdict when nothing matches (classify).
  const wrong = usable.find((r) => r.nonPaper !== true && isWrongId(c, r));
  const nonPaperId = usable.find((r) => r.nonPaper === true && isWrongId(c, r));
  const fitting = usable.find((r) => !isWrongId(c, r));
  if (wrong !== undefined) {
    idResolvedTo = wrong;
  } else if (fitting !== undefined) {
    match = idResolvedTo = fitting;
    matchedVia = 'id';
  }

  // 3b. An arXiv record that differs from the reference only in a later, journal year: the journal version is the one
  // cited. It is looked for in Crossref only (OpenAlex is metered), and replaces the arXiv record only as a strong match;
  // a retracted one then goes through the retraction lookup like any strong match, and a retracted one that is only
  // confident is shown with the note that the closest record was retracted. Two copies that cannot be told apart end in
  // Can't check, as in step 4. Anything else leaves the arXiv record as the match.
  if (match !== undefined && matchedVia === 'id' && citesLaterVersion(c, match)) {
    const found = await evidence.search('crossref', c);
    const strong = found !== undefined && isStrongMatch(comparedWith(c, found), found, 'search');
    if (!evidence.ambiguous && found !== undefined && (strong || (found.isRetracted && isConfidentMatch(comparedWith(c, found), found, 'search')))) {
      match = found;
      matchedVia = 'search';
    }
  }

  // 4. No match and no wrong id yet: search by title. Only a strong match ends the search: a weaker candidate
  // (a sibling paper, the same title with other authors) may hold another work's retraction, and a later
  // source may hold the real paper. If none is strong, the best of all the candidates is kept.
  if (match === undefined && idResolvedTo === undefined && citedTitle) {
    const { strong, candidates } = await searchByTitle(c, evidence);
    if (strong !== undefined) {
      match = strong;
      matchedVia = 'search';
    }
    if (match === undefined && !evidence.ambiguous) {
      // A candidate that agrees well enough to be Verified beats one whose title is only closer ("MapReduce" by the
      // cited authors and year beats an encyclopedia entry called just "MapReduce"), as within one source's results.
      // A retracted record is left out of that preference: unless it is a strong match it may be another work.
      match = pickBest(c, candidates.filter((r) => !r.isRetracted && isConfidentMatch(c, r, 'search'))) ?? pickBest(c, candidates);
      if (match !== undefined) matchedVia = 'search';
    }
  }

  // Two copies of the paper, one retracted, and nothing in the reference to say which: no verdict either way.
  if (evidence.ambiguous) {
    return { result: result(ref, cantCheck(AMBIGUOUS_COPIES), { searched: evidence.searched }), cacheable: false };
  }

  // 5. Retraction, then the verdict. The citation is read as classify will read it (comparedWith), so a match that
  // the verdict counts as strong has had its retraction looked up, and no other has.
  const retractionOf = (m: WorkRecord | undefined, via: 'id' | 'search' | undefined) => (m !== undefined && hasUsableTitle(m) && isStrongMatch(comparedWith(effectiveCitation(c), m), m, via) ? evidence.retractionOf(m) : undefined);
  let retractionResult = await retractionOf(match, matchedVia);
  let failed = evidence.requiredFailed();
  const judge = (): Verdict =>
    classify({
      citation: c,
      ...(match !== undefined && { match }),
      ...(matchedVia !== undefined && { matchedVia }),
      ...(idResolvedTo !== undefined && { idResolvedTo }),
      ...(idResolvedTo === undefined && match === undefined && nonPaperId !== undefined && { idResolvedTo: nonPaperId }),
      ...(idUnusable && { idUnusable }),
      ...(retractionResult !== undefined && { retraction: retractionResult }),
      searched: [...evidence.searched],
      failed,
    });
  let verdict = judge();
  // A paper from before 1970 that nothing matched is Can't check rather than Not found, but its journal locator is tried
  // all the same (steps 6 and 7): a record found there may still verify it.
  const unmatched = (v: Verdict): boolean => v.status === 'not_found' || isOldPaperVerdict(v);

  // 6. A Nature-style entry that the title path leaves Not found or unreadable is looked up by its journal locator, as a
  // title-less entry is, for a record that also carries the cited title. Only Verified or Retracted come of it; anything
  // else leaves the title path's verdict.
  // A "title" that may be the start of the journal's name (titleMayBeJournal) turns the title path's Not found into the
  // unreadable Can't check: the entry may well be a title-less journal citation, which is never Not found.
  const nature = deps.sources.crossref.searchLocator !== undefined && (unmatched(verdict) || isUnreadable(verdict)) ? natureStyleLocatorReading(c) : undefined;
  if (nature !== undefined) {
    const byLocator = await lookUpByJournal(ref, nature, verdict, evidence, c);
    if (byLocator.result.status === 'verified' || byLocator.result.status === 'retracted') return byLocator;
    // A locator request that failed is counted, as in step 7: the entry is Can't check, and not remembered as Not found.
    failed = evidence.requiredFailed();
    if (unmatched(verdict) && byLocator.titleMayBeJournal === true) {
      return { result: result(ref, cantCheck(UNREADABLE), { searched: evidence.searched, failed }), cacheable: false };
    }
    if (unmatched(verdict) && failed.length > 0) verdict = judge();
  }

  // 7. Any other titled reference with a full journal locator that the title path leaves Not found ("cecoin5 at 2.3 k"
  // against Crossref's "CeCoIn<sub>5</sub> at 2.3 K", which no title search ranked) is looked up once more, by that
  // locator: one request (searchLocatorAgain). A record found there counts only if it carries the whole locator and the
  // cited title, and is then judged as any search match; a record at the locator with another title is ignored, so an
  // invented title on a real article's locator stays Not found. A request that fails leaves the reference Can't check.
  // A reference whose only identifier led to a dataset or other non-paper record is read as one with no identifier.
  const pastNonPaper = idResolvedTo === undefined && nonPaperId !== undefined;
  const titled = nature === undefined && unmatched(verdict) && deps.sources.crossref.searchLocatorAgain !== undefined ? (pastNonPaper ? locatorReadingPastNonPaperDoi(c) : titledLocatorReading(c)) : undefined;
  if (titled !== undefined) {
    const located = await titledLocatorMatch(c, titled, evidence);
    failed = evidence.requiredFailed();
    if (located === 'ambiguous') {
      return { result: result(ref, cantCheck(AMBIGUOUS_COPIES), { searched: evidence.searched, failed }), cacheable: false };
    }
    if (located !== undefined) {
      match = located;
      matchedVia = 'search';
      retractionResult = await retractionOf(match, matchedVia);
    }
    if (located !== undefined || failed.length > 0) verdict = judge();
  }

  // When the only sources that could not answer ran out of budget, say so rather than "try again later".
  if (verdict.status === 'cant_check' && failed.length > 0 && failed.every((s) => evidence.limited.has(s))) {
    verdict.reason = limitReason(failed);
  }

  const shown = verdict.status === 'wrong_id' ? idResolvedTo : verdict.status === 'cant_check' || verdict.status === 'not_found' ? undefined : match;
  const notice = retractionResult !== undefined && retractionResult !== 'unknown' && retractionResult.retracted ? retractionResult.noticeDoi : undefined;
  const built = result(ref, verdict, {
    ...(shown !== undefined && { match: shown }),
    searched: evidence.searched,
    failed,
    links: shown === undefined ? [] : buildLinks([shown], notice),
  });
  // A required source that failed may have shaped this result (a journal version step 3b could not look for, a record
  // another source would have given): a passing fault must not outlive itself in the cache.
  return { result: built, cacheable: retractionResult !== 'unknown' && failed.length === 0 };
}

export function checkReference(ref: RawReference, deps: EngineDeps, signal: AbortSignal): Promise<CheckResult> {
  return checkParsed(ref, effectiveCitation(parseCitation(ref)), deps, signal, undefined);
}

// ------------------------------------------------------------------ a whole paper

/** A failed batch is asked again in batches of this many ids, one request at a time. */
const ARXIV_RETRY_BATCH = 10;

/**
 * Is a failed arXiv batch worth asking again in smaller batches? A large batch can time out (arxiv-html:2504.01995: 30
 * ids, about 110 KB) or fail on a bad gateway while smaller ones go through. A refusal is not asked again, as that would
 * only walk into it once more: a rate limit, a spent budget, access refused, an offline browser, an answer that asks for
 * a pause (Retry-After, whatever its status), a page that is not the feed (a bot check or a maintenance page) and a
 * redirect out of the allowlist.
 */
function worthAskingAgain(error: unknown): boolean {
  if (!(error instanceof SourceError)) return true;
  if (error instanceof RefusedRedirectError || error.retryAfterMs !== undefined) return false;
  return error.kind === 'timeout' || error.kind === 'network' || error.kind === 'bad_response';
}

/**
 * One request per 50 uncached arXiv ids. When it fails, the ids are asked again once, ARXIV_RETRY_BATCH at a time and one
 * request after the other (the arXiv gate and rate limit still apply). The retry stops at the first small batch that
 * fails too: an outage would otherwise hold every reference of the paper back for one timeout per batch. Ids that were
 * not brought back are kept with their error, so each affected reference reports arXiv as failed and falls back on its
 * title, never on "not found".
 */
async function prefetchArxiv(parsed: { c: ParsedCitation }[], deps: EngineDeps, signal: AbortSignal, watch?: OutageWatch): Promise<ArxivPrefetch | undefined> {
  const lookupMany = deps.sources.arxiv.lookupMany?.bind(deps.sources.arxiv);
  if (lookupMany === undefined) return undefined;
  const ids = new Set<string>();
  for (const { c } of parsed) {
    throwIfAborted(signal);
    if (c.arxivId === undefined || preLookupVerdict(c) !== undefined) continue;
    const key = cacheKey(c);
    if (key !== undefined && (await deps.cache.get(key).catch(() => undefined)) !== undefined) continue;
    ids.add(stripArxivVersion(c.arxivId));
  }
  if (ids.size === 0) return undefined;
  let startedAt = 0;
  const ask = async (batch: string[]): Promise<Map<string, WorkRecord>> => {
    const records = await gatesFor(deps.sources).arxiv.run(() => {
      startedAt = watch?.started() ?? 0;
      return lookupMany(batch, signal);
    }, signal);
    if (!(records instanceof Map)) throw new SourceError('bad_response', 'arxiv', 'Malformed batch result');
    watch?.answered('arxiv');
    return records;
  };
  // An abort is the caller's, and a URL outside the allowlist is a bug: neither is a failed lookup. Offline is no
  // sign of the service either.
  const rethrowUnlessFailure = (error: unknown): void => {
    throwIfAborted(signal);
    if (error instanceof UrlNotAllowedError) throw error;
    if (!(error instanceof SourceError && error.kind === 'offline')) watch?.failed('arxiv', startedAt, error);
  };
  const all = [...ids];
  const records = new Map<string, WorkRecord>();
  const failed = new Map<string, unknown>();
  try {
    return { requested: ids, records: await ask(all), failed };
  } catch (error) {
    rethrowUnlessFailure(error);
    // Set once asking again is over: the error is then kept for every id not yet brought back.
    let refusal = worthAskingAgain(error) ? undefined : error;
    for (let i = 0; i < all.length; i += ARXIV_RETRY_BATCH) {
      const batch = all.slice(i, i + ARXIV_RETRY_BATCH);
      if (refusal !== undefined) {
        for (const id of batch) failed.set(id, refusal);
        continue;
      }
      try {
        for (const [id, record] of await ask(batch)) records.set(id, record);
      } catch (again) {
        rethrowUnlessFailure(again);
        for (const id of batch) failed.set(id, again);
        refusal = again;
      }
    }
    return { requested: ids, records, failed };
  }
}

/** A run stops after this many references in a row whose lookups all failed outright (not clean misses). */
export const HALT_AFTER = 5;

/**
 * While only one required source is left (OutageWatch.oneSourceLeft), the stop also waits until its references have
 * been failing this long: a minute covers a restart or a brief overload of that service, and a lasting outage of it
 * still ends the run.
 */
const ONE_SOURCE_PATIENCE_MS = 60_000;

/**
 * The wait above is read on the wall clock, which can stand still or jump back. However the clock behaves, the wait
 * ends after this many references in a row with no answer from any required source.
 */
const ONE_SOURCE_PATIENCE_REFS = 4 * HALT_AFTER;

/** What a finished run says; `halted` is set when the run gave up because the lookup services were not answering. */
export type RunSummary = CheckSummary & { halted?: 'services-down' };

/**
 * Whether a result says the services are answering. `down` is a reference that needed lookups and got no answer from
 * any required source; `neutral` is one that says nothing either way (nothing was looked up, or the browser is offline,
 * which has its own message).
 */
function serviceHealth(r: CheckResult): 'down' | 'ok' | 'neutral' {
  if (r.status === 'cant_check' && r.reason === OFFLINE_REASON) return 'neutral';
  if (r.sourcesSearched.length === 0 && r.sourcesFailed.length === 0) return 'neutral';
  const answered = r.sourcesSearched.some((s) => REQUIRED_SOURCES.includes(s));
  const failed = r.sourcesFailed.some((s) => REQUIRED_SOURCES.includes(s));
  return r.status === 'cant_check' && failed && !answered ? 'down' : 'ok';
}

/**
 * Checks every reference of a paper and reports each result through `onResult` as soon as it is ready.
 * Resolves with the summary once all are done. If `signal` aborts, rejects with the abort reason (an
 * AbortError unless the signal carries another) without waiting for lookups in flight, and `onResult`
 * is not called again. A UrlNotAllowedError from any source fails the whole run. The caller saves
 * history after a run that resolves; a rejected run is never saved by accident.
 *
 * After HALT_AFTER references in a row whose lookups all failed (and, while one source is left, ONE_SOURCE_PATIENCE_MS
 * after the first of them or ONE_SOURCE_PATIENCE_REFS of them, whichever comes first), the run stops: the results already delivered stand,
 * nothing more is delivered, and the summary says `halted`. `onLimited` is told once per source that runs out of
 * budget or is rate limited during the run. `onBlocked` is told, once per source and block, when a required source asked
 * not to be contacted until a given time (a long Retry-After; see http.ts).
 */
export async function runCheck(
  input: {
    paper: PaperInfo;
    refs: RawReference[];
    onResult: (r: CheckResult) => void;
    onLimited?: (source: SourceName) => void;
    onBlocked?: (source: SourceName, until: number) => void;
    signal: AbortSignal;
  },
  deps?: EngineDeps,
): Promise<RunSummary> {
  const { paper, refs, onResult, signal } = input;
  throwIfAborted(signal);
  const settings = await getSettings().catch(() => undefined);
  let engine = deps;
  if (engine === undefined) {
    // The user's own OpenAlex key, if any; a key that does not validate is ignored and the free budget used.
    applyOpenAlexKey(settings?.openAlexKey);
    engine = defaultDeps();
  }
  // History off means nothing is stored, the result cache included. Unreadable settings are read as off.
  const run: EngineDeps = settings?.historyEnabled === true ? engine : { ...engine, cache: withoutWrites(engine.cache) };

  const startedAt = run.now();
  const counts = emptyCounts();
  const parsed = refs.map((ref) => ({ ref, c: effectiveCitation(parseCitation(ref)) }));
  const watch = new OutageWatch();
  const prefetch = await prefetchArxiv(parsed, run, signal, watch);

  // The references' lookups listen to this, not to `signal`: a halt cancels the ones in flight, an abort does too.
  const lookups = new AbortController();
  // While every required source is failing, each lookup is sent once (OutageWatch): checked before every retry.
  setRetryRule(lookups.signal, () => watch.retriesAllowed);
  const relay = (): void => lookups.abort(abortReason(signal));
  if (signal.aborted) relay();
  else signal.addEventListener('abort', relay, { once: true });

  const limitedSeen = new Set<SourceName>();
  const noteLimited = (source: SourceName): void => {
    // DBLP is optional: a reference never becomes Can't check because of it, so its limit is not worth a notice.
    if (limitedSeen.has(source) || !REQUIRED_SOURCES.includes(source)) return;
    limitedSeen.add(source);
    input.onLimited?.(source);
  };
  // Told again only when the same source is blocked until a later time: an earlier end never replaces a later one.
  const blockedSeen = new Map<SourceName, number>();
  const noteBlocked = (source: SourceName, until: number): void => {
    if (until <= (blockedSeen.get(source) ?? 0) || !REQUIRED_SOURCES.includes(source)) return;
    blockedSeen.set(source, until);
    input.onBlocked?.(source, until);
  };

  let next = 0;
  let stopped = false;
  let halted = false;
  let downStreak = 0;
  // When the first reference of the current streak was reported.
  let downSince = 0;
  let halt: (() => void) | undefined;
  const haltedNow = new Promise<void>((resolve) => {
    halt = resolve;
  });
  const worker = async (): Promise<void> => {
    while (!stopped && !signal.aborted) {
      const item = parsed[next++];
      if (item === undefined) return;
      try {
        const checked = await checkParsed(item.ref, item.c, run, lookups.signal, item.c.arxivId === undefined ? undefined : prefetch, { onLimited: noteLimited, onBlocked: noteBlocked, watch });
        // A result that finished after the abort (or after the run gave up) must not reach the caller.
        if (stopped || signal.aborted) return;
        counts[checked.status]++;
        onResult(checked);
        // One batch request stands in for every arXiv id in the paper: when it fails, all the references that
        // depend on it fail at once. That is one outage, not several, so a reference that failed only because of
        // it does not count toward the stop.
        const batchFailed = item.c.arxivId !== undefined && prefetch?.failed.has(stripArxivVersion(item.c.arxivId)) === true;
        const onlyBatch = batchFailed && checked.sourcesFailed.every((s) => s === 'arxiv');
        let health = serviceHealth(checked);
        if (health === 'down' && onlyBatch) health = 'neutral';
        if (health === 'down') {
          if (downStreak === 0) downSince = run.now();
          downStreak++;
        } else if (health === 'ok') downStreak = 0;
        const waitingOut = watch.oneSourceLeft && run.now() - downSince < ONE_SOURCE_PATIENCE_MS && downStreak < ONE_SOURCE_PATIENCE_REFS;
        if (downStreak >= HALT_AFTER && !waitingOut) {
          halted = true;
          stopped = true;
          lookups.abort(new DOMException('The run stopped: the lookup services are not answering.', 'AbortError'));
          halt?.();
          return;
        }
      } catch (error) {
        // Lookups cancelled by the halt end with an abort; that is the halt, not a failure.
        if (halted) return;
        stopped = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(REFERENCE_WORKERS, parsed.length) }, worker);

  // On abort, return at once: a source that ignores the signal must not keep the caller waiting.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = (): void => {
      stopped = true;
      reject(abortReason(signal));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    await Promise.race([Promise.all(workers), aborted, haltedNow]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    signal.removeEventListener('abort', relay);
  }
  throwIfAborted(signal);
  // Results have all been delivered; now let the cache write what it learned.
  await run.cache.flush?.().catch(() => undefined);

  return { paper, counts, total: refs.length, startedAt, finishedAt: run.now(), beta: paper.viaPdf, ...(halted ? { halted: 'services-down' as const } : {}) };
}
