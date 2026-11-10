// The page opened once, on install (DESIGN 7.3 "First-run"): how to use RefSure, what the six results
// mean, and the privacy line. It is read-only: it turns nothing on and starts no check.

import { STATUS_MEANING, STATUS_WORD, STATUSES } from '../core/status';
import { el } from './dom';
import { statusIcon } from './icons';

const PRIVACY_LINE =
  'The developer receives nothing. Reference details are sent only to the public databases listed: Crossref, OpenAlex, arXiv, OpenReview and DBLP.';

export function renderWelcome(doc: Document): HTMLElement {
  const statuses = el(
    doc,
    'ul',
    { class: 'status-list' },
    ...STATUSES.map((status) =>
        el(
          doc,
          'li',
          { 'data-status': status },
          el(doc, 'span', { class: 'status' }, statusIcon(doc, status), el(doc, 'strong', { class: 'status-word' }, STATUS_WORD[status])),
          el(doc, 'span', {}, STATUS_MEANING[status]),
        ),
      ),
  );

  return el(
    doc,
    'div',
    { class: 'welcome' },
    el(doc, 'h1', {}, 'Welcome to RefSure'),
    el(doc, 'p', { class: 'lead' }, "Check a paper's references in one click, and see which ones to look at twice."),
    el(
      doc,
      'section',
      {},
      el(doc, 'h2', {}, 'How to use it'),
      el(
        doc,
        'ol',
        { class: 'steps' },
        el(doc, 'li', {}, 'Open a paper on arXiv, or a public paper on OpenReview.'),
        el(doc, 'li', {}, 'Click the RefSure toolbar button. A panel opens and checks the paper. A check takes one to two minutes; results appear as they arrive.'),
        el(doc, 'li', {}, 'Read the results. The references that need a look are listed first.'),
      ),
      el(doc, 'p', { class: 'hint' }, "Can't see the button? Open your browser's extensions menu (the puzzle-piece icon) and pin RefSure to the toolbar."),
    ),
    el(doc, 'section', {}, el(doc, 'h2', {}, 'What the results mean'), statuses),
    el(doc, 'section', { class: 'privacy' }, el(doc, 'h2', {}, 'Your privacy'), el(doc, 'p', {}, PRIVACY_LINE), el(doc, 'p', { class: 'hint' }, 'Nothing is checked until you click. Automatic checking is off; you can turn it on later in the panel settings.')),
  );
}
