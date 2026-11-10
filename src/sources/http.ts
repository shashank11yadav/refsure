// The only module in the extension allowed to touch the network
// (SECURITY.md section 3; ESLint bans fetch and friends everywhere else).
//
// Every request is checked against the origin allowlist, sent without
// cookies or referrer, bounded in time and size, and verified to be the kind
// of content we asked for before anyone parses it. Error messages carry the
// origin and the HTTP status only: query strings may hold an API key.

import { ALLOWED_ORIGINS, API, LIMITS, RATE } from '../config';
import type { SourceName } from '../core/types';
import { abortReason, createRateLimiter, MAX_DELAY_MS, type RateLimiter } from './rateLimiter';

export type SourceErrorKind =
  | 'offline'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'unavailable'
  | 'bad_response'
  | 'not_found_http'
  | 'forbidden';

/**
 * Why a lookup failed. `source` is `'page'` for fetches of the paper itself
 * (the HTML or PDF being checked), which belong to no lookup service.
 */
export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  readonly source: SourceName | 'page';
  readonly retryAfterMs?: number;
  /**
   * Set when the service asked, with a Retry-After, not to be contacted for longer than a request waits: the time (ms
   * since the epoch) until which this source is sent nothing. The panel shows it.
   */
  readonly blockedUntil?: number;

  constructor(kind: SourceErrorKind, source: SourceName | 'page', message: string, retryAfterMs?: number, blockedUntil?: number) {
    super(message);
    this.name = 'SourceError';
    this.kind = kind;
    this.source = source;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (blockedUntil !== undefined) this.blockedUntil = blockedUntil;
  }
}

/**
 * A response that was redirected to an origin outside the allowlist. It is a refusal, never retried (SECURITY.md section 3),
 * and a caller that might ask again with other URLs can tell it apart from other bad responses.
 */
export class RefusedRedirectError extends SourceError {
  constructor(source: SourceName | 'page', message: string) {
    super('bad_response', source, message);
  }
}

/** A caller asked for a URL we must never contact. This is a bug in the caller, not a service failure. */
export class UrlNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlNotAllowedError';
  }
}

function freshLimiters(): Record<SourceName, RateLimiter> {
  return {
    crossref: createRateLimiter(RATE.crossref),
    arxiv: createRateLimiter(RATE.arxiv),
    openreview: createRateLimiter(RATE.openreview),
    dblp: createRateLimiter(RATE.dblp),
    openalex: createRateLimiter({ ratePerSec: RATE.openalex.ratePerSec, maxConcurrent: RATE.openalex.maxConcurrent }),
  };
}

export const limiters: Record<SourceName, RateLimiter> = freshLimiters();

/**
 * OpenAlex searches are metered, lookups by id are free. A search that is refused (429) pauses only this lane, so
 * the free lookups carry on. Not part of `limiters`: that is one limiter per source.
 */
let openalexSearchLimiter = createRateLimiter({ ratePerSec: RATE.openalex.ratePerSec, maxConcurrent: RATE.openalex.maxConcurrent });

type Source = SourceName | 'page';
type BodyKind = 'json' | 'xml' | 'html' | 'pdf';

interface BodyRule {
  accept: string;
  /** Exact media types (the part of Content-Type before ';', lower-case). */
  mediaTypes: readonly string[];
  /** Structured-syntax suffix such as "+json": `application/<name>+json` is accepted too. */
  suffix?: string;
  maxBytes: number;
  timeoutMs: number;
}

const BODY_RULES: Readonly<Record<BodyKind, BodyRule>> = {
  json: { accept: 'application/json', mediaTypes: ['application/json'], suffix: '+json', maxBytes: LIMITS.maxJsonBytes, timeoutMs: LIMITS.timeoutMs },
  xml: {
    accept: 'application/xml, text/xml, application/atom+xml',
    mediaTypes: ['application/xml', 'text/xml', 'application/atom+xml'],
    suffix: '+xml',
    maxBytes: LIMITS.maxXmlBytes,
    timeoutMs: LIMITS.timeoutMs,
  },
  html: { accept: 'text/html, application/xhtml+xml', mediaTypes: ['text/html', 'application/xhtml+xml'], maxBytes: LIMITS.maxHtmlBytes, timeoutMs: LIMITS.timeoutMs },
  pdf: { accept: 'application/pdf', mediaTypes: ['application/pdf'], maxBytes: LIMITS.maxPdfBytes, timeoutMs: LIMITS.pdfTimeoutMs },
};

