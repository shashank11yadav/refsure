// A page script cannot open the side panel through a badge. Real Chromium with the built extension; every sidePanel.open call is recorded.
import { PAPER_HTML, expect, readBadges, test, withSession } from './harness';

const PAPER = 'https://arxiv.org/html/2402.03664v5';

interface Opened {
  ok: boolean;
  error?: string;
}

test('page scripts cannot open the panel through a badge; page CSS that steers a real click onto one only opens the panel', async () => {
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    const paper = await s.openPaper(PAPER);
    const panel = await s.openPanel(paper);
    await s.runCheck(panel);
    await expect.poll(async () => (await readBadges(paper.page)).length).toBe(s.world.total);

    await s.sw.evaluate(() => {
      const g = globalThis as unknown as { __opened: Opened[]; __badgeMsgs: number; browser?: { sidePanel?: E2eSidePanel } };
      g.__opened = [];
      for (const api of new Set([chrome.sidePanel, g.browser?.sidePanel].filter((a) => a !== undefined))) {
        const real = api.open.bind(api);
        api.open = (options: { tabId: number }) => {
          const pending = real(options);
          pending.then(
            () => g.__opened.push({ ok: true }),
            (error: unknown) => g.__opened.push({ ok: false, error: String(error) }),
          );
          return pending;
        };
      }
    });
    const opened = (): Promise<Opened[]> => s.sw.evaluate(() => (globalThis as unknown as { __opened: Opened[] }).__opened);

    // 1. Synthetic events from the page's own script (main world).
    const pageSide = await paper.page.evaluate(async (extId) => {
      const hosts = [...document.querySelectorAll('refsure-badge')] as HTMLElement[];
      const out: Record<string, unknown> = { hosts: hosts.length, shadowRoot: hosts[0]?.shadowRoot === null ? 'null' : 'exposed' };
      const host = hosts[0];
      if (host !== undefined) {
        host.click();
        host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
        host.focus();
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
        host.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }));
        const r = host.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out['hit'] = hit?.tagName;
        hit?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: r.left + 2, clientY: r.top + 2 }));
      }
      const rt = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime;
      out['runtimeSendMessage'] = typeof rt?.sendMessage;
      try {
        if (typeof rt?.sendMessage === 'function') {
          await (rt.sendMessage as (id: string, m: unknown) => Promise<unknown>)(extId, { type: 'badge:clicked', index: 1 });
          out['forged'] = 'sent';
        }
      } catch (e) {
        out['forged'] = String(e);
      }
      window.postMessage({ type: 'badge:clicked', index: 1 }, '*');
      return out;
    }, s.extensionId);
    await paper.page.waitForTimeout(1000);
    const afterSynthetic = await opened();
    expect(afterSynthetic).toEqual([]);

    expect(pageSide['shadowRoot']).toBe('null');

    // 2. The residual risk (SECURITY.md section 5): a hostile stylesheet stretches one badge, invisibly, over the whole
    //    page, so the reader's next click anywhere lands on it. That is a trusted click on a badge of a run that drew
    //    badges, so the panel opens; nothing else happens: no check starts and no lookup is sent.
    const lookupsBefore = s.lookups.length;
    await paper.page.addStyleTag({
      content: 'refsure-badge:first-of-type{position:fixed!important;left:50vw;top:50vh;transform:scale(400);opacity:0.001;z-index:2147483647}',
    });
    await paper.page.mouse.click(40, 40);
    await paper.page.waitForTimeout(1000);
    const afterClickjack = await opened();
    expect(afterClickjack.length).toBeLessThanOrEqual(1);
    expect(s.lookups.length).toBe(lookupsBefore);
    await expect(panel.getByRole('button', { name: 'Re-check' })).toBeVisible();
    expect(s.leaks).toEqual([]);
  });
});

