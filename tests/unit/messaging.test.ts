import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: { runtime: { id: 'ext-id', getURL: (path: string) => `chrome-extension://ext-id${path}` } },
}));

import type { CheckResult, CheckSummary, PaperInfo } from '../../src/core/types';
import { arxivUrl, doiUrl, openreviewUrl } from '../../src/core/identifiers';
import {
  contentSite,
  isBackgroundReply,
  isBackgroundToContent,
  isBackgroundToPanel,
  isCheckResult,
  isContentToBackground,
  isExtensionPage,
  isSidePanelPage,
  isOpenReviewReadReply,
  isPanelToBackground,
  isPanelToContent,
  isRefsExtractReply,
  isTrustedSender,
  PANEL_PORT_NAME,
} from '../../src/messaging';

const paper: PaperInfo = { key: 'arxiv:1706.03762', title: 'Attention', url: 'https://arxiv.org/abs/1706.03762', origin: 'arxiv-abs', viaPdf: false };
const result: CheckResult = {
  index: 1,
  label: '[1]',
  citedText: 'A. Author. Title. 2019.',
  status: 'verified',
  reason: 'Matched in Crossref',
  diffs: [],
  notes: [],
  sourcesSearched: ['crossref'],
  sourcesFailed: [],
  links: [{ label: 'Open matched paper', url: 'https://doi.org/10.1000/x' }],
};
const summary: CheckSummary = {
  paper,
  counts: { verified: 1, details_differ: 0, wrong_id: 0, retracted: 0, not_found: 0, cant_check: 0 },
  total: 1,
  startedAt: 1,
  finishedAt: 2,
  beta: false,
};

describe('port name', () => {
  test('is refsure-panel', () => expect(PANEL_PORT_NAME).toBe('refsure-panel'));
});

