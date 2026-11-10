import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API, LIMITS } from '../../../src/config';

type Http = typeof import('../../../src/sources/http');

const fetchMock = vi.fn<typeof fetch>();
let http: Http;

const MB = 1024 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** A Response that reports an allowlisted final URL, as a real fetch always does. */
function R(body: BodyInit | null, init?: ResponseInit, url = `${API.crossref}/mock`): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

function respond(body: BodyInit | null, headers: Record<string, string> = {}, status = 200): void {
  fetchMock.mockResolvedValueOnce(R(body, { status, headers }));
}
function respondJson(value: unknown): void {
  respond(JSON.stringify(value), JSON_HEADERS);
}
function mockStatus(status: number, headers: Record<string, string> = {}): void {
  fetchMock.mockImplementation(() => Promise.resolve(R('', { status, headers })));
}
/** A fetch that honours the abort signal, like the real one. */
function mockHang(): void {
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
}
function mockOffline(): void {
  vi.stubGlobal('navigator', { onLine: false });
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
}
/** A body of `total` bytes in 1 MB chunks; `pulled` counts chunks actually requested. */
/** Lets the rate limiters open up between back-to-back requests to the same source. */
const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(5000);
};

function chunkedBody(total: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let sent = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const size = Math.min(MB, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
      if (sent >= total) controller.close();
    },
  });
  return { stream, pulled: () => pulls };
}

