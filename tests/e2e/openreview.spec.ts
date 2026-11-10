// OpenReview forum pages: hand-made fixtures, and real pages saved from a browser (the site itself cannot
// be fetched by a script, it sits behind a bot check).
// A confidential or unclear page is not checked, and nothing at all leaves for any lookup service.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, PAGES, test, withSession } from './harness';

const CONFIDENTIAL = 'https://openreview.net/forum?id=conf456ABC';
const UNCLEAR = 'https://openreview.net/forum?id=unclear789';
const PUBLIC = 'https://openreview.net/forum?id=abc123XYZ';

test('a confidential submission shows the banner and makes no lookup request', async () => {
  await withSession(async (s) => {
    s.serveFile(CONFIDENTIAL, join(PAGES, 'openreview-confidential.handmade.html'), 'text/html; charset=utf-8');
    const paper = await s.openPaper(CONFIDENTIAL);
    const panel = await s.openPanel(paper);
    await panel.getByRole('button', { name: 'Check references' }).click();

    await expect(panel.locator('.banner')).toContainText("This submission isn't public");
    await expect(panel.locator('.banner')).toContainText('Nothing was sent anywhere.');
    expect(await panel.locator('li.row').count()).toBe(0);
    await expect(panel.getByRole('button', { name: 'Copy report' })).toHaveCount(0);

    // Nothing was sent anywhere: no lookup service was contacted, and the only request that reached an
    // allowlisted site was for the page itself (plus whatever that page loads).
    expect(s.lookups).toEqual([]);
    expect(s.api.requests).toEqual([]);
    expect(s.seen.filter((r) => r.fromWorker)).toEqual([]);
    expect(s.leaks).toEqual([]);
    // The title of a confidential paper appears in no request address.
    expect(s.seen.some((r) => r.url.includes('Handmade') || r.url.includes('Confidential'))).toBe(false);
  });
});

test('a page whose visibility is unclear is not checked either, and nothing is sent', async () => {
  await withSession(async (s) => {
    s.serveFile(UNCLEAR, join(PAGES, 'openreview-nodata.handmade.html'), 'text/html; charset=utf-8');
    const paper = await s.openPaper(UNCLEAR);
    const panel = await s.openPanel(paper);
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect(panel.locator('.banner')).toContainText("couldn't confirm this paper is public");
    expect(s.lookups).toEqual([]);
    expect(s.leaks).toEqual([]);
  });
});

test('a public page sends only a title search to arXiv, then says it has no arXiv version to read', async () => {
  await withSession(async (s) => {
    s.serveFile(PUBLIC, join(PAGES, 'openreview-public.handmade.html'), 'text/html; charset=utf-8');
    const paper = await s.openPaper(PUBLIC);
    const panel = await s.openPanel(paper);
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect(panel.locator('.banner')).toContainText("doesn't have one it can find yet");
    // The fake arXiv has no such paper. The one lookup that was made is the title search and nothing else.
    expect(s.lookups).toHaveLength(1);
    const [lookup] = s.lookups;
    expect(new URL(lookup?.url ?? '').hostname).toBe('export.arxiv.org');
    expect(decodeURIComponent(lookup?.url ?? '')).toContain('A Handmade Public Paper'.toLowerCase());
    expect(s.leaks).toEqual([]);
  });
});

// Real forum pages saved from a browser and trimmed (tests/fixtures/pages/README.md): their inline
// data scripts run in the tab as they would on the site, and the content script reads the page as it is.
const REAL_PAGES = [
  ['legacy layout', 'YicbFdNTTy', 'openreview-iclr2021-legacy-forum.html', 'image is worth 16x16 words'],
  ['newer layout', 'imT03YXlG2', 'openreview-iclr2025-forum.html', 'sparse autoencoders reveal selective remapping'],
  ['newer layout, loaded directly', 'odjMSBSWRt', 'openreview-iclr2025-forum-hard-load.html', 'darkbench'],
] as const;

for (const [layout, id, file, titleWords] of REAL_PAGES) {
  test(`a real public forum page (${layout}) is read as public and its title searched on arXiv`, async () => {
    await withSession(async (s) => {
      const url = `https://openreview.net/forum?id=${id}`;
      s.serveFile(url, join(PAGES, file), 'text/html; charset=utf-8');
      const paper = await s.openPaper(url);
      const panel = await s.openPanel(paper);
      await panel.getByRole('button', { name: 'Check references' }).click();
      await expect(panel.locator('.banner')).toContainText("doesn't have one it can find yet");
      expect(s.lookups).toHaveLength(1);
      const [lookup] = s.lookups;
      expect(new URL(lookup?.url ?? '').hostname).toBe('export.arxiv.org');
      expect(decodeURIComponent(lookup?.url ?? '').toLowerCase()).toContain(titleWords);
      expect(s.leaks).toEqual([]);
    });
  });
}

test('the newer-layout page with a restricted header label is not checked, and nothing is sent', async () => {
  await withSession(async (s) => {
    const url = 'https://openreview.net/forum?id=imT03YXlG2';
    const page = readFileSync(join(PAGES, 'openreview-iclr2025-forum.html'), 'utf8');
    // Only the forum note's own readers item is followed by another meta item.
    const label = '</span>Everyone</span><span class="item">';
    expect(page.split(label)).toHaveLength(2);
    const restricted = page.replace(label, '</span>Program Chairs, Submission14240 Authors</span><span class="item">');
    s.serve(url, { contentType: 'text/html; charset=utf-8', body: restricted });
    const paper = await s.openPaper(url);
    const panel = await s.openPanel(paper);
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect(panel.locator('.banner')).toContainText("This submission isn't public");
    expect(s.lookups).toEqual([]);
    expect(s.api.requests).toEqual([]);
    expect(s.leaks).toEqual([]);
    expect(s.seen.some((r) => r.url.toLowerCase().includes('sparse'))).toBe(false);
  });
});
