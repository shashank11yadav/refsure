// A `fetch` that remembers every answer on disk, so an evaluation can be stopped, resumed and scored again
// without asking the services twice. It replaces `globalThis.fetch` for the whole process; src/sources/http.ts
// still does all the checking (allowlist, size, content type), because it is what calls this.
//
//  * Only answers worth keeping are kept: 200, 404 and 410. A 429 or a server error is never stored.
//  * Crossref's `mailto` is removed unless REFSURE_CONTACT_EMAIL is set (then it carries that address), so the
//    evaluation uses the public pool by default and the project address in src/config.ts is not sent.
//    The cache key ignores it.
//  * Offline mode answers from disk only; a miss is answered 403 (the service refused), counted and reported.
//  * An answer replayed from disk carries no rate-limit or budget headers: they described the service on the day it
//    answered, and one stored "budget 0" would otherwise block every later OpenAlex search, even on a new day.
//    Only live answers may set the budget or the rate. The headers are still stored, so nothing on disk changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FetchStats {
  live: number;
  cached: number;
  /** Requests that needed the network in offline mode. */
  misses: number;
  byHost: Record<string, { live: number; cached: number }>;
}

interface Stored {
  url: string;
  finalUrl: string;
  status: number;
  headers: [string, string][];
}

const KEEP = new Set([200, 404, 410]);
// Headers that describe how the bytes travelled, not what they are (the body is stored already decoded).
const TRANSPORT_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
// `x-ratelimit-*` (OpenAlex's budget), `x-rate-limit-*` (Crossref's rate) and `retry-after`.
const RATE_HEADER = /^(x-rate-?limit-|retry-after$)/i;
const USER_AGENT = 'RefSure-evaluation/0.1 (accuracy test of an open-source extension)';

export interface DiskFetch {
  /** Starts counting again from zero and returns what was counted before. */
  take(): FetchStats;
}

function emptyStats(): FetchStats {
  return { live: 0, cached: 0, misses: 0, byHost: {} };
}

function keyOf(input: string): string {
  const url = new URL(input);
  if (url.hostname === 'api.crossref.org') url.searchParams.delete('mailto');
  return createHash('sha256').update(`GET ${url.href}`).digest('hex');
}

export function installDiskFetch(options: { dir: string; offline: boolean; contactEmail?: string | undefined }): DiskFetch {
  mkdirSync(options.dir, { recursive: true });
  const realFetch = globalThis.fetch;
  let stats = emptyStats();

  const count = (host: string, field: 'live' | 'cached'): void => {
    stats[field] += 1;
    const entry = (stats.byHost[host] ??= { live: 0, cached: 0 });
    entry[field] += 1;
  };

  const respond = (body: Uint8Array<ArrayBuffer>, status: number, headers: [string, string][], finalUrl: string): Response => {
    const response = new Response(status === 204 || status === 304 ? null : body, { status, headers });
    // `Response.url` is read-only and empty for a made-up response; src/sources/http.ts insists on it.
    Object.defineProperty(response, 'url', { value: finalUrl });
    return response;
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requested = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const host = requested.hostname;
    const key = keyOf(requested.href);
    const meta = join(options.dir, `${key}.json`);
    const bodyFile = join(options.dir, `${key}.body`);

    if (existsSync(meta) && existsSync(bodyFile)) {
      const stored = JSON.parse(readFileSync(meta, 'utf8')) as Stored;
      count(host, 'cached');
      const headers = stored.headers.filter(([name]) => !RATE_HEADER.test(name));
      return respond(Uint8Array.from(readFileSync(bodyFile)), stored.status, headers, stored.finalUrl);
    }
    if (options.offline) {
      // DBLP's answers are bot-check pages that are never kept; a replay without them is as good as the live run.
      if (host !== 'dblp.org') stats.misses += 1;
      // Answered as a refusal (403), which the engine does not retry, instead of a network error, which it
      // would retry with a growing pause: a re-score must not wait on requests that cannot happen.
      return respond(new Uint8Array(0), 403, [], requested.href);
    }

    const target = new URL(requested.href);
    if (host === 'api.crossref.org' && options.contactEmail !== undefined) target.searchParams.set('mailto', options.contactEmail);
    else if (host === 'api.crossref.org') target.searchParams.delete('mailto');
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', USER_AGENT);
    const live = await realFetch(target.href, { ...init, headers });
    count(host, 'live');

    const bytes = new Uint8Array(await live.arrayBuffer());
    const kept: [string, string][] = [...live.headers.entries()].filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()));
    const finalUrl = live.url === '' ? requested.href : live.url;
    if (KEEP.has(live.status)) {
      writeFileSync(bodyFile, bytes);
      writeFileSync(meta, JSON.stringify({ url: requested.href, finalUrl, status: live.status, headers: kept } satisfies Stored));
    }
    return respond(bytes, live.status, kept, finalUrl);
  };

  return {
    take() {
      const before = stats;
      stats = emptyStats();
      return before;
    },
  };
}