function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function matchesBody(rule: BodyRule, mediaType: string): boolean {
  if (rule.mediaTypes.includes(mediaType)) return true;
  return rule.suffix !== undefined && /^application\/[a-z0-9][a-z0-9.-]*\+[a-z]+$/.test(mediaType) && mediaType.endsWith(rule.suffix);
}

const BACKOFF_BASE_MS = 500;
/**
 * Longest a source is left alone after it asks, with a Retry-After, for a longer pause than a request ever waits (more
 * than MAX_RETRY_WAIT_MS). An hour covers a service's maintenance window and the hour-long pauses services ask for under
 * load, and keeps one odd or hostile header from switching a source off for the rest of the day. The block lives in
 * memory only, and every reference it touches ends "try again later", never Not found.
 */
export const MAX_BLOCK_MS = 60 * 60 * 1000;
/** Longest we will sleep before a retry. A service asking for more is surfaced to the caller instead. */
const MAX_RETRY_WAIT_MS = MAX_DELAY_MS;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------- URL guard

let apiKey: string | undefined;

/**
 * Registers the OpenAlex key so `http.ts` can refuse to put it in any other origin's URL.
 * Pass `undefined` (or a blank string) to forget it. The value is trimmed here, but the
 * caller owns validating the key and catching the RangeError for one that is too short.
 */
export function setSecret(value: string | undefined): void {
  const key = value?.trim() ?? '';
  if (key === '') {
    apiKey = undefined;
    return;
  }
  if (key.length < 8) throw new RangeError('That is too short to be an API key');
  apiKey = key;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function containsSecret(rawUrl: string, href: string): boolean {
  if (apiKey === undefined) return false;
  // Also look through up to two layers of percent-encoding.
  const once = safeDecode(href);
  return [rawUrl, href, once, safeDecode(once)].some((text) => text.includes(apiKey as string));
}

function assertUrlAllowed(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlNotAllowedError('URL not allowed: it could not be parsed');
  }
  if (url.protocol !== 'https:') {
    throw new UrlNotAllowedError('Only https URLs are allowed');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UrlNotAllowedError('URL not allowed: it carries credentials');
  }
  if (!ALLOWED_ORIGINS.includes(url.origin)) {
    throw new UrlNotAllowedError(`Origin not allowed: ${url.origin}`);
  }
  // The OpenAlex key travels as a query parameter; make sure it can only ever reach OpenAlex.
  if (url.searchParams.has('api_key') && url.origin !== API.openalex) {
    throw new UrlNotAllowedError(`Origin not allowed to receive an API key: ${url.origin}`);
  }
  if (url.origin !== API.openalex && containsSecret(rawUrl, url.href)) {
    throw new UrlNotAllowedError(`Origin not allowed to receive an API key: ${url.origin}`);
  }
}

/** A redirect may only land on another allowlisted https origin. A response that reports no URL is not trusted. */
function isAllowedFinalUrl(finalUrl: string): boolean {
  if (finalUrl === '') return false;
  try {
    const url = new URL(finalUrl);
    return url.protocol === 'https:' && ALLOWED_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ helpers

function describe(url: string): string {
  return new URL(url).origin;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Settles with `promise`, or rejects as soon as `signal` aborts even if `promise` never notices. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads the body, giving up the moment it passes `maxBytes` (a Content-Length header is only a hint). */
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal, fail: (m: string) => SourceError): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw fail('Response is larger than the allowed size');
  }
  if (response.body === null) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        finished = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) throw fail('Response is larger than the allowed size');
      chunks.push(value);
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ------------------------------------------------------------------ one request

interface Fetched {
  bytes: Uint8Array<ArrayBuffer>;
  headers: Headers;
}

type Attempt = { done: true; fetched: Fetched } | { done: false; error: SourceError; retryAfterMs?: number };

