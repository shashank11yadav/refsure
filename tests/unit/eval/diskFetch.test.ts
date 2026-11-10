import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { installDiskFetch } from '../../../scripts/eval/diskFetch';

describe('the evaluation\'s disk-cached fetch', () => {
  const original = globalThis.fetch;
  let dir: string;
  let network: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'refsure-diskfetch-'));
    network = vi.fn((url: string) => Promise.resolve(Object.defineProperty(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), 'url', { value: url })));
    globalThis.fetch = network as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  });

  test('the second ask is answered from disk, with a usable final address', async () => {
    const disk = installDiskFetch({ dir, offline: false });
    const first = await fetch('https://api.openalex.org/works?search=x');
    const second = await fetch('https://api.openalex.org/works?search=x');
    expect(network).toHaveBeenCalledTimes(1);
    expect(second.url).toBe('https://api.openalex.org/works?search=x');
    expect(await second.json()).toEqual({ ok: true });
    expect(await first.json()).toEqual({ ok: true });
    // The body is stored decoded, so the transport headers are left out.
    expect(second.headers.get('content-encoding')).toBeNull();
    expect(disk.take()).toMatchObject({ live: 1, cached: 1 });
  });

  test('Crossref goes out without the placeholder contact address, and the cache ignores it', async () => {
    installDiskFetch({ dir, offline: false });
    await fetch('https://api.crossref.org/works?query.bibliographic=a&mailto=refsure-contact%40example.invalid');
    await fetch('https://api.crossref.org/works?query.bibliographic=a&mailto=somebody%40example.org');
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]?.[0])).not.toContain('mailto');
  });

  test('a contact address from the environment replaces it', async () => {
    installDiskFetch({ dir, offline: false, contactEmail: 'me@example.org' });
    await fetch('https://api.crossref.org/works?query.bibliographic=a&mailto=refsure-contact%40example.invalid');
    expect(String(network.mock.calls[0]?.[0])).toContain('mailto=me%40example.org');
  });

  test('a rate-limit or server error is answered but never kept', async () => {
    network.mockImplementation((url: string) => Promise.resolve(Object.defineProperty(new Response('slow down', { status: 429 }), 'url', { value: url })));
    installDiskFetch({ dir, offline: false });
    expect((await fetch('https://api.openalex.org/works?search=y')).status).toBe(429);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('only a live answer carries rate-limit and budget headers; the same answer replayed from disk does not', async () => {
    const limits = {
      'content-type': 'application/json',
      'x-ratelimit-remaining-usd': '0',
      'x-ratelimit-cost-usd': '0.001',
      'x-ratelimit-reset': '14538',
      'x-rate-limit-limit': '5',
      'x-rate-limit-interval': '1s',
      'retry-after': '3600',
    };
    network.mockImplementation((url: string) => Promise.resolve(Object.defineProperty(new Response('{"results":[]}', { status: 200, headers: limits }), 'url', { value: url })));
    installDiskFetch({ dir, offline: false });
    const live = await fetch('https://api.openalex.org/works?search=spent');
    expect(live.headers.get('x-ratelimit-remaining-usd')).toBe('0');
    expect(live.headers.get('x-rate-limit-limit')).toBe('5');

    for (const offline of [false, true]) {
      installDiskFetch({ dir, offline });
      const replayed = await fetch('https://api.openalex.org/works?search=spent');
      expect(network).toHaveBeenCalledTimes(1);
      expect(replayed.status).toBe(200);
      expect(replayed.headers.get('content-type')).toBe('application/json');
      expect(await replayed.json()).toEqual({ results: [] });
      for (const name of Object.keys(limits).filter((n) => n !== 'content-type')) expect(replayed.headers.get(name)).toBeNull();
    }
  });

  test('offline, a miss is answered as a refusal and nothing is sent', async () => {
    const disk = installDiskFetch({ dir, offline: true });
    const response = await fetch('https://api.openalex.org/works?search=z');
    expect(response.status).toBe(403);
    expect(response.url).toBe('https://api.openalex.org/works?search=z');
    expect(network).not.toHaveBeenCalled();
    expect(disk.take().misses).toBe(1);
  });
});
