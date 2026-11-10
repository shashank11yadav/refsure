import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { readOpenReviewPage } from '../extract/openreviewPage';
import { isBackgroundToContent } from '../messaging';

// Reads the open OpenReview forum page when the background asks, and does nothing else: it never
// sends anything on its own (no auto-send), never touches the page, and answers only our own
// background. What it reads is two facts, the title and who may read the paper, and the title is
// only handed back for a paper the page shows as public (see readOpenReviewPage).
export default defineContentScript({
  matches: ['https://openreview.net/forum*'],
  // WXT otherwise posts a message carrying the extension id to the page's own scripts on every load.
  noScriptStartedPostMessage: true,
  main() {
    browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      // From this extension and not from a tab: our background (or a page of ours). A sender address is not
      // required, because tabs.sendMessage from the background does not always carry one; a web page or
      // another content script always has a tab, and another extension has another id.
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return false;
      if (!isBackgroundToContent(message) || message.type !== 'openreview:read') return false;
      sendResponse(readOpenReviewPage(document));
      return false;
    });
  },
});