async function attemptOnce(url: string, source: Source, kind: BodyKind, callerSignal: AbortSignal | undefined): Promise<Attempt> {
  const rules = BODY_RULES[kind];
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, rules.timeoutMs);
  const onCallerAbort = (): void => controller.abort(callerSignal ? abortReason(callerSignal) : undefined);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  const fail = (errorKind: SourceErrorKind, message: string, retryAfterMs?: number): SourceError =>
    new SourceError(errorKind, source, `${message} (${describe(url)})`, retryAfterMs);

  /** What a transport failure (before or during the body) means; retryable unless the browser is offline. */
  const transportFailure = (): Attempt => {
    if (isOffline()) throw fail('offline', 'The browser is offline');
    return { done: false, error: fail('network', 'Network error') };
  };

  try {
    let response: Response;
    try {
      response = await abortable(
        fetch(url, {
          method: 'GET',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'follow',
          cache: 'no-store',
          headers: { Accept: rules.accept },
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      if (timedOut) throw fail('timeout', `Request timed out after ${rules.timeoutMs} ms`);
      if (callerSignal?.aborted) throw error;
      return transportFailure();
    }

    const headers = response.headers;
    if (!isAllowedFinalUrl(response.url)) {
      void response.body?.cancel().catch(() => undefined);
      throw new RefusedRedirectError(source, `Redirected to an origin that is not allowed (${describe(url)})`);
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const status = response.status;
      const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
      if (RETRYABLE_STATUSES.has(status)) {
        const error =
          status === 429
            ? fail('rate_limited', 'Rate limited (HTTP 429)', retryAfterMs)
            : fail('network', `Server error (HTTP ${status})`, retryAfterMs);
        return { done: false, error, ...(retryAfterMs !== undefined && { retryAfterMs }) };
      }
      if (status === 404 || status === 410) throw fail('not_found_http', `Not found (HTTP ${status})`);
      if (status === 401 || status === 403) throw fail('forbidden', `Access refused (HTTP ${status})`);
      throw fail('bad_response', `Unexpected HTTP ${status}`);
    }

    const mediaType = mediaTypeOf(headers.get('content-type'));
    if (!matchesBody(rules, mediaType)) {
      void response.body?.cancel().catch(() => undefined);
      throw fail('unavailable', `Expected ${kind} but the service sent ${mediaType || 'no content type'}`);
    }

    try {
      const bytes = await readCapped(response, rules.maxBytes, controller.signal, (m) => fail('bad_response', m));
      return { done: true, fetched: { bytes, headers } };
    } catch (error) {
      if (timedOut) throw fail('timeout', `Request timed out after ${rules.timeoutMs} ms`);
      if (error instanceof SourceError || callerSignal?.aborted) throw error;
      return transportFailure();
    }
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// ------------------------------------------------------------ retry orchestration

/** Sources (and OpenAlex's search lane) that asked for a long pause: until when, and the kind of answer that asked. */
const blocks = new Map<string, { until: number; kind: SourceErrorKind }>();

/** The OpenAlex search lane's own block: only a 429 on a search, which is its metered daily budget. */
const OPENALEX_SEARCH_BLOCK = 'openalex:search';

/**
 * The blocks that hold a request back. OpenAlex's searches and id lookups go to the same host, so a block of the source
 * holds back both lanes; a search also waits for a block of its own lane.
 */
function blockLanesFor(source: Source, lane: 'search' | undefined): string[] {
  if (source === 'page') return []; // page fetches belong to no service and are never blocked
  return source === 'openalex' && lane === 'search' ? [OPENALEX_SEARCH_BLOCK, 'openalex'] : [source];
}

function blockedError(lanes: readonly string[], source: Source, url: string): SourceError | undefined {
  let latest: { until: number; kind: SourceErrorKind } | undefined;
  for (const lane of lanes) {
    const block = blocks.get(lane);
    if (block === undefined) continue;
    if (block.until <= Date.now()) blocks.delete(lane);
    else if (latest === undefined || block.until > latest.until) latest = block;
  }
  if (latest === undefined) return undefined;
  return new SourceError(latest.kind, source, `The service asked not to be contacted for a while; not sent (${describe(url)})`, latest.until - Date.now(), latest.until);
}

/** Blocks `lane` until `until`, or keeps the block it has if that one ends later: a later, shorter answer never shortens it. */
function block(lane: string, until: number, kind: SourceErrorKind): number {
  const held = blocks.get(lane);
  if (held !== undefined && held.until >= until) return held.until;
  blocks.set(lane, { until, kind });
  return until;
}

/** Per-run say on retries, keyed by the signal its lookups carry (setRetryRule). */
const retryRules = new WeakMap<AbortSignal, () => boolean>();

/**
 * Requests made with `signal` are retried only while `allowed()` says so; it is asked before each retry. A refusal never
 * adds a request: the request fails as it would after its last retry, and a Retry-After is honoured all the same.
 */
export function setRetryRule(signal: AbortSignal, allowed: () => boolean): void {
  retryRules.set(signal, allowed);
}

/** Whether a request made with `signal` may be retried now (true unless a retry rule says otherwise). */
export function retriesAllowed(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return true;
  return retryRules.get(signal)?.() ?? true;
}

async function guardedFetch(url: string, source: Source, kind: BodyKind, signal: AbortSignal | undefined, lane?: 'search'): Promise<Fetched> {
  assertUrlAllowed(url);
  const limiter = source === 'page' ? undefined : lane === 'search' && source === 'openalex' ? openalexSearchLimiter : limiters[source];
  const blockLanes = blockLanesFor(source, lane);

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw abortReason(signal);
    // Checked before the limiter too: a blocked request fails at once, without waiting for a slot it would not use.
    const blockedNow = blockedError(blockLanes, source, url);
    if (blockedNow !== undefined) throw blockedNow;
    // And checked again when the request's turn comes, so requests queued before the block are not sent either.
    const run = (): Promise<Attempt> => {
      const blocked = blockedError(blockLanes, source, url);
      return blocked === undefined ? attemptOnce(url, source, kind, signal) : Promise.reject(blocked);
    };
    const result = limiter ? await limiter.schedule(run, signal) : await run();

    if (result.done) {
      limiter?.updateFromHeaders(result.fetched.headers);
      return result.fetched;
    }
    const giveUp = attempt >= LIMITS.maxRetries || (result.retryAfterMs !== undefined && result.retryAfterMs > MAX_RETRY_WAIT_MS) || !retriesAllowed(signal);
    if (giveUp) {
      // Other jobs for this source must not walk straight into the same 429 or 503: a Retry-After is honoured whatever the
      // status (SECURITY.md section 3). A pause longer than a request waits blocks the source until the stated time (at
      // most MAX_BLOCK_MS): its later requests fail at once, unsent. A shorter one pauses the source's limiter.
      if (result.retryAfterMs !== undefined && result.retryAfterMs > MAX_RETRY_WAIT_MS && source !== 'page') {
        // A 429 on an OpenAlex search is its metered budget, which leaves the free id lookups alone; anything else that
        // asks for a pause holds back the whole source.
        const searchBudget = source === 'openalex' && lane === 'search' && result.error.kind === 'rate_limited';
        const until = block(searchBudget ? OPENALEX_SEARCH_BLOCK : source, Date.now() + Math.min(result.retryAfterMs, MAX_BLOCK_MS), result.error.kind);
        throw new SourceError(result.error.kind, source, result.error.message, result.retryAfterMs, until);
      } else if (result.retryAfterMs !== undefined) {
        limiter?.pauseFor(result.retryAfterMs);
      }
      throw result.error;
    }

    const waitMs = result.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt;
    if (limiter) limiter.pauseFor(waitMs); // the whole source backs off, not just this request
    else await sleep(waitMs, signal);
  }
}

/**
 * For unit tests only: forgets every block, pause and lowered rate, since this module's state outlives a single test.
 * No page or message handler reaches it (a unit test checks that no other file in src/ names it), and outside a
 * test run it does nothing: a Retry-After is never cleared by hand (SECURITY.md section 3).
 */
export function resetNetworkStateForTests(): void {
  if (import.meta.env.MODE !== 'test') return;
  blocks.clear();
  Object.assign(limiters, freshLimiters());
  openalexSearchLimiter = createRateLimiter({ ratePerSec: RATE.openalex.ratePerSec, maxConcurrent: RATE.openalex.maxConcurrent });
}

// ------------------------------------------------------------------ public API

export async function fetchJson(
  url: string,
  opts: { source: SourceName; signal?: AbortSignal; /** A metered search: paced and paused apart from the source's free lookups. */ lane?: 'search' },
): Promise<{ data: unknown; headers: Headers }> {
  const { bytes, headers } = await guardedFetch(url, opts.source, 'json', opts.signal, opts.lane);
  try {
    const data: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return { data, headers };
  } catch {
    throw new SourceError('bad_response', opts.source, `Response was not valid JSON (${describe(url)})`);
  }
}

function decoderFor(contentType: string | null): TextDecoder {
  const label = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? '')?.[1];
  if (label) {
    try {
      return new TextDecoder(label);
    } catch {
      // Unknown charset label: fall through to UTF-8.
    }
  }
  return new TextDecoder('utf-8');
}

export async function fetchText(
  url: string,
  opts: { source: SourceName | 'page'; kind: 'xml' | 'html'; signal?: AbortSignal },
): Promise<string> {
  const { bytes, headers } = await guardedFetch(url, opts.source, opts.kind, opts.signal);
  return decoderFor(headers.get('content-type')).decode(bytes);
}

export async function fetchBytes(url: string, opts: { source: 'page'; signal?: AbortSignal }): Promise<ArrayBuffer> {
  const { bytes } = await guardedFetch(url, opts.source, 'pdf', opts.signal);
  return bytes.buffer;
}
