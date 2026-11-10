// Single place for every constant that security or rate-limit rules depend on.
// Changing anything here changes what the extension may contact or how fast;
// the manifest and config tests pin these values on purpose.

/**
 * The project's contact address: it identifies RefSure to Crossref (`mailto`), as Crossref asks.
 * Never a user's personal email (SECURITY.md section 7).
 */
export const CONTACT_EMAIL = 'yshashank7575@gmail.com';

/**
 * The manifest host permissions (SECURITY.md section 3): the manifest requests exactly these.
 * They are wider than the network allowlist below by one entry: `https://openreview.net/*` is
 * there so the browser shows the extension a forum tab's address and lets the content script run,
 * but nothing is ever fetched from it.
 */
export const ALLOWED_HOST_PATTERNS = [
  'https://arxiv.org/*',
  'https://export.arxiv.org/*',
  'https://openreview.net/*',
  'https://api2.openreview.net/*',
  'https://api.crossref.org/*',
  'https://api.openalex.org/*',
  'https://dblp.org/*',
] as const;

/** The host permissions as bare origins. */
export const HOST_PERMISSION_ORIGINS: readonly string[] = ALLOWED_HOST_PATTERNS.map((pattern) =>
  pattern.replace(/\/\*$/, ''),
);

/** Host permissions that are never a network target: the page is read, not fetched. */
const PAGE_ONLY_ORIGINS: readonly string[] = ['https://openreview.net'];

/**
 * The network allowlist: the only origins the code may contact. It is the origin of `src/sources/http.ts`'s
 * check and of the CSP `connect-src`, so a stray request to a page-only host is refused twice.
 */
export const ALLOWED_ORIGINS: readonly string[] = HOST_PERMISSION_ORIGINS.filter((origin) => !PAGE_ONLY_ORIGINS.includes(origin));

/**
 * The CSP for extension pages. `connect-src` is the browser-enforced second layer of
 * the network allowlist (SECURITY.md section 3), generated from `ALLOWED_ORIGINS` so
 * the two cannot drift. `serve` (the WXT dev server only) additionally allows
 * localhost for live reload; a production build never does.
 */
export function extensionPagesCsp(command: 'build' | 'serve'): string {
  const connect = ["'self'", ...ALLOWED_ORIGINS, ...(command === 'serve' ? ['ws://localhost:*', 'http://localhost:*'] : [])];
  return [
    // Everything not named below (images, styles, fonts, media, frames, workers) loads from the package only.
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    `connect-src ${connect.join(' ')}`,
  ].join('; ');
}

/** Base URLs of the lookup services (each inside `ALLOWED_ORIGINS`), and `openreviewSite`, which only builds links. */
export const API = {
  crossref: 'https://api.crossref.org',
  openalex: 'https://api.openalex.org',
  arxivApi: 'https://export.arxiv.org/api/query',
  arxivSite: 'https://arxiv.org',
  openreviewApi: 'https://api2.openreview.net',
  openreviewSite: 'https://openreview.net',
  dblp: 'https://dblp.org/search/publ/api',
} as const;

/**
 * Where the Firefox build puts pdf.js's worker, relative to the package root (scripts/pdfjsBuild.ts emits
 * it there; src/extract/pdfjsRuntime.ts points pdf.js at it). Fixed so nothing has to guess a hashed name.
 */
export const FIREFOX_PDF_WORKER = 'pdf.worker.mjs';

const MB = 1024 * 1024;

/** Timeouts, response size caps and retry ceiling (SECURITY.md section 3). */
export const LIMITS = {
  timeoutMs: 15_000,
  pdfTimeoutMs: 30_000,
  maxJsonBytes: 5 * MB,
  maxXmlBytes: 5 * MB,
  maxHtmlBytes: 10 * MB,
  maxPdfBytes: 30 * MB,
  maxRetries: 3,
} as const;

/**
 * Starting request rates per source (measured 2026-10-21). The rate limiter
 * lowers these further when a response's rate-limit headers say so.
 * `maxConcurrent` and the OpenAlex `ratePerSec` are conservative choices of
 * ours, not published limits.
 */
export const RATE = {
  crossref: { ratePerSec: 3, maxConcurrent: 3 }, // polite pool (requests carry a mailto)
  arxiv: { ratePerSec: 1 / 3, maxConcurrent: 1 }, // one request per 3 s; batch IDs
  openreview: { ratePerSec: 2, maxConcurrent: 2 },
  dblp: { ratePerSec: 1, maxConcurrent: 1 }, // best-effort source
  openalex: {
    ratePerSec: 2,
    maxConcurrent: 2,
    // Searches are metered per IP ($0.10 a day) or per free key ($1 a day); lookups by ID are free.
    searchCostUsd: 0.001,
  },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long cached results stay valid. */
export const TTL = {
  recordMs: 14 * DAY_MS,
  negativeMs: 3 * DAY_MS,
  // Shorter than recordMs so a retraction issued after we cached a record is noticed.
  retractionMs: 7 * DAY_MS,
} as const;
