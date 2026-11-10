// The end-to-end harness: real Chromium, the built extension loaded from `.output/chrome-mv3`, pages served from
// tests/fixtures, lookup APIs answered by FakeApi, and a catch-all that records (and refuses) everything else.
//
// What cannot be done headless, and what is done instead (the same in every spec):
//  * The toolbar button cannot be clicked, and the real side panel cannot be opened (both need a user gesture
//    on browser chrome). The side panel page itself, `chrome-extension://<id>/sidepanel.html`, is opened as an
//    ordinary tab and its own "Check references" button is pressed; that sends the same `check:start` message
//    the toolbar click leads to.
//  * A panel opened as a tab would see itself as the active tab and has a `sender.tab` the real side panel does
//    not have. So, in that page only, `tabs.query` is answered with the paper's tab and `tabs.sendMessage` is
//    relayed through the service worker (whose messages carry no tab, like the real panel's). Everything else in
//    the page, the background and the content scripts is the shipped code.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test as base, type BrowserContext, type CDPSession, type Page, type Request, type Route, type Worker } from '@playwright/test';
import { HOST_PERMISSION_ORIGINS as ALLOWED_ORIGINS } from '../../src/config';
import { buildWorld, FakeApi, type World } from './fakeApi';

export const ROOT = resolve(import.meta.dirname, '../..');
export const EXTENSION_DIR = join(ROOT, '.output/chrome-mv3');
export const PAGES = join(ROOT, 'tests/fixtures/pages');
export const PAPER_HTML = join(PAGES, 'arxiv-2402.03664v5.html');
export const PAPER_PDF = join(PAGES, 'arxiv-2402.03664v5-numeric.pdf');

export interface Served {
  status?: number;
  contentType: string;
  body: string | Buffer;
}

export interface Seen {
  url: string;
  method: string;
  resourceType: string;
  /** Made by a worker (the extension's service worker), not by a page. */
  fromWorker: boolean;
  outcome: 'served' | 'api' | 'asset' | 'blocked';
}

const ASSET_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'manifest', 'other', 'texttrack']);
const ALLOWED = new Set(ALLOWED_ORIGINS);

function fromWorker(request: Request): boolean {
  try {
    request.frame();
    return false;
  } catch {
    return true;
  }
}

export class Session {
  readonly seen: Seen[] = [];
  readonly served = new Map<string, Served>();
  /** Requests for allowlisted pages nobody served (fixture pages' own CSS and scripts on arXiv). */
  readonly missing: string[] = [];

  private constructor(
    readonly ctx: BrowserContext,
    readonly sw: Worker,
    readonly extensionId: string,
    readonly world: World,
    readonly api: FakeApi,
    private readonly profile: string,
  ) {}

