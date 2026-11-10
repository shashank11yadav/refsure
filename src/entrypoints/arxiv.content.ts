import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { extractArxivReferences } from '../extract/arxivHtml';
import { squashSpace } from '../extract/domText';
import { detectPage } from '../extract/pageDetect';
import { isBackgroundToContent, isPanelToContent, type ContentToBackground } from '../messaging';
import { clearBadges, scrollToRef, setReferenceItems, showBadges } from '../ui/badge';

const MAX_TITLE_CHARS = 1000;

function send(message: ContentToBackground): void {
  // Nobody listening (the background is starting up) is not an error worth surfacing on a paper page.
  try {
    void Promise.resolve(browser.runtime.sendMessage(message)).catch(() => undefined);
  } catch {
    /* extension context gone (updated or removed): nothing to tell */
  }
}

/** The paper's title as the page shows it: the document heading, else the tab title. */
function pageTitle(): string | undefined {
  const heading = document.querySelector('h1.ltx_title_document');
  const title = squashSpace(heading?.textContent ?? '') || squashSpace(document.title);
  return title === '' ? undefined : title.slice(0, MAX_TITLE_CHARS);
}

/** Which `li` each reference number sits in: by the id the extractor carried along, else by position. */
function referenceItems(refs: ReturnType<typeof extractArxivReferences>): Map<number, HTMLElement> {
  const map = new Map<number, HTMLElement>();
  const all = Array.from(document.querySelectorAll<HTMLElement>('li.ltx_bibitem'));
  for (const ref of refs) {
    const byId = ref.anchorId === undefined ? null : document.getElementById(ref.anchorId);
    const item = byId?.matches('li.ltx_bibitem') ? byId : all.length === refs.length ? all[ref.index - 1] : undefined;
    if (item !== undefined && item !== null) map.set(ref.index, item);
  }
  return map;
}

// Reads the paper's references when the background asks and marks each with a small badge. It sends
// only "ready" and "leaving" by itself (never the references), answers only our own background and
// panel, and listens to no window.postMessage. Badges are drawn only for this page's own paper.
export default defineContentScript({
  matches: ['https://arxiv.org/html/*'],
  runAt: 'document_idle',
  allFrames: false,
  // WXT otherwise posts a message carrying the extension id to the page's own scripts on every load.
  noScriptStartedPostMessage: true,
  main() {
    const page = detectPage(document.URL);
    const paperKey = page.kind === 'arxiv-html' ? page.paperKey : undefined;
    if (paperKey === undefined) return;

    browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      // From this extension and not from a tab: our background or our panel. A web page or another
      // content script always has a tab, and another extension has another id.
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return false;

      if (isPanelToContent(message)) {
        scrollToRef(message.index);
        return false;
      }
      if (!isBackgroundToContent(message)) return false;
      switch (message.type) {
        case 'refs:extract': {
          const refs = extractArxivReferences(document);
          setReferenceItems(referenceItems(refs));
          const title = pageTitle();
          sendResponse({ refs, ...(title !== undefined && { title }) });
          return false;
        }
        case 'badges:update':
          // A late message for a paper this tab no longer shows must not paint onto this one.
          if (message.paperKey === paperKey) showBadges(message.results, (index) => send({ type: 'badge:clicked', index }));
          return false;
        case 'badges:clear':
          clearBadges();
          return false;
        default:
          return false;
      }
    });

    // Only the browser's own page events count: a script on the page can dispatch these itself, and
    // would end the reader's running check (pagehide) or ask for a new one (pageshow).
    window.addEventListener('pagehide', (event) => {
      if (!event.isTrusted) return;
      // A page entering the back/forward cache comes back whole, badges and all, but its run has been
      // ended below: what it shows would be stale (and unowned), so it goes into the cache clean.
      if (event.persisted) clearBadges();
      send({ type: 'page:leaving', paperKey });
    });
    // Coming back out of the cache is not a load, so nothing else announces the page again. It counts as
    // a (re)load: the background may check it if auto-check is on, like any other visit.
    window.addEventListener('pageshow', (event) => {
      if (event.isTrusted && event.persisted) send({ type: 'content:ready', paperKey });
    });
    send({ type: 'content:ready', paperKey });
  },
});