beforeEach(async () => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules(); // fresh limiters (and their pauses) for every test
  http = await import('../../../src/sources/http');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('URL guard', () => {
  test('rejects origins outside the allowlist', async () => {
    await expect(http.fetchJson('https://evil.example/x', { source: 'crossref' })).rejects.toThrow(/not allowed/);
    await expect(http.fetchJson('https://api.crossref.org.evil.example/x', { source: 'crossref' })).rejects.toThrow(/not allowed/);
    await expect(http.fetchJson('https://api.crossref.org:8443/x', { source: 'crossref' })).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects non-https URLs', async () => {
    await expect(http.fetchJson('http://api.crossref.org/works', { source: 'crossref' })).rejects.toThrow(/https/);
    await expect(http.fetchJson('ftp://api.crossref.org/works', { source: 'crossref' })).rejects.toThrow(/https/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects malformed URLs and URLs with embedded credentials', async () => {
    await expect(http.fetchJson('not a url', { source: 'crossref' })).rejects.toThrow(/not allowed/);
    await expect(http.fetchJson('https://user:pw@api.crossref.org/works', { source: 'crossref' })).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an api_key parameter may only go to api.openalex.org', async () => {
    await expect(http.fetchJson(`${API.crossref}/works?api_key=SECRET`, { source: 'crossref' })).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
    respondJson({ ok: true });
    await expect(http.fetchJson(`${API.openalex}/works?api_key=SECRET`, { source: 'openalex' })).resolves.toBeDefined();
  });

  test('guard errors never echo the query string', async () => {
    const error = await http.fetchJson('https://evil.example/x?api_key=SECRET', { source: 'crossref' }).catch((e: unknown) => e);
    expect(String(error)).not.toContain('SECRET');
  });

  test('rejects a response that was redirected outside the allowlist', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(R('{}', { status: 200, headers: JSON_HEADERS }, 'https://evil.example/landing?x=1')));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // a bad redirect is not retried
  });

  test('a redirect out of the allowlist is a refusal the caller can tell apart', async () => {
    fetchMock.mockResolvedValueOnce(R('{}', { status: 200, headers: JSON_HEADERS }, 'https://evil.example/landing'));
    const error = await http.fetchJson(`${API.crossref}/works`, { source: 'crossref' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(http.RefusedRedirectError);
    expect(error).toMatchObject({ name: 'SourceError', kind: 'bad_response' });
  });

  test('a redirect to plain http is rejected too', async () => {
    fetchMock.mockResolvedValueOnce(R('{}', { status: 200, headers: JSON_HEADERS }, 'http://api.crossref.org/works'));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  test('a response that reports no URL fails closed', async () => {
    fetchMock.mockResolvedValueOnce(R('{}', { status: 200, headers: JSON_HEADERS }, ''));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('an off-allowlist redirect on an error status is rejected, not mapped to the status', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(R('', { status: 503 }, 'https://evil.example/x')));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('accepts a redirect that stays inside the allowlist', async () => {
    fetchMock.mockResolvedValueOnce(R('{"a":1}', { status: 200, headers: JSON_HEADERS }, 'https://export.arxiv.org/v2/works'));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).resolves.toMatchObject({ data: { a: 1 } });
  });
});

describe('request options', () => {
  test('never sends credentials or a referrer, and carries an abort signal', async () => {
    respondJson({ ok: true });
    await http.fetchJson(`${API.crossref}/works?query=x`, { source: 'crossref' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal) }),
    );
  });

  test('every wrapper uses the same safe options', async () => {
    respond('<feed/>', { 'content-type': 'application/atom+xml' });
    respond('<html/>', { 'content-type': 'text/html' });
    respond('%PDF-', { 'content-type': 'application/pdf' });
    await http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' });
    await http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' });
    await http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    }
  });
});

describe('fetchJson', () => {
  test('returns parsed data and the response headers', async () => {
    respond('{"message":{"title":["A"]}}', { ...JSON_HEADERS, 'x-rate-limit-limit': '3' });
    const { data, headers } = await http.fetchJson(`${API.crossref}/works/10.1/x`, { source: 'crossref' });
    expect(data).toEqual({ message: { title: ['A'] } });
    expect(headers.get('x-rate-limit-limit')).toBe('3');
  });

  test('accepts vendor +json content types', async () => {
    respond('{"a":1}', { 'content-type': 'application/vnd.api+json' });
    await expect(http.fetchJson(`${API.openalex}/works`, { source: 'openalex' })).resolves.toMatchObject({ data: { a: 1 } });
  });

  test('bot-challenge HTML from a JSON API is unavailable and never parsed', async () => {
    respond("<!doctype html><title>Making sure you&#39;re not a bot!</title>", { 'content-type': 'text/html' });
    await expect(http.fetchJson(API.dblp + '?q=x&format=json', { source: 'dblp' })).rejects.toMatchObject({
      kind: 'unavailable',
      source: 'dblp',
    });
  });

  test('a JSON-looking body with no content-type is unavailable', async () => {
    respond('{"a":1}', {});
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  test('invalid JSON under a JSON content-type is bad_response', async () => {
    respond('{not json', JSON_HEADERS);
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  test('maps HTTP errors without retrying client errors', async () => {
    mockStatus(404);
    await expect(http.fetchJson(`${API.crossref}/works/x`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'not_found_http' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await tick();
    mockStatus(403);
    await expect(http.fetchJson(`${API.crossref}/works/x`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'forbidden' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await tick();
    mockStatus(400);
    await expect(http.fetchJson(`${API.crossref}/works/x`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  test('429 with Retry-After becomes rate_limited with retryAfterMs, after at most 3 retries', async () => {
    mockStatus(429, { 'retry-after': '2' });
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1 + LIMITS.maxRetries);
  });

  test('honours Retry-After between attempts', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '2' } }));
    respondJson({ ok: true });
    const p = http.fetchJson(`${API.crossref}/works`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a 429 pauses the whole source, not just the one request', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '5' } }));
    respondJson({ n: 1 });
    respondJson({ n: 2 });
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(10);
    const second = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second is still held back
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('a Retry-After longer than we are willing to wait is surfaced, not slept through', async () => {
    mockStatus(429, { 'retry-after': '3600' });
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 3_600_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('understands an HTTP-date Retry-After', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fetchMock.mockResolvedValueOnce(
      R('', { status: 429, headers: { 'retry-after': new Date('2026-01-01T00:00:04Z').toUTCString() } }),
    );
    respondJson({ ok: true });
    const p = http.fetchJson(`${API.crossref}/works`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ data: { ok: true } });
  });

  test('503 is retried with exponential backoff, then reported as network', async () => {
    mockStatus(503);
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'network' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 500 ms
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); // + 1 s
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000); // + 2 s
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1 + LIMITS.maxRetries);
  });

  test('a transient failure followed by success returns the success', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 502 }));
    respondJson({ ok: true });
    const p = http.fetchJson(`${API.crossref}/works`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toMatchObject({ data: { ok: true } });
  });

  test('page fetches (no limiter) retry too', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503 }));
    respond('<html/>', { 'content-type': 'text/html' });
    const p = http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe('<html/>');
  });

  test('stops waiting for a retry when the caller aborts', async () => {
    mockStatus(503);
    const controller = new AbortController();
    const assertion = expect(
      http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('timeouts and connectivity', () => {
  test('a hung request times out after LIMITS.timeoutMs', async () => {
    mockHang();
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1); // a hang is not retried
  });

  test('times out even if fetch ignores the abort signal', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
    await assertion;
  });

  test('the timeout also covers a body that stalls mid-stream', async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    fetchMock.mockResolvedValueOnce(R(stalled, { status: 200, headers: JSON_HEADERS }));
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
    await assertion;
  });

  test('PDFs get the longer timeout', async () => {
    mockHang();
    const assertion = expect(http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' })).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let settled = false;
    void assertion.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(LIMITS.pdfTimeoutMs - LIMITS.timeoutMs);
    await assertion;
  });

  test('a fetch TypeError while navigator.onLine is false is offline', async () => {
    mockOffline();
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'offline' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a fetch TypeError while online is a network error after retries', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'network' });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1 + LIMITS.maxRetries);
  });

  test('works where there is no navigator', async () => {
    vi.stubGlobal('navigator', undefined);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'network' });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  test('a caller abort surfaces as AbortError, not a SourceError', async () => {
    mockHang();
    const controller = new AbortController();
    const assertion = expect(
      http.fetchJson(`${API.crossref}/works`, { source: 'crossref', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
  });

  test('error messages never contain the query string', async () => {
    const url = `${API.openalex}/works?search=x&api_key=SECRET`;
    mockStatus(500);
    const a = http.fetchJson(url, { source: 'openalex' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const e1 = await a;
    expect(e1).toBeInstanceOf(http.SourceError);
    expect(String((e1 as Error).message)).not.toMatch(/SECRET|api_key|\?/);

    mockHang();
    const b = http.fetchJson(url, { source: 'openalex' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs + 5000);
    expect(String(((await b) as Error).message)).not.toMatch(/SECRET|api_key|\?/);
  });
});

describe('size caps', () => {
  test('a JSON body over 5 MB is bad_response, and reading stops early', async () => {
    const { stream, pulled } = chunkedBody(20 * MB);
    fetchMock.mockResolvedValueOnce(R(stream, { status: 200, headers: JSON_HEADERS }));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(pulled()).toBeLessThanOrEqual(8); // stopped near the 5 MB mark, nowhere near 20
  });

  test('a declared Content-Length over the cap is rejected before reading', async () => {
    const { stream, pulled } = chunkedBody(6 * MB);
    fetchMock.mockResolvedValueOnce(
      R(stream, { status: 200, headers: { ...JSON_HEADERS, 'content-length': String(6 * MB) } }),
    );
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  test('a lying Content-Length does not defeat the cap', async () => {
    const { stream } = chunkedBody(6 * MB);
    fetchMock.mockResolvedValueOnce(R(stream, { status: 200, headers: { ...JSON_HEADERS, 'content-length': '10' } }));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  test('XML is capped at 5 MB but HTML may be up to 10 MB', async () => {
    const xml = chunkedBody(6 * MB);
    fetchMock.mockResolvedValueOnce(R(xml.stream, { status: 200, headers: { 'content-type': 'application/atom+xml' } }));
    await expect(http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' })).rejects.toMatchObject({ kind: 'bad_response' });

    const ok = chunkedBody(6 * MB);
    fetchMock.mockResolvedValueOnce(R(ok.stream, { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' })).resolves.toHaveLength(6 * MB);

    const big = chunkedBody(11 * MB);
    fetchMock.mockResolvedValueOnce(R(big.stream, { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  test('PDFs are capped at 30 MB', async () => {
    const ok = chunkedBody(2 * MB);
    fetchMock.mockResolvedValueOnce(R(ok.stream, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const bytes = await http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' });
    expect(bytes.byteLength).toBe(2 * MB);

    fetchMock.mockResolvedValueOnce(
      R('x', { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(31 * MB) } }),
    );
    await expect(http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' })).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('fetchText and fetchBytes content types', () => {
  test('xml and html kinds require a matching content type', async () => {
    respond('<html>challenge</html>', { 'content-type': 'text/html' });
    await expect(http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' })).rejects.toMatchObject({ kind: 'unavailable' });
    respond('{"a":1}', JSON_HEADERS);
    await expect(http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  test('accepts text/xml and application/xml for xml', async () => {
    respond('<a/>', { 'content-type': 'text/xml; charset=utf-8' });
    await expect(http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' })).resolves.toBe('<a/>');
    await tick();
    respond('<a/>', { 'content-type': 'application/xml' });
    await expect(http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' })).resolves.toBe('<a/>');
  });

  test('honours the declared charset and survives an unknown one', async () => {
    fetchMock.mockResolvedValueOnce(
      R(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }),
    );
    await expect(http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' })).resolves.toBe('café');
    respond('ok', { 'content-type': 'text/html; charset=bogus-9000' });
    await expect(http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' })).resolves.toBe('ok');
  });

  test('fetchBytes returns an ArrayBuffer for a PDF and rejects other types', async () => {
    respond('%PDF-1.7', { 'content-type': 'application/pdf' });
    const buffer = await http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' });
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(buffer)).toBe('%PDF-1.7');
    respond('<html/>', { 'content-type': 'text/html' });
    await expect(http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('limiters', () => {
  test('there is one limiter per source', () => {
    expect(Object.keys(http.limiters).sort()).toEqual(['arxiv', 'crossref', 'dblp', 'openalex', 'openreview']);
  });

  test('requests to a source go through its limiter', async () => {
    respondJson({ n: 1 });
    respondJson({ n: 2 });
    const spy = vi.spyOn(http.limiters.arxiv, 'schedule');
    // arXiv is one request per 3 s: the second call must wait.
    const a = http.fetchJson(`${API.arxivApi}?a=1`, { source: 'arxiv' });
    const b = http.fetchJson(`${API.arxivApi}?a=2`, { source: 'arxiv' });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([a, b]);
    expect(spy).toHaveBeenCalled();
  });

  test('response rate-limit headers feed back into the limiter', async () => {
    respond('{}', { ...JSON_HEADERS, 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '10s' });
    respondJson({});
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' });
    const second = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('failures after the response has started', () => {
  /** A body that delivers some bytes, then dies the way a dropped connection does. */
  function dyingBody(): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          return;
        }
        controller.error(new TypeError('network error'));
      },
    });
  }

  test('a connection that drops mid-body is a network error, retried like any other', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    fetchMock.mockImplementation(() => Promise.resolve(R(dyingBody(), { status: 200, headers: JSON_HEADERS })));
    const assertion = expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({
      kind: 'network',
      source: 'crossref',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1 + LIMITS.maxRetries);
  });

  test('a mid-body drop that is followed by a good response recovers', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    fetchMock.mockResolvedValueOnce(R(dyingBody(), { status: 200, headers: JSON_HEADERS }));
    respondJson({ ok: true });
    const p = http.fetchJson(`${API.crossref}/works`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toMatchObject({ data: { ok: true } });
  });

  test('a mid-body drop while the browser is offline is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    fetchMock.mockImplementation(() => Promise.resolve(R(dyingBody(), { status: 200, headers: JSON_HEADERS })));
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'offline' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a mid-body failure that is not even a TypeError is still classified', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('stream exploded'));
      },
    });
    fetchMock.mockImplementation(() => Promise.resolve(R(stream, { status: 200, headers: { 'content-type': 'text/html' } })));
    const p = http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBeInstanceOf(http.SourceError);
  });

  test('a pre-response failure that is not a TypeError is never rethrown raw', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    fetchMock.mockRejectedValue(new Error('something odd inside fetch'));
    const p = http.fetchJson(`${API.crossref}/works`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toMatchObject({ name: 'SourceError', kind: 'network' });
  });
});

describe('429 back-pressure when retries are not worth waiting for', () => {
  // A Retry-After longer than a request waits blocks the source until the stated
  // time. The queued request is not held back for 30 s and then sent into the same answer: it fails at once, unsent.
  test('a final 429 with a long Retry-After blocks the source: queued jobs fail at once, unsent', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '3600' } }));
    respondJson({ n: 2 });
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    const second = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
    expect(await second).toMatchObject({ name: 'SourceError', kind: 'rate_limited' });
    expect(((await second) as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(3_590_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('the block ends at the stated time, and another source is never blocked by it', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '120' } }));
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    respond(JSON.stringify({ id: 'W1' }), JSON_HEADERS);
    const other = http.fetchJson(`${API.openalex}/works/doi:10.1/x`, { source: 'openalex' });
    await vi.advanceTimersByTimeAsync(600);
    await expect(other).resolves.toMatchObject({ data: { id: 'W1' } });
    await vi.advanceTimersByTimeAsync(110_000);
    await expect(http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    respondJson({ n: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    const later = http.fetchJson(`${API.crossref}/works?a=3`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(later).resolves.toMatchObject({ data: { n: 3 } });
  });

  test('a block lasts at most MAX_BLOCK_MS, whatever the Retry-After says', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': String(7 * 86_400) } }));
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(http.MAX_BLOCK_MS - 5000);
    await expect(http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    respondJson({ n: 2 });
    const after = http.fetchJson(`${API.crossref}/works?a=3`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(after).resolves.toMatchObject({ data: { n: 2 } });
  });

  // SECURITY section 3 says Retry-After is honoured, whatever the status.
  test('a final 503 with a long Retry-After blocks the source too', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    const second = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ kind: 'network', retryAfterMs: 3_600_000 });
    expect(await second).toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a final 503 with a Retry-After within the wait still pauses the source, then sends', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(R('', { status: 503, headers: { 'retry-after': '5' } })));
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(await first).toMatchObject({ kind: 'network', retryAfterMs: 5000 });
    fetchMock.mockReset();
    respondJson({ n: 2 });
    const next = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(next).resolves.toMatchObject({ data: { n: 2 } });
  });

  test('exhausted retries also leave the source paused for the Retry-After', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(R('', { status: 429, headers: { 'retry-after': '5' } })));
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_100); // attempts at 0, 5, 10 and 15 s; the last one is final
    expect(await first).toMatchObject({ kind: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1 + LIMITS.maxRetries);
    fetchMock.mockReset();
    respondJson({ n: 2 });
    const next = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(4000); // still inside the final 5 s pause
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(2000);
    await next;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAlex searches have their own pause', () => {
  test('a search that gets a long 429 does not hold back the free lookups by id', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '3600' } }, `${API.openalex}/works`));
    respond(JSON.stringify({ id: 'W1' }), JSON_HEADERS);
    const search = http.fetchJson(`${API.openalex}/works?search=a`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await search).toMatchObject({ kind: 'rate_limited' });
    // The paused search lane would hold this for 30 s if the two shared one limiter.
    const lookup = http.fetchJson(`${API.openalex}/works/doi:10.1/x`, { source: 'openalex' });
    await vi.advanceTimersByTimeAsync(600);
    await expect(lookup).resolves.toMatchObject({ data: { id: 'W1' } });
  });

  test('a second search is not sent into the same long 429', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '3600' } }, `${API.openalex}/works`));
    const first = http.fetchJson(`${API.openalex}/works?search=a`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    const second = http.fetchJson(`${API.openalex}/works?search=b`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(await second).toMatchObject({ kind: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a search that gets a short 429 pauses only its lane and then searches again', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(R('', { status: 429, headers: { 'retry-after': '5' } }, `${API.openalex}/works`)));
    const first = http.fetchJson(`${API.openalex}/works?search=a`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(await first).toMatchObject({ kind: 'rate_limited' });
    fetchMock.mockReset();
    respond(JSON.stringify({ id: 'W2' }), JSON_HEADERS);
    const second = http.fetchJson(`${API.openalex}/works?search=b`, { source: 'openalex', lane: 'search' });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(second).resolves.toMatchObject({ data: { id: 'W2' } });
  });
});

describe('content-type matching', () => {
  test.each([
    ['text/html; foo=application/json'],
    ['text/plain-json'],
    ['application/jsonp'],
    ['application/json-seq'],
    ['x-application/json'],
    ['text/html;charset=application/json'],
  ])('%s is not JSON', async (contentType) => {
    respond('{"a":1}', { 'content-type': contentType });
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  test('media types are compared case-insensitively and ignore parameters', async () => {
    respond('{"a":1}', { 'content-type': 'Application/JSON ; charset=UTF-8' });
    await expect(http.fetchJson(`${API.crossref}/works`, { source: 'crossref' })).resolves.toMatchObject({ data: { a: 1 } });
  });

  test('xml, html and pdf are matched on the media type too', async () => {
    respond('<a/>', { 'content-type': 'text/html; x=xml' });
    await expect(http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' })).rejects.toMatchObject({ kind: 'unavailable' });
    respond('<a/>', { 'content-type': 'text/xml; x=html' });
    await expect(http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' })).rejects.toMatchObject({ kind: 'unavailable' });
    respond('%PDF-', { 'content-type': 'text/plain; x=application/pdf' });
    await expect(http.fetchBytes(`${API.arxivSite}/pdf/1`, { source: 'page' })).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('API key redaction hook', () => {
  const KEY = 'sk-live-abcdef123456';

  test('refuses any non-OpenAlex URL that contains the stored key, in any encoding', async () => {
    http.setSecret(KEY);
    for (const url of [
      `${API.crossref}/works?q=${KEY}`,
      `${API.crossref}/works/${encodeURIComponent(KEY)}`,
      `${API.dblp}?q=${encodeURIComponent(encodeURIComponent(KEY))}`,
      `${API.arxivApi}?search_query=x#${KEY}`,
    ]) {
      await expect(http.fetchJson(url, { source: 'crossref' })).rejects.toThrow(/not allowed/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the error never contains the key', async () => {
    http.setSecret(KEY);
    const error = await http.fetchJson(`${API.crossref}/works?q=${KEY}`, { source: 'crossref' }).catch((e: unknown) => e);
    expect(String(error)).not.toContain(KEY);
  });

  test('OpenAlex itself may receive the key', async () => {
    http.setSecret(KEY);
    respondJson({ ok: true });
    await expect(http.fetchJson(`${API.openalex}/works?api_key=${KEY}`, { source: 'openalex' })).resolves.toBeDefined();
  });

  test('the value is trimmed before it is stored, so a pasted key with spaces still protects', async () => {
    http.setSecret(`  ${KEY}\n`);
    await expect(http.fetchJson(`${API.crossref}/works?q=${KEY}`, { source: 'crossref' })).rejects.toThrow(/not allowed/);
    http.setSecret('   ');
    respondJson({ ok: true });
    await expect(http.fetchJson(`${API.crossref}/works?q=${KEY}`, { source: 'crossref' })).resolves.toBeDefined();
    expect(() => http.setSecret('  short  ')).toThrow(RangeError);
  });

  test('clearing the secret stops the check; absurdly short secrets are refused', async () => {
    http.setSecret(KEY);
    http.setSecret(undefined);
    respondJson({ ok: true });
    await expect(http.fetchJson(`${API.crossref}/works?q=${KEY}`, { source: 'crossref' })).resolves.toBeDefined();
    expect(() => http.setSecret('a')).toThrow(RangeError);
    http.setSecret('');
  });
});

// A blocked source must not hold a request in its limiter queue before refusing it.
describe('a blocked request fails before it takes a rate-limit slot', () => {
  test('arXiv blocked: a new request fails at once, with no 3 s wait, unsent and without queueing', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    await http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' }).catch((e: unknown) => e);
    const spy = vi.spyOn(http.limiters.arxiv, 'schedule');
    let settled: unknown;
    const second = http.fetchText(`${API.arxivApi}?id_list=2`, { source: 'arxiv', kind: 'xml' }).then(
      () => 'sent',
      (e: unknown) => (settled = e),
    );
    // No timer is advanced: only promise callbacks run.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toMatchObject({ name: 'SourceError', kind: 'network' });
    await second;
    expect(spy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a request already queued when the block starts is still refused at its turn, unsent', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '3600' } }));
    respondJson({ n: 2 });
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    const queued = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(await queued).toMatchObject({ kind: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// The panel names the source and the time a block ends, so the error says when that is.
describe('a block says when it ends', () => {
  test('the answer that starts the block and every request refused by it carry the same end time', async () => {
    vi.setSystemTime(new Date('2026-10-28T18:42:00Z'));
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    const first = await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    const until = Date.parse('2026-10-28T19:42:00Z');
    expect(first).toMatchObject({ kind: 'network', blockedUntil: until });
    await vi.advanceTimersByTimeAsync(60_000);
    const later = await http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' }).catch((e: unknown) => e);
    expect(later).toMatchObject({ kind: 'network', blockedUntil: until, retryAfterMs: until - Date.now() });
  });

  test('the end is capped at MAX_BLOCK_MS like the block itself', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': String(7 * 86_400) } }));
    const t0 = Date.now();
    const first = await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    expect(first).toMatchObject({ kind: 'rate_limited', blockedUntil: t0 + http.MAX_BLOCK_MS });
  });

  test('a Retry-After short enough to wait for, a failure with none, and a page fetch never carry one', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(R('', { status: 503, headers: { 'retry-after': '5' } })));
    const short = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await short).toMatchObject({ blockedUntil: undefined });
    mockStatus(503);
    const none = http.fetchJson(`${API.openalex}/works/W1`, { source: 'openalex' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await none).toMatchObject({ blockedUntil: undefined });
    mockStatus(503, { 'retry-after': '3600' });
    const page = await http.fetchText(`${API.arxivSite}/html/1`, { source: 'page', kind: 'html' }).catch((e: unknown) => e);
    expect(page).toMatchObject({ kind: 'network', blockedUntil: undefined });
  });
});

// A block is never shortened, and OpenAlex's two lanes share a block of the source.
describe('blocks are kept and shared', () => {
  test('a later, shorter Retry-After keeps the longer block', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    const t0 = Date.now();
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    // Five minutes on, the hour still holds; a request answered meanwhile with a shorter wait cannot cut it either.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const refused = await http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ blockedUntil: t0 + 3_600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a block of OpenAlex reported on an id lookup holds back its searches too', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    await http.fetchJson(`${API.openalex}/works/doi:10.1/x`, { source: 'openalex' }).catch((e: unknown) => e);
    const search = await http.fetchJson(`${API.openalex}/works?search=a`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    expect(search).toMatchObject({ kind: 'network', blockedUntil: expect.any(Number) as number });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a 503 with a long Retry-After on a search holds back the id lookups too; only a 429 on a search keeps to its lane', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    await http.fetchJson(`${API.openalex}/works?search=a`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    const lookup = await http.fetchJson(`${API.openalex}/works/doi:10.1/x`, { source: 'openalex' }).catch((e: unknown) => e);
    expect(lookup).toMatchObject({ kind: 'network', blockedUntil: expect.any(Number) as number });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// While a run sees every required source failing, its lookups go out once each.
describe('a retry rule on the signal', () => {
  test('no retries while the rule says no: one request, the same error', async () => {
    const controller = new AbortController();
    http.setRetryRule(controller.signal, () => false);
    mockStatus(503);
    const p = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref', signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('asked before each retry: retries stop as soon as it says no, and come back when it says yes', async () => {
    const controller = new AbortController();
    let allowed = true;
    http.setRetryRule(controller.signal, () => allowed);
    mockStatus(503);
    const first = http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref', signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100); // the first attempt and its backoff pause
    allowed = false;
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    allowed = true;
    fetchMock.mockClear();
    const second = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref', signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(1 + LIMITS.maxRetries);
  });

  test('a Retry-After is honoured all the same when no retry is made', async () => {
    const controller = new AbortController();
    http.setRetryRule(controller.signal, () => false);
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '5' } }));
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref', signal: controller.signal }).catch((e: unknown) => e);
    respondJson({ n: 2 });
    const next = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(next).resolves.toMatchObject({ data: { n: 2 } });
  });

  test('a signal with no rule, and no signal, retry as before', () => {
    expect(http.retriesAllowed(undefined)).toBe(true);
    expect(http.retriesAllowed(new AbortController().signal)).toBe(true);
  });
});

// The limiters and blocks are module state; tests reset them instead of moving the clock.
describe('resetNetworkStateForTests', () => {
  test('forgets blocks, pauses and lowered rates', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    // A pause on arXiv, and a rate cut to one a minute on OpenReview.
    http.limiters.arxiv.pauseFor(30_000);
    http.limiters.openreview.updateFromHeaders(new Headers({ 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '60s' }));
    http.resetNetworkStateForTests();

    respondJson({ n: 1 });
    respond('<feed/>', { 'content-type': 'application/atom+xml' });
    respondJson({ n: 2 });
    respondJson({ n: 3 });
    const crossref = http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' });
    await vi.advanceTimersByTimeAsync(10);
    await expect(crossref).resolves.toMatchObject({ data: { n: 1 } });
    const arxivFeed = http.fetchText(`${API.arxivApi}?id_list=1`, { source: 'arxiv', kind: 'xml' });
    await vi.advanceTimersByTimeAsync(10);
    await expect(arxivFeed).resolves.toBe('<feed/>');
    const a = http.fetchJson(`${API.openreviewApi}/notes?a=1`, { source: 'openreview' });
    await vi.advanceTimersByTimeAsync(10);
    await a;
    const b = http.fetchJson(`${API.openreviewApi}/notes?a=2`, { source: 'openreview' });
    await vi.advanceTimersByTimeAsync(1000); // OpenReview's own rate is 2 a second, not one a minute
    await expect(b).resolves.toMatchObject({ data: { n: 3 } });
  });

  test('the OpenAlex search lane is reset too', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 429, headers: { 'retry-after': '3600' } }));
    await http.fetchJson(`${API.openalex}/works?search=a`, { source: 'openalex', lane: 'search' }).catch((e: unknown) => e);
    http.resetNetworkStateForTests();
    respondJson({ n: 1 });
    const search = http.fetchJson(`${API.openalex}/works?search=b`, { source: 'openalex', lane: 'search' });
    await vi.advanceTimersByTimeAsync(10);
    await expect(search).resolves.toMatchObject({ data: { n: 1 } });
  });

  test('outside a test run it does nothing: the block stays', async () => {
    fetchMock.mockResolvedValueOnce(R('', { status: 503, headers: { 'retry-after': '3600' } }));
    await http.fetchJson(`${API.crossref}/works?a=1`, { source: 'crossref' }).catch((e: unknown) => e);
    vi.stubEnv('MODE', 'production');
    try {
      http.resetNetworkStateForTests();
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(http.fetchJson(`${API.crossref}/works?a=2`, { source: 'crossref' })).rejects.toMatchObject({ kind: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('no file of the extension other than http.ts names it', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '../../../src');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|js|html)$/.test(f));
    const naming = files.filter((f) => readFileSync(join(root, f), 'utf8').includes('resetNetworkStateForTests'));
    expect(naming).toEqual([join('sources', 'http.ts')]);
  });
});
