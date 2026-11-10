// One reference in the results list (DESIGN 7.3): number, short citation, status icon + word, one-line
// reason, notes, a link to the matched paper, and an expandable side-by-side comparison.
// Everything from a result is shown as text; links are re-checked here even though the message
// validator already refused any link that is not a doi.org, arXiv or OpenReview address. A match with
// none of those links to its OpenAlex or DBLP record page, built from the record's validated id.

import { asText } from '../core/coerce';
import { resultLinks } from '../core/report';
import { FIELD_NAME, SOURCE_NAME, STATUS_WORD } from '../core/status';
import type { CheckResult, FieldDiff } from '../core/types';
import { button, clip, el, uid } from './dom';
import { statusIcon } from './icons';

export const CITATION_PREVIEW_CHARS = 140;
const MAX_LABEL_CHARS = 10;
const LINK_HOSTS: ReadonlySet<string> = new Set(['doi.org', 'arxiv.org', 'openreview.net', 'openalex.org', 'dblp.org']);

export interface RowOptions {
  expanded: boolean;
  /** True on an HTML paper page, where the reference can be scrolled into view. */
  canScroll: boolean;
  /** Briefly outlines the row (the reader clicked its badge on the page). */
  flash?: boolean;
  onToggle(index: number): void;
  onSelect(index: number): void;
}

function referenceNumber(r: CheckResult): string {
  return r.label.length > 0 && r.label.length <= MAX_LABEL_CHARS && !/\s/.test(r.label) ? r.label : `[${r.index}]`;
}

function isSafeLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && LINK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function linkNode(doc: Document, text: string, url: string, title?: string): HTMLAnchorElement {
  return el(doc, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer', title }, text);
}

function links(doc: Document, r: CheckResult, number: string): HTMLAnchorElement[] {
  const nodes: HTMLAnchorElement[] = [];
  let matched = 0;
  for (const link of resultLinks(r)) {
    if (!isSafeLink(link.url)) continue;
    if (link.label === 'Retraction notice') {
      nodes.push(linkNode(doc, 'Retraction notice', link.url));
    } else {
      const node = linkNode(doc, matched === 0 ? 'Open matched paper' : `${link.label} link`, link.url, link.label);
      // Thirty-five links called the same thing are no use in a screen reader's list of links.
      if (matched === 0) node.setAttribute('aria-label', `Open matched paper for reference ${number}`);
      nodes.push(node);
      matched += 1;
    }
  }
  return nodes;
}

function diffBlock(doc: Document, diffs: readonly FieldDiff[]): HTMLElement {
  const block = el(doc, 'div', { class: 'diff', role: 'group', 'aria-label': 'Cited and found, side by side' });
  for (const d of diffs) {
    block.append(
      el(
        doc,
        'div',
        { class: 'diff-row' },
        el(doc, 'span', { class: 'diff-field' }, FIELD_NAME[d.field]),
        el(doc, 'div', { class: 'cited' }, el(doc, 'span', { class: 'diff-label' }, 'Cited'), el(doc, 'span', { class: 'diff-value' }, d.cited)),
        el(doc, 'div', { class: 'found' }, el(doc, 'span', { class: 'diff-label' }, 'Found'), el(doc, 'span', { class: 'diff-value' }, d.actual)),
      ),
    );
  }
  return block;
}

function details(doc: Document, r: CheckResult, id: string): HTMLElement {
  const box = el(doc, 'div', { class: 'details', id });
  if (r.diffs.length > 0) box.append(diffBlock(doc, r.diffs));
  const match = r.match;
  if (match !== undefined) {
    // `match` is only known to be a record: coerce what is shown so a malformed one cannot throw here.
    const year = asText(match.year) === '' ? '' : ` (${asText(match.year)})`;
    const source = (SOURCE_NAME as Record<string, string | undefined>)[asText(match.source)];
    box.append(el(doc, 'p', { class: 'matched' }, `Matched record: ${clip(asText(match.title), 300)}${year}${source === undefined ? '' : ` · ${source}`}`));
  }
  if (r.sourcesSearched.length > 0) box.append(el(doc, 'p', { class: 'sources' }, `Searched: ${r.sourcesSearched.map((s) => SOURCE_NAME[s]).join(', ')}`));
  if (r.sourcesFailed.length > 0) box.append(el(doc, 'p', { class: 'sources' }, `Couldn't reach: ${r.sourcesFailed.map((s) => SOURCE_NAME[s]).join(', ')}`));
  return box;
}

export function renderRow(doc: Document, r: CheckResult, o: RowOptions): HTMLLIElement {
  const number = referenceNumber(r);
  const detailsId = uid('details');
  const citation = o.expanded ? r.citedText : clip(r.citedText, CITATION_PREVIEW_CHARS);

  const toggle = button(doc, o.expanded ? 'Hide details' : 'Show details', () => o.onToggle(r.index), {
    class: 'row-toggle',
    'aria-expanded': o.expanded ? 'true' : 'false',
    'aria-controls': o.expanded ? detailsId : undefined,
    'aria-label': `${o.expanded ? 'Hide' : 'Show'} details for reference ${number}`,
  });
  const actions = el(doc, 'div', { class: 'row-actions' });
  if (o.canScroll) actions.append(button(doc, 'Show on page', () => o.onSelect(r.index), { class: 'row-goto', 'aria-label': `Show on page: reference ${number}` }));
  actions.append(...links(doc, r, number), toggle);

  const row = el(
    doc,
    'li',
    { class: o.flash === true ? 'row flash' : 'row', 'data-index': String(r.index), 'data-status': r.status, ...(o.canScroll && { 'data-scrollable': '' }) },
    el(doc, 'div', { class: 'row-head' }, el(doc, 'span', { class: 'num' }, number), el(doc, 'span', { class: 'status' }, statusIcon(doc, r.status), el(doc, 'span', { class: 'status-word' }, STATUS_WORD[r.status]))),
    el(doc, 'p', { class: 'citation' }, citation),
    el(doc, 'p', { class: 'reason' }, r.reason),
    r.notes.length > 0 && el(doc, 'ul', { class: 'notes' }, ...r.notes.map((note) => el(doc, 'li', {}, note))),
    actions,
    o.expanded && details(doc, r, detailsId),
  );

  // A click anywhere on the row (but not on a link or button) shows the reference on the page.
  // Keyboard users get the same through the "Show on page" button.
  if (o.canScroll) {
    row.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest('a, button') != null) return;
      o.onSelect(r.index);
    });
  }
  return row;
}
