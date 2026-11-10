// PDF smoke test. An arXiv abstract page for a paper that has no HTML version: the background fetches the
// PDF, hands it to the real offscreen document, where the shipped pdf.js pair (library + worker) reads the
// reference list, and the references are checked like any other.
//
// This also settles, in real Chrome, that a message from the service worker to the offscreen document carries
// `sender.url`: the offscreen document only answers a sender that states an address inside the extension
// (src/extract/offscreenProtocol.ts, isFromOwnBackground), so a parsed PDF means the address was there.
// The probe at the end reads the same fact directly.
import { PAPER_PDF, expect, panelRows, test, withSession } from './harness';

const ABS = 'https://arxiv.org/abs/2402.03664';
const ABS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>[2402.03664] Partial Gromov-Wasserstein Metric</title></head>
<body><h1>Partial Gromov-Wasserstein Metric</h1><p>Abstract page of a paper that has no HTML version (the e2e harness answers 404 for it).</p></body></html>`;

test('a PDF-only paper is read by the real offscreen document and its references are checked', async () => {
  await withSession(async (s) => {
    s.serve(ABS, { contentType: 'text/html; charset=utf-8', body: ABS_PAGE });
    s.serve('https://arxiv.org/html/2402.03664', { status: 404, contentType: 'text/html', body: '<html><body>No HTML version</body></html>' });
    s.serveFile('https://arxiv.org/pdf/2402.03664', PAPER_PDF, 'application/pdf');

    const paper = await s.openPaper(ABS);
    const panel = await s.openPanel(paper);
    await s.runCheck(panel);

    // The PDF was fetched through the allowlisted address, the HTML was asked for first.
    const fetched = s.seen.filter((r) => r.fromWorker).map((r) => r.url);
    expect(fetched).toContain('https://arxiv.org/html/2402.03664');
    expect(fetched).toContain('https://arxiv.org/pdf/2402.03664');

    // The references came out of the PDF: all 71 are there, and the paper is marked Beta (PDF-derived).
    const rows = await panelRows(panel);
    expect(rows).toHaveLength(71);
    await expect(panel.locator('.beta .pill')).toHaveText('Beta');
    await expect(panel.locator('.beta .help')).toContainText('misread');
    // No inline badges or "Show on page" on a PDF-derived check.
    await expect(panel.getByRole('button', { name: /Show on page/ })).toHaveCount(0);
    // Real results: most references verify against the fake services.
    expect(rows.filter((r) => r.status === 'verified').length).toBeGreaterThan(20);

    // The document that did the reading is a real offscreen document of the extension.
    const contexts = await s.sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    expect(contexts.map((c) => c.documentUrl)).toEqual([`chrome-extension://${s.extensionId}/offscreen.html`]);

    // The sender.url fact, read directly: broadcasts from the service worker reach every extension page, the
    // probe in the panel page saw them, and each carried the service worker's own address.
    const senders = await panel.evaluate(() => (window as unknown as { __senders: { id?: string; url?: string; hasTab: boolean }[] }).__senders);
    expect(senders.length).toBeGreaterThan(0);
    for (const sender of senders) {
      expect(sender.id).toBe(s.extensionId);
      expect(sender.url).toBe(`chrome-extension://${s.extensionId}/background.js`);
      expect(sender.hasTab).toBe(false);
    }
    expect(s.leaks).toEqual([]);
  });
});