  static async launch(options: { world?: World; reducedMotion?: boolean } = {}): Promise<Session> {
    const profile = mkdtempSync(join(tmpdir(), 'refsure-e2e-'));
    const ctx = await chromium.launchPersistentContext(profile, {
      // `chromium` (not "chrome"): the new headless mode, the one that can load extensions.
      channel: 'chromium',
      headless: true,
      viewport: { width: 1100, height: 800 },
      ...(options.reducedMotion === true && { reducedMotion: 'reduce' as const }),
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    const world = options.world ?? buildWorld(PAPER_HTML);
    let sw = ctx.serviceWorkers()[0];
    sw ??= await ctx.waitForEvent('serviceworker');
    const extensionId = new URL(sw.url()).host;
    const session = new Session(ctx, sw, extensionId, world, new FakeApi(world), profile);
    await ctx.route('**/*', (route) => void session.handle(route));
    // The first-run welcome tab opens by itself on install; the tests do not use it.
    for (const page of ctx.pages()) if (page.url().includes('welcome.html')) await page.close();
    ctx.on('page', (page) => {
      if (page.url().includes('welcome.html')) void page.close();
    });
    return session;
  }

  async close(): Promise<void> {
    await this.ctx.close();
    rmSync(this.profile, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------- network

  /** Serves `body` for exactly this address (the query string counts, the fragment does not). */
  serve(url: string, served: Served): void {
    this.served.set(new URL(url).href.replace(/#.*$/, ''), served);
  }

  serveFile(url: string, path: string, contentType: string): void {
    this.serve(url, { contentType, body: readFileSync(path) });
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:') return void (await route.continue());
    const base: Omit<Seen, 'outcome'> = { url: request.url(), method: request.method(), resourceType: request.resourceType(), fromWorker: fromWorker(request) };

    if (!ALLOWED.has(url.origin)) {
      const page = !base.fromWorker && ASSET_TYPES.has(base.resourceType);
      this.seen.push({ ...base, outcome: page ? 'asset' : 'blocked' });
      return void (await route.abort('blockedbyclient'));
    }
    const served = this.served.get(url.href.replace(/#.*$/, ''));
    if (served !== undefined) {
      this.seen.push({ ...base, outcome: 'served' });
      return void (await route.fulfill({ status: served.status ?? 200, contentType: served.contentType, body: served.body }));
    }
    const reply = await this.api.respond(url);
    if (reply !== undefined) {
      this.seen.push({ ...base, outcome: 'api' });
      return void (await route.fulfill({ status: reply.status, contentType: reply.contentType, body: reply.body, ...(reply.headers !== undefined && { headers: reply.headers }) }));
    }
    // An allowlisted page that was not served: the paper's own CSS, scripts and images. Not found.
    this.missing.push(request.url());
    this.seen.push({ ...base, outcome: 'asset' });
    return void (await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not served by the e2e harness' }));
  }

  /**
   * Requests that left (or tried to leave) for a host outside the allowlist, made by the extension or as
   * anything but a paper page's own stylesheet, script, image or font. Must always be empty.
   */
  get leaks(): Seen[] {
    return this.seen.filter((s) => s.outcome === 'blocked');
  }

  /** Requests to a lookup service. */
  get lookups(): Seen[] {
    return this.seen.filter((s) => s.outcome === 'api');
  }

  // ---------------------------------------------------------------------------- pages and the panel

  /** Opens a paper page (it must have been `serve`d first) and returns it with its tab id. */
  async openPaper(url: string): Promise<{ page: Page; tabId: number }> {
    const page = await this.ctx.newPage();
    await page.goto(url);
    return { page, tabId: await this.tabIdOf(page) };
  }

  async tabIdOf(page: Page): Promise<number> {
    const url = page.url();
    const id = await this.sw.evaluate(async (wanted) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === wanted)?.id;
    }, url);
    if (id === undefined) throw new Error(`no tab shows ${url}`);
    return id;
  }

  /**
   * The real side panel page, in an ordinary tab, looking at `target`'s tab. See the notes at the top of the file.
   * Everything the page learns about senders of broadcast messages is kept in `window.__senders`.
   */
  async openPanel(target: { tabId: number }): Promise<Page> {
    const panel = await this.ctx.newPage();
    await panel.exposeFunction('__refsureActiveTab', async () => {
      return this.sw.evaluate(async (id) => {
        try {
          const tab = await chrome.tabs.get(id);
          return { id: tab.id, url: tab.url, title: tab.title, active: true };
        } catch {
          return undefined;
        }
      }, target.tabId);
    });
    await panel.exposeFunction('__refsureRelay', async (tabId: number, message: unknown) => {
      return this.sw.evaluate(([id, msg]) => chrome.tabs.sendMessage(id as number, msg, { frameId: 0 }), [tabId, message] as const);
    });
    await panel.addInitScript(() => {
      const w = window as unknown as { __refsureActiveTab(): Promise<unknown>; __refsureRelay(tabId: number, message: unknown): Promise<unknown>; __senders: unknown[] };
      w.__senders = [];
      (chrome.tabs as { query: unknown }).query = async () => {
        const tab = await w.__refsureActiveTab();
        return tab === undefined ? [] : [tab];
      };
      (chrome.tabs as { sendMessage: unknown }).sendMessage = (tabId: number, message: unknown) => w.__refsureRelay(tabId, message);
      // Only watches who sends broadcasts to extension pages; it never answers.
      chrome.runtime.onMessage.addListener((_message, sender) => {
        w.__senders.push({ id: sender.id, url: sender.url, hasTab: sender.tab !== undefined });
        return false;
      });
    });
    await panel.goto(`chrome-extension://${this.extensionId}/sidepanel.html`);
    return panel;
  }

  /** Runs a check from the panel and waits until it is over. */
  async runCheck(panel: Page): Promise<void> {
    await panel.getByRole('button', { name: 'Check references' }).click();
    await expect(panel.getByRole('button', { name: 'Export JSON' })).toBeVisible({ timeout: 60_000 });
  }

  /** Tells the panel to look at the active tab again, like switching back to it. */
  async refreshPanel(panel: Page): Promise<void> {
    await panel.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  }
}

// ---------------------------------------------------------------------------- reading the page

/** A badge on the paper page: which reference (by its `li` id) and the status inside its closed shadow root. */
export interface PageBadge {
  bibId: string;
  status: string;
  highlighted: boolean;
}

interface CdpNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

function attr(node: CdpNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

function findWrap(node: CdpNode): CdpNode | undefined {
  if (attr(node, 'class') === 'wrap') return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findWrap(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The badges the content script drew. Their shadow roots are closed (on purpose, SECURITY.md section 4), so the
 * page itself cannot read them; the DevTools protocol can, which is how a test sees what a user sees.
 */
export async function readBadges(page: Page): Promise<PageBadge[]> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    const out: PageBadge[] = [];
    const walk = (node: CdpNode, bibId: string | undefined): void => {
      const own = node.nodeName === 'LI' && (attr(node, 'class') ?? '').includes('ltx_bibitem') ? (attr(node, 'id') ?? bibId) : bibId;
      if (node.nodeName === 'REFSURE-BADGE') {
        const wrap = (node.shadowRoots ?? []).map(findWrap).find((w) => w !== undefined);
        out.push({ bibId: own ?? '', status: wrap === undefined ? '' : (attr(wrap, 'data-status') ?? ''), highlighted: wrap !== undefined && attr(wrap, 'data-highlight') !== undefined });
        return;
      }
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child, own);
    };
    walk(root, undefined);
    return out;
  } finally {
    await cdp.detach();
  }
}

function findByClass(node: CdpNode, name: string): CdpNode | undefined {
  if (attr(node, 'class') === name) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findByClass(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Moves the pointer over each badge in turn (the first `limit`, spread over the whole list) and returns where its
 * popover then sits, as horizontal page-viewport coordinates. The popover is inside a closed root, so its box
 * comes from the DevTools protocol.
 */
export async function hoverBadgePopovers(page: Page, limit = 40): Promise<{ left: number; right: number }[]> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    const hosts: CdpNode[] = [];
    const walk = (node: CdpNode): void => {
      if (node.nodeName === 'REFSURE-BADGE') return void hosts.push(node);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };
    walk(root);
    const step = Math.max(1, Math.floor(hosts.length / limit));
    const boxes: { left: number; right: number }[] = [];
    for (let i = 0; i < hosts.length; i += step) {
      const wrap = (hosts[i]?.shadowRoots ?? []).map(findWrap).find((w) => w !== undefined);
      const tip = wrap === undefined ? undefined : findByClass(wrap, 'tip');
      const button = wrap?.children?.find((c) => c.nodeName === 'BUTTON');
      if (tip === undefined || button === undefined) continue;
      // Off the last popover first, as a reader does: the pointer can rest on a popover, which keeps it open and may
      // cover the next badge.
      await page.mouse.move(0, 0);
      await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId: button.nodeId });
      const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId })) as { model: { content: number[] } };
      const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
      await page.mouse.move((x1 + x3) / 2, (y1 + y3) / 2);
      const shown = (await cdp.send('DOM.getBoxModel', { nodeId: tip.nodeId })) as { model: { content: number[] } };
      const xs = [0, 2, 4, 6].map((k) => shown.model.content[k] ?? 0);
      boxes.push({ left: Math.min(...xs), right: Math.max(...xs) });
    }
    await page.mouse.move(0, 0);
    return boxes;
  } finally {
    await cdp.detach();
  }
}

/**
 * Clicks the badge of the `n`-th reference that has one (0-based) the way a person does: a real mouse click at the
 * badge's place on screen, so the page sees a trusted click with a user gesture. The box comes from the DevTools
 * protocol, since the badge sits in a closed shadow root.
 */
export async function clickBadge(page: Page, n: number): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    const hosts: CdpNode[] = [];
    const walk = (node: CdpNode): void => {
      if (node.nodeName === 'REFSURE-BADGE') return void hosts.push(node);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };
    walk(root);
    const wrap = (hosts[n]?.shadowRoots ?? []).map(findWrap).find((w) => w !== undefined);
    const button = wrap?.children?.find((c) => c.nodeName === 'BUTTON');
    if (button === undefined) throw new Error(`no badge button for reference ${String(n)}`);
    await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId: button.nodeId });
    const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId })) as { model: { content: number[] } };
    const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
    await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  } finally {
    await cdp.detach();
  }
}

/** What the panel shows, row by row. */
export async function panelRows(panel: Page): Promise<{ index: number; status: string }[]> {
  return panel.$$eval('li.row', (rows) => rows.map((row) => ({ index: Number(row.getAttribute('data-index')), status: row.getAttribute('data-status') ?? '' })));
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** Runs `body` with a fresh browser profile and always closes it. */
export async function withSession<T>(body: (session: Session) => Promise<T>, options: Parameters<typeof Session.launch>[0] = {}): Promise<T> {
  const session = await Session.launch(options);
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

export { base as test, expect };
