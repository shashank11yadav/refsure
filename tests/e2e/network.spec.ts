// The network guard itself: the catch-all route that every other spec relies on ("no request leaves to a host
// outside the allowlist") really records and refuses what it should, and the extension's own CSP stops the
// extension before a request is even made.
import { PAPER_HTML, expect, test, withSession } from './harness';

const PAPER = 'https://arxiv.org/html/2402.03664v5';

test('the catch-all records and refuses a request to a host outside the allowlist', async () => {
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    const paper = await s.openPaper(PAPER);
    expect(s.leaks).toEqual([]);

    // A fetch from a page (not the extension) to an unlisted host is caught, recorded and refused.
    const outcome = await paper.page.evaluate(() => fetch('https://tracker.invalid/collect').then(() => 'reached', () => 'refused'));
    expect(outcome).toBe('refused');
    expect(s.leaks.map((l) => new URL(l.url).hostname)).toEqual(['tracker.invalid']);
  });
});

test('the extension itself cannot reach a host outside the allowlist (its CSP stops it first)', async () => {
  await withSession(async (s) => {
    const outcome = await s.sw.evaluate(() => fetch('https://tracker.invalid/collect').then(() => 'reached', (e: unknown) => String(e)));
    expect(outcome).toContain('Failed to fetch');
    // Refused by the browser before routing: not even a blocked request was made.
    expect(s.seen.filter((r) => r.url.includes('tracker.invalid'))).toEqual([]);
  });
});
