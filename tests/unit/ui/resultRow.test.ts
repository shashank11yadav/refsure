import { describe, expect, test, vi } from 'vitest';
import { CITATION_PREVIEW_CHARS, renderRow, type RowOptions } from '../../../src/ui/resultRow';
import type { CheckResult } from '../../../src/core/types';
import { byText, click, makeDom, text } from '../helpers/dom';
import { result } from '../helpers/results';

const { doc } = makeDom();

function opts(over: Partial<RowOptions> = {}): RowOptions {
  return { expanded: false, canScroll: true, onToggle: vi.fn(), onSelect: vi.fn(), ...over };
}

describe('result row', () => {
  test('shows the number, a status icon plus word, and the reason', () => {
    const row = renderRow(doc, result({ index: 12, status: 'not_found', reason: 'Not found in Crossref, arXiv, OpenReview or OpenAlex' }), opts());
    expect(row.getAttribute('data-status')).toBe('not_found');
    expect(row.querySelector('.status svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('.status')?.textContent).toContain('Not found');
    expect(text(row)).toContain('[12]');
    expect(text(row)).toContain('Not found in Crossref, arXiv, OpenReview or OpenAlex');
  });

  test('reason text with markup renders as text', () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const row = renderRow(doc, result({ reason: payload, citedText: payload, notes: [payload], diffs: [{ field: 'title', cited: payload, actual: payload }], status: 'details_differ' }), opts({ expanded: true }));
    expect(row.querySelector('img, script')).toBeNull();
    expect(row.textContent).toContain(payload);
  });

  test('a long citation is cut short, with a toggle that shows all of it', () => {
    const long = `Roe J. ${'word '.repeat(120)}END-OF-CITATION`;
    const onToggle = vi.fn();
    const collapsed = renderRow(doc, result({ index: 4, citedText: long }), opts({ onToggle }));
    expect(collapsed.textContent).not.toContain('END-OF-CITATION');
    expect(collapsed.querySelector('.citation')?.textContent?.length).toBeLessThanOrEqual(CITATION_PREVIEW_CHARS + 1);
    const toggle = byText(collapsed, 'button', 'Show details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    click(toggle);
    expect(onToggle).toHaveBeenCalledWith(4);

    const expanded = renderRow(doc, result({ index: 4, citedText: long }), opts({ expanded: true }));
    expect(expanded.textContent).toContain('END-OF-CITATION');
    const hide = byText(expanded, 'button', 'Hide details');
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(expanded.querySelector(`#${hide.getAttribute('aria-controls')}`)).not.toBeNull();
  });

  test('Details differ shows cited and found side by side when expanded, not when collapsed', () => {
    const r = result({
      status: 'details_differ',
      reason: 'The year differs',
      diffs: [{ field: 'year', cited: '2018', actual: '2019' }],
      match: { source: 'crossref', title: 'A study of things', authors: ['roe'], year: 2019, isRetracted: false, notes: [] },
    });
    expect(renderRow(doc, r, opts()).querySelector('.diff')).toBeNull();
    const open = renderRow(doc, r, opts({ expanded: true }));
    const diff = open.querySelector('.diff');
    expect(diff?.querySelector('.cited')?.textContent).toContain('2018');
    expect(diff?.querySelector('.found')?.textContent).toContain('2019');
    expect(text(diff as Element)).toContain('Cited');
    expect(text(diff as Element)).toContain('Found');
  });

  test('Wrong ID shows the two titles side by side', () => {
    const r = result({
      status: 'wrong_id',
      reason: 'This DOI points to a different paper than the title cited',
      diffs: [{ field: 'identifier', cited: '10.1000/abc', actual: 'Quantum gravity' }],
    });
    expect(renderRow(doc, r, opts({ expanded: true })).querySelector('.diff .found')?.textContent).toContain('Quantum gravity');
  });

  test('a malformed match cannot break the row', () => {
    const bad = { source: 'zzz', title: { evil: 1 }, year: 'abc', doi: 42, authors: 'x', isRetracted: false, notes: [] } as unknown as CheckResult['match'];
    const row = renderRow(doc, result({ match: bad }), opts({ expanded: true }));
    expect(row.textContent).not.toContain('[object Object]');
    const longTitle = { source: 'crossref', title: ['x'.repeat(500)] } as unknown as CheckResult['match'];
    expect(() => renderRow(doc, result({ match: longTitle }), opts({ expanded: true }))).not.toThrow();
  });

  test('notes show without expanding', () => {
    const row = renderRow(doc, result({ notes: ['Note: withdrawn by authors on arXiv'] }), opts());
    expect(text(row)).toContain('Note: withdrawn by authors on arXiv');
  });

  test('the matched-paper link opens in a new tab without a referrer, and only for known sites', () => {
    const row = renderRow(
      doc,
      result({
        links: [
          { label: 'DOI', url: 'https://doi.org/10.1000/xyz' },
          { label: 'Evil', url: 'https://evil.example/phish' },
          { label: 'Retraction notice', url: 'https://doi.org/10.1000/notice' },
        ],
      }),
      opts(),
    );
    const anchors = [...row.querySelectorAll('a')];
    const matched = anchors.find((a) => a.textContent === 'Open matched paper');
    expect(matched?.getAttribute('href')).toBe('https://doi.org/10.1000/xyz');
    expect(matched?.getAttribute('target')).toBe('_blank');
    expect(matched?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchors.some((a) => a.getAttribute('href')?.includes('evil.example'))).toBe(false);
    expect(anchors.some((a) => a.textContent === 'Retraction notice')).toBe(true);
  });

  test('a match found only in OpenAlex or DBLP, with no DOI, links to its record page', () => {
    const openalexMatch = { source: 'openalex', title: 'A study of things', authors: ['roe'], year: 2019, openalexId: 'W2626778328', isRetracted: false, notes: [] } as const;
    const row = renderRow(doc, result({ index: 3, match: { ...openalexMatch, authors: ['roe'], notes: [] } }), opts());
    const matched = [...row.querySelectorAll('a')].find((a) => a.textContent === 'Open matched paper');
    expect(matched?.getAttribute('href')).toBe('https://openalex.org/works/W2626778328');
    expect(matched?.getAttribute('target')).toBe('_blank');
    expect(matched?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(matched?.getAttribute('title')).toBe('OpenAlex');
    expect(matched?.getAttribute('aria-label')).toBe('Open matched paper for reference [3]');

    const dblpRow = renderRow(doc, result({ match: { source: 'dblp', title: 'T', authors: [], dblpKey: 'conf/nips/VaswaniSPUJGKP17', isRetracted: false, notes: [] } }), opts());
    expect(dblpRow.querySelector('a')?.getAttribute('href')).toBe('https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17');

    // The DOI link wins when there is one, and a malformed id gives no link at all.
    const withDoi = renderRow(doc, result({ match: { ...openalexMatch, authors: ['roe'], notes: [], doi: '10.1000/xyz' }, links: [{ label: 'DOI', url: 'https://doi.org/10.1000/xyz' }] }), opts());
    expect([...withDoi.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://doi.org/10.1000/xyz']);
    const hostile = renderRow(doc, result({ match: { ...openalexMatch, authors: ['roe'], notes: [], openalexId: 'W1/../../evil' } }), opts());
    expect(hostile.querySelector('a')).toBeNull();
  });

  test('when the page can be scrolled, clicking the row and the button both select it; links and toggles do not', () => {
    const onSelect = vi.fn();
    const row = renderRow(doc, result({ index: 9, links: [{ label: 'DOI', url: 'https://doi.org/10.1000/xyz' }] }), opts({ onSelect }));
    click(row.querySelector('.citation') as Element);
    expect(onSelect).toHaveBeenCalledWith(9);
    onSelect.mockClear();
    click(byText(row, 'button', 'Show on page'));
    expect(onSelect).toHaveBeenCalledWith(9);
    onSelect.mockClear();
    click(row.querySelector('a') as Element);
    click(byText(row, 'button', 'Show details'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('without a page to scroll to there is no show-on-page button and a click selects nothing', () => {
    const onSelect = vi.fn();
    const row = renderRow(doc, result(), opts({ canScroll: false, onSelect }));
    expect(row.querySelector('button.row-goto')).toBeNull();
    click(row.querySelector('.citation') as Element);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('lists the sources searched and the ones that could not be reached when expanded', () => {
    const row = renderRow(doc, result({ status: 'cant_check', sourcesSearched: ['crossref'], sourcesFailed: ['openalex'] }), opts({ expanded: true }));
    expect(text(row)).toContain('Searched: Crossref');
    expect(text(row)).toContain("Couldn't reach: OpenAlex");
  });
});