describe('isPanelToBackground', () => {
  test('accepts the four panel messages', () => {
    expect(isPanelToBackground({ type: 'check:start', tabId: 3 })).toBe(true);
    expect(isPanelToBackground({ type: 'check:cancel', tabId: 3 })).toBe(true);
    expect(isPanelToBackground({ type: 'history:get', paperKey: 'arxiv:1706.03762' })).toBe(true);
    expect(isPanelToBackground({ type: 'history:clear' })).toBe(true);
  });

  test('rejects unknown types, non-objects and wrong field types', () => {
    for (const bad of [
      null,
      undefined,
      'check:start',
      42,
      [],
      {},
      { type: 'check:go', tabId: 1 },
      { type: 'check:start' },
      { type: 'check:start', tabId: '1' },
      { type: 'check:start', tabId: 1.5 },
      { type: 'check:start', tabId: -1 },
      { type: 'check:start', tabId: Number.NaN },
      { type: 'check:cancel', tabId: null },
      { type: 'history:get', paperKey: 5 },
      { type: 'history:get', paperKey: '' },
      { type: 'history:get', paperKey: 'x'.repeat(1000) },
      { type: 'history:get' },
    ]) {
      expect(isPanelToBackground(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('isBackgroundToPanel', () => {
  const started = { type: 'check:started', tabId: 1, paper, total: 4 };
  const res = { type: 'check:result', tabId: 1, paperKey: paper.key, result };
  const done = { type: 'check:done', tabId: 1, summary };
  const error = { type: 'check:error', tabId: 1, code: 'confidential', message: 'No.' };

  test('accepts the events the background sends', () => {
    expect(isBackgroundToPanel(started)).toBe(true);
    expect(isBackgroundToPanel(res)).toBe(true);
    expect(isBackgroundToPanel(done)).toBe(true);
    expect(isBackgroundToPanel(error)).toBe(true);
    expect(isBackgroundToPanel({ type: 'badge:clicked', tabId: 1, index: 2 })).toBe(true);
    expect(isBackgroundToPanel({ ...started, paper: { ...paper, viaArxivVersion: '1706.03762' } })).toBe(true);
  });

  test('accepts every error code, including the OpenReview ones', () => {
    for (const code of ['unsupported', 'confidential', 'visibility-unclear', 'no-arxiv-version', 'open-forum-page', 'no-references', 'offline', 'fetch-failed']) {
      expect(isBackgroundToPanel({ ...error, code }), code).toBe(true);
    }
    expect(isBackgroundToPanel({ ...error, code: 'weird' })).toBe(false);
  });

  test('the four run events may carry replayed:true, and nothing else in that field', () => {
    for (const event of [started, res, done, error]) {
      expect(isBackgroundToPanel({ ...event, replayed: true }), event.type).toBe(true);
      expect(isBackgroundToPanel({ ...event, replayed: false }), event.type).toBe(false);
      expect(isBackgroundToPanel({ ...event, replayed: 'yes' }), event.type).toBe(false);
    }
  });

  test('check:limited and check:stopped carry a paper key and a known source or reason', () => {
    const limited = { type: 'check:limited', tabId: 1, paperKey: paper.key, source: 'openalex' };
    const stopped = { type: 'check:stopped', tabId: 1, paperKey: paper.key, reason: 'services-down' };
    for (const event of [limited, stopped]) {
      expect(isBackgroundToPanel(event), event.type).toBe(true);
      expect(isBackgroundToPanel({ ...event, replayed: true }), event.type).toBe(true);
      expect(isBackgroundToPanel({ ...event, replayed: false }), event.type).toBe(false);
      expect(isBackgroundToPanel({ ...event, paperKey: '' }), event.type).toBe(false);
    }
    expect(isBackgroundToPanel({ ...stopped, reason: 'user' })).toBe(true);
    expect(isBackgroundToPanel({ ...stopped, reason: 'whim' })).toBe(false);
    expect(isBackgroundToPanel({ ...limited, source: 'google' })).toBe(false);
  });

  test('check:blocked carries a paper key, a known source and a time', () => {
    const blocked = { type: 'check:blocked', tabId: 1, paperKey: paper.key, source: 'crossref', until: Date.UTC(2026, 9, 28, 19, 42) };
    expect(isBackgroundToPanel(blocked)).toBe(true);
    expect(isBackgroundToPanel({ ...blocked, replayed: true })).toBe(true);
    expect(isBackgroundToPanel({ ...blocked, replayed: false })).toBe(false);
    expect(isBackgroundToPanel({ ...blocked, paperKey: '' })).toBe(false);
    expect(isBackgroundToPanel({ ...blocked, source: 'google' })).toBe(false);
    for (const until of ['19:42', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) expect(isBackgroundToPanel({ ...blocked, until }), String(until)).toBe(false);
  });

  test('a badge click handed to the panel that asks: badge:take with a tab, and a reply with an index', () => {
    expect(isPanelToBackground({ type: 'badge:take', tabId: 5 })).toBe(true);
    expect(isPanelToBackground({ type: 'badge:take', tabId: -1 })).toBe(false);
    expect(isPanelToBackground({ type: 'badge:take' })).toBe(false);
    expect(isBackgroundReply({ ok: true, badgeIndex: 4 })).toBe(true);
    expect(isBackgroundReply({ ok: true, badgeIndex: '4' })).toBe(false);
    expect(isBackgroundReply({ ok: true, badgeIndex: -1 })).toBe(false);
  });

  test('a check:error may carry the paper key, and only as a string', () => {
    expect(isBackgroundToPanel({ ...error, paperKey: 'openreview:abc123' })).toBe(true);
    expect(isBackgroundToPanel({ ...error, paperKey: 7 })).toBe(false);
    expect(isBackgroundToPanel({ ...error, paperKey: '' })).toBe(false);
  });

  test('rejects wrong field types and unknown types', () => {
    expect(isBackgroundToPanel({ type: 'check:other' })).toBe(false);
    expect(isBackgroundToPanel({ ...started, total: '4' })).toBe(false);
    expect(isBackgroundToPanel({ ...started, paper: { ...paper, origin: 'elsewhere' } })).toBe(false);
    expect(isBackgroundToPanel({ ...started, paper: { ...paper, viaArxivVersion: 7 } })).toBe(false);
    expect(isBackgroundToPanel({ ...res, result: { ...result, status: 'maybe' } })).toBe(false);
    expect(isBackgroundToPanel({ ...res, result: { ...result, links: [{ label: 'x', url: 'javascript:alert(1)' }] } })).toBe(false);
    expect(isBackgroundToPanel({ ...res, paperKey: 7 })).toBe(false);
    expect(isBackgroundToPanel({ ...done, summary: { ...summary, counts: { verified: 1 } } })).toBe(false);
    expect(isBackgroundToPanel({ ...error, message: 3 })).toBe(false);
    expect(isBackgroundToPanel({ type: 'badge:clicked', tabId: 1 })).toBe(false);
  });
});

describe('content messages', () => {
  test('content to background', () => {
    expect(isContentToBackground({ type: 'content:ready', paperKey: 'arxiv:1706.03762' })).toBe(true);
    expect(isContentToBackground({ type: 'page:leaving', paperKey: 'arxiv:1706.03762' })).toBe(true);
    expect(isContentToBackground({ type: 'badge:clicked', index: 3 })).toBe(true);
    expect(isContentToBackground({ type: 'content:ready' })).toBe(false);
    expect(isContentToBackground({ type: 'badge:clicked', index: '3' })).toBe(false);
    expect(isContentToBackground({ type: 'check:start', tabId: 1 })).toBe(false);
  });

  test('background to content', () => {
    expect(isBackgroundToContent({ type: 'refs:extract' })).toBe(true);
    expect(isBackgroundToContent({ type: 'openreview:read' })).toBe(true);
    expect(isBackgroundToContent({ type: 'badges:clear' })).toBe(true);
    expect(isBackgroundToContent({ type: 'badges:update', paperKey: 'arxiv:1', results: [{ index: 1, status: 'verified', reason: 'ok' }] })).toBe(true);
    expect(isBackgroundToContent({ type: 'badges:update', paperKey: 'arxiv:1', results: [{ index: 1, status: 'verified' }] })).toBe(false);
    expect(isBackgroundToContent({ type: 'badges:update', paperKey: 'arxiv:1', results: 'none' })).toBe(false);
    expect(isBackgroundToContent({ type: 'refs:other' })).toBe(false);
  });

  test('panel to content', () => {
    expect(isPanelToContent({ type: 'ref:scrollTo', index: 4 })).toBe(true);
    expect(isPanelToContent({ type: 'ref:scrollTo', index: -4 })).toBe(false);
    expect(isPanelToContent({ type: 'ref:scrollTo' })).toBe(false);
  });

  test('replies from content scripts', () => {
    expect(isRefsExtractReply({ refs: [{ index: 1, label: '[1]', text: 'A paper.' }] })).toBe(true);
    expect(isRefsExtractReply({ refs: [{ index: 1, label: '[1]', text: 'A paper.', blocks: ['A paper.'], anchorId: 'bib.1' }], title: 'T' })).toBe(true);
    expect(isRefsExtractReply({ refs: [] })).toBe(true);
    expect(isRefsExtractReply({ refs: [{ index: 1, label: '[1]', text: 'A paper.', partial: true }] })).toBe(true);
    expect(isRefsExtractReply({ refs: [{ index: 1, label: '[1]', text: 'A paper.', partial: 'yes' }] })).toBe(false);
    expect(isRefsExtractReply({ refs: [{ index: '1', label: '[1]', text: 'x' }] })).toBe(false);
    expect(isRefsExtractReply({ refs: [{ index: 1, label: '[1]', text: 'x'.repeat(30_000) }] })).toBe(false);
    expect(isRefsExtractReply({ refs: 'x' })).toBe(false);
    expect(isRefsExtractReply({ refs: [], title: 5 })).toBe(false);
    expect(isRefsExtractReply(null)).toBe(false);

    expect(isOpenReviewReadReply({ visibility: 'public', title: 'T', forumId: 'abc123' })).toBe(true);
    expect(isOpenReviewReadReply({ visibility: 'confidential' })).toBe(true);
    expect(isOpenReviewReadReply({ visibility: 'secret' })).toBe(false);
    expect(isOpenReviewReadReply({ visibility: 'public', title: 5 })).toBe(false);
    expect(isOpenReviewReadReply('public')).toBe(false);
  });

  test('replies from the background', () => {
    expect(isBackgroundReply({ ok: true })).toBe(true);
    expect(isBackgroundReply({ ok: true, saved: null })).toBe(true);
    expect(isBackgroundReply({ ok: true, saved: { summary, results: [result] } })).toBe(true);
    expect(isBackgroundReply({ ok: false, error: 'Nope' })).toBe(true);
    expect(isBackgroundReply({ ok: false })).toBe(false);
    expect(isBackgroundReply({ ok: true, saved: { summary: 1, results: [] } })).toBe(false);
    expect(isBackgroundReply(undefined)).toBe(false);
  });
});

describe('isTrustedSender', () => {
  const arxivHtml = 'https://arxiv.org/html/1706.03762v7';

  test('accepts the extension itself', () => {
    expect(isTrustedSender({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' })).toBe(true);
    expect(isTrustedSender({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html', tab: { id: 1, url: 'chrome-extension://ext-id/sidepanel.html' } as never })).toBe(true);
  });

  test('accepts a content script in a tab on arXiv or OpenReview', () => {
    expect(isTrustedSender({ id: 'ext-id', url: arxivHtml, tab: { id: 1, url: arxivHtml } as never })).toBe(true);
    expect(isTrustedSender({ id: 'ext-id', url: 'https://openreview.net/forum?id=abc', tab: { id: 1, url: 'https://openreview.net/forum?id=abc' } as never })).toBe(true);
  });

  test('rejects another extension', () => {
    expect(isTrustedSender({ id: 'other-ext', url: 'chrome-extension://other-ext/x.html' })).toBe(false);
    expect(isTrustedSender({ url: 'chrome-extension://ext-id/x.html' })).toBe(false);
  });

  test('rejects tabs outside arXiv and OpenReview, look-alikes and plain http', () => {
    for (const url of [
      'https://example.com/',
      'https://arxiv.org.evil.com/html/1706.03762',
      'https://evilarxiv.org/html/1',
      'https://arxiv.org@evil.com/html/1',
      'http://arxiv.org/html/1706.03762',
      'https://openreview.net.evil.com/forum?id=abc',
      'not a url',
      '',
    ]) {
      expect(isTrustedSender({ id: 'ext-id', url, tab: { id: 1, url } as never }), url).toBe(false);
    }
    expect(isTrustedSender({ id: 'ext-id', tab: { id: 1 } as never })).toBe(false);
  });
});

describe('links in a result', () => {
  const withLink = (url: string) => ({ ...result, links: [{ label: 'x', url }] });

  test('accepts only links the identifiers module would have built', () => {
    for (const url of [
      doiUrl('10.1000/xyz123'),
      doiUrl('10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O'),
      doiUrl('10.1000/a?b#c'),
      arxivUrl('1706.03762'),
      arxivUrl('hep-th/9901001'),
      openreviewUrl('abc123XYZ'),
    ]) {
      expect(isCheckResult(withLink(url)), url).toBe(true);
    }
  });

  test('rejects any other https address, however harmless it looks', () => {
    for (const url of [
      'https://example.com/',
      'https://doi.org/',
      'https://doi.org/not-a-doi',
      'https://doi.org/10.1000/x#fragment',
      'https://doi.org/10.1000/x?query=1',
      'https://doi.org/10.1000/../../x',
      'https://doi.org.evil.com/10.1000/x',
      'https://user@doi.org/10.1000/x',
      'http://doi.org/10.1000/x',
      'https://dx.doi.org/10.1000/x',
      'https://arxiv.org/pdf/1706.03762',
      'https://arxiv.org/abs/',
      'https://arxiv.org/abs/not-an-id',
      'https://arxiv.org/abs/1706.03762/extra',
      'https://arxiv.org/abs/1706.03762?x=1',
      'https://export.arxiv.org/abs/1706.03762',
      'https://openreview.net/forum',
      'https://openreview.net/forum?id=abc123XYZ&noteId=other',
      'https://openreview.net/forum?id=ab',
      'https://openreview.net/profile?id=abc123XYZ',
      'https://openreview.net/pdf?id=abc123XYZ',
      'https://openreview.net.evil.com/forum?id=abc123XYZ',
      'javascript:alert(1)',
      'data:text/html,x',
    ]) {
      expect(isCheckResult(withLink(url)), url).toBe(false);
    }
  });

  test('a malformed escape in a DOI link is refused, not thrown on', () => {
    expect(isCheckResult(withLink('https://doi.org/10.1000/%E0%A4%A'))).toBe(false);
  });
});

describe('sender classification', () => {
  test('isSidePanelPage accepts only the side panel page of this extension', () => {
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' })).toBe(true);
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html?x=1#y' })).toBe(true);
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id/offscreen.html' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id/background.js' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html/x' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id/a/../offscreen.html' })).toBe(false);
    expect(isSidePanelPage({ id: 'other', url: 'chrome-extension://ext-id/sidepanel.html' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id', url: 'chrome-extension://ext-id-evil/sidepanel.html' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id', url: 'https://arxiv.org/sidepanel.html' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id' })).toBe(false);
    expect(isSidePanelPage({ id: 'ext-id', url: 'not a url' })).toBe(false);
  });

  test('isExtensionPage needs an address inside this extension', () => {
    expect(isExtensionPage({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' })).toBe(true);
    expect(isExtensionPage({ id: 'ext-id', url: 'https://arxiv.org/html/1706.03762' })).toBe(false);
    expect(isExtensionPage({ id: 'ext-id' })).toBe(false);
    expect(isExtensionPage({ id: 'other', url: 'chrome-extension://ext-id/a.html' })).toBe(false);
    // The prefix must end at the origin: another id that starts the same does not count.
    expect(isExtensionPage({ id: 'ext-id', url: 'chrome-extension://ext-id-evil/a.html' })).toBe(false);
  });

  test('contentSite says which content script a sender is, from its own address', () => {
    const sender = (url: string, frameId = 0) => ({ id: 'ext-id', url, frameId, tab: { id: 1, url } as never });
    expect(contentSite(sender('https://arxiv.org/html/1706.03762v7'))).toBe('arxiv-html');
    expect(contentSite(sender('https://openreview.net/forum?id=abc123'))).toBe('openreview-forum');
    // arXiv abstract and PDF pages and OpenReview /pdf host no content script.
    expect(contentSite(sender('https://arxiv.org/abs/1706.03762'))).toBeUndefined();
    expect(contentSite(sender('https://openreview.net/pdf?id=abc123'))).toBeUndefined();
    // Only the top frame.
    expect(contentSite(sender('https://arxiv.org/html/1706.03762v7', 3))).toBeUndefined();
    expect(contentSite({ id: 'other', url: 'https://arxiv.org/html/1706.03762v7', tab: { id: 1 } as never })).toBeUndefined();
    expect(contentSite({ id: 'ext-id', url: 'https://arxiv.org/html/1706.03762v7' })).toBeUndefined();
  });
});
