// The filter chips above the list: "All 47", then one chip per status that has results, problems first.

import { STATUS_ORDER, STATUS_WORD } from '../core/status';
import type { Status } from '../core/types';
import { el } from './dom';

export type Filter = Status | 'all';

export function renderFilters(doc: Document, counts: Readonly<Record<Status, number>>, active: Filter, onSelect: (filter: Filter) => void): HTMLElement {
  const total = STATUS_ORDER.reduce((sum, status) => sum + counts[status], 0);
  const chip = (filter: Filter, word: string, count: number): HTMLButtonElement => {
    const node = el(
      doc,
      'button',
      { type: 'button', class: 'chip', 'data-filter': filter, 'data-fk': `chip:${filter}`, 'aria-pressed': active === filter ? 'true' : 'false', 'aria-label': `${word}, ${count} ${count === 1 ? 'reference' : 'references'}` },
      word,
      ' ',
      el(doc, 'span', { class: 'count' }, String(count)),
    );
    node.addEventListener('click', () => onSelect(filter));
    return node;
  };
  const bar = el(doc, 'div', { class: 'filters', role: 'group', 'aria-label': 'Filter by status' }, chip('all', 'All', total));
  for (const status of STATUS_ORDER) if (counts[status] > 0) bar.append(chip(status, STATUS_WORD[status], counts[status]));
  return bar;
}
