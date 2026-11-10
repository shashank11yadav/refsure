import { describe, expect, test } from 'vitest';
import { ALLOWED_HOST_PATTERNS, ALLOWED_ORIGINS, API, HOST_PERMISSION_ORIGINS, extensionPagesCsp, CONTACT_EMAIL, LIMITS, RATE, TTL } from '../../src/config';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('network allowlist', () => {
  test('host patterns are exactly the seven entries from SECURITY.md section 3', () => {
    expect([...ALLOWED_HOST_PATTERNS].sort()).toEqual(
      [
        'https://arxiv.org/*',
        'https://export.arxiv.org/*',
        'https://openreview.net/*',
        'https://api2.openreview.net/*',
        'https://api.crossref.org/*',
        'https://api.openalex.org/*',
        'https://dblp.org/*',
      ].sort(),
    );
  });

  test('host permission origins are the https origin of every host pattern', () => {
    expect([...HOST_PERMISSION_ORIGINS].sort()).toEqual(
      [
        'https://arxiv.org',
        'https://export.arxiv.org',
        'https://openreview.net',
        'https://api2.openreview.net',
        'https://api.crossref.org',
        'https://api.openalex.org',
        'https://dblp.org',
      ].sort(),
    );
    for (const origin of HOST_PERMISSION_ORIGINS) expect(new URL(origin).origin).toBe(origin);
  });

  // openreview.net is a host permission only (the browser hides a tab's address without one, and the content
  // script runs there), but nothing is ever fetched from it: the network allowlist has six origins.
  test('the network allowlist is those origins without openreview.net, which nothing fetches from', () => {
    expect([...ALLOWED_ORIGINS].sort()).toEqual(
      [
        'https://arxiv.org',
        'https://export.arxiv.org',
        'https://api2.openreview.net',
        'https://api.crossref.org',
        'https://api.openalex.org',
        'https://dblp.org',
      ].sort(),
    );
    expect(ALLOWED_ORIGINS).not.toContain('https://openreview.net');
    for (const origin of ALLOWED_ORIGINS) expect(HOST_PERMISSION_ORIGINS).toContain(origin);
  });

  test('every API base URL is https; all but the OpenReview page address (a link base) are inside the network allowlist', () => {
    for (const [name, url] of Object.entries(API)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(HOST_PERMISSION_ORIGINS).toContain(parsed.origin);
      if (name === 'openreviewSite') expect(ALLOWED_ORIGINS).not.toContain(parsed.origin);
      else expect(ALLOWED_ORIGINS).toContain(parsed.origin);
    }
  });

  test('API base URLs match the agreed values', () => {
    expect(API).toEqual({
      crossref: 'https://api.crossref.org',
      openalex: 'https://api.openalex.org',
      arxivApi: 'https://export.arxiv.org/api/query',
      arxivSite: 'https://arxiv.org',
      openreviewApi: 'https://api2.openreview.net',
      openreviewSite: 'https://openreview.net',
      dblp: 'https://dblp.org/search/publ/api',
    });
  });
});

describe('contact email', () => {
  test('is the project address the owner chose (Crossref asks for a contact in mailto)', () => {
    expect(CONTACT_EMAIL).toBe('yshashank7575@gmail.com');
  });
});

describe('limits (SECURITY.md section 3)', () => {
  test('timeouts and size caps', () => {
    expect(LIMITS.timeoutMs).toBe(15_000);
    expect(LIMITS.pdfTimeoutMs).toBe(30_000);
    expect(LIMITS.maxJsonBytes).toBe(5 * 1024 * 1024);
    expect(LIMITS.maxXmlBytes).toBe(5 * 1024 * 1024);
    expect(LIMITS.maxHtmlBytes).toBe(10 * 1024 * 1024);
    expect(LIMITS.maxPdfBytes).toBe(30 * 1024 * 1024);
    expect(LIMITS.maxRetries).toBe(3);
  });
});

describe('rate limits', () => {
  test('per-source rates match the measured values', () => {
    expect(RATE.crossref.ratePerSec).toBe(3);
    expect(RATE.arxiv.ratePerSec).toBeCloseTo(1 / 3, 10);
    expect(RATE.openreview.ratePerSec).toBe(2);
    expect(RATE.dblp.ratePerSec).toBe(1);
  });

  test('every source has a positive rate and concurrency', () => {
    for (const source of Object.values(RATE)) {
      expect(source.ratePerSec).toBeGreaterThan(0);
      expect(source.maxConcurrent).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(RATE).sort()).toEqual(['arxiv', 'crossref', 'dblp', 'openalex', 'openreview']);
  });

  test('OpenAlex search budget is metered', () => {
    expect(RATE.openalex.searchCostUsd).toBe(0.001);
  });
});

describe('cache lifetimes', () => {
  test('record 14 days, negative 3 days, retraction 7 days', () => {
    expect(TTL.recordMs).toBe(14 * DAY_MS);
    expect(TTL.negativeMs).toBe(3 * DAY_MS);
    expect(TTL.retractionMs).toBe(7 * DAY_MS);
  });
});

describe('extension pages CSP', () => {
  const PRODUCTION =
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
    "connect-src 'self' https://arxiv.org https://export.arxiv.org " +
    'https://api2.openreview.net https://api.crossref.org https://api.openalex.org https://dblp.org';

  test('a production build gets exactly the ruled policy, with no localhost', () => {
    expect(extensionPagesCsp('build')).toBe(PRODUCTION);
    expect(extensionPagesCsp('build')).not.toMatch(/localhost|ws:/);
  });

  test('only the dev server (serve) adds localhost for live reload', () => {
    const dev = extensionPagesCsp('serve');
    expect(dev).toBe(`${PRODUCTION} ws://localhost:* http://localhost:*`);
    expect(dev.startsWith(PRODUCTION)).toBe(true);
  });
});
