import { describe, expect, test } from 'vitest';
import { renderHeader, type HeaderModel } from '../../../src/ui/summary';
import { makeDom, text } from '../helpers/dom';
import { counts, paper, result } from '../helpers/results';

const { doc } = makeDom();
const rs = [result({ index: 1 }), result({ index: 2, status: 'not_found' })];

function model(over: Partial<HeaderModel> = {}): HeaderModel {
  return { paper: paper(), title: 'Attention Is All You Need', phase: 'done', done: 2, total: 2, counts: counts(rs), beta: false, ...over };
}

describe('header', () => {
  test('shows the paper title and the totals line when done', () => {
    const header = renderHeader(doc, model({ counts: { verified: 40, details_differ: 2, wrong_id: 0, retracted: 1, not_found: 1, cant_check: 3 } }));
    expect(header.querySelector('h1')?.textContent).toBe('Attention Is All You Need');
    expect(text(header)).toContain('40 verified · 2 with different details · 1 not found · 1 retracted · 3 couldn\'t be checked');
    expect(header.querySelector('[role="progressbar"]')).toBeNull();
  });

  test('each number is joined to its word by a no-break space, so a line never ends on a bare number', () => {
    const header = renderHeader(doc, model({ counts: { verified: 40, details_differ: 2, wrong_id: 0, retracted: 1, not_found: 1, cant_check: 3 } }));
    const line = header.querySelector('.totals')?.textContent ?? '';
    expect(line).toBe("40\u00A0verified · 2\u00A0with different details · 1\u00A0not found · 1\u00A0retracted · 3\u00A0couldn't be checked");
    // Between parts (the " · ") the line may still break, and the words inside a part may.
    expect(line.split(' · ')).toHaveLength(5);
  });

  test('shows a progress bar with aria-valuenow while checking', () => {
    const header = renderHeader(doc, model({ phase: 'checking', done: 12, total: 40 }));
    const bar = header.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('12');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('40');
    expect(bar?.getAttribute('aria-label')).toBe('Checking references');
    expect(text(header)).toContain('Checking 12 of 40');
  });

  test('the fill width follows the count', () => {
    const fill = renderHeader(doc, model({ phase: 'checking', done: 12, total: 40 })).querySelector<HTMLElement>('.progress-fill');
    expect(fill?.style.width).toBe('30%');
  });

  test('an unknown total gives an indeterminate bar (no aria-valuenow)', () => {
    const bar = renderHeader(doc, model({ phase: 'checking', done: 0, total: 0 })).querySelector('[role="progressbar"]');
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
  });

  test('says which arXiv version was used, with a validated link', () => {
    const header = renderHeader(doc, model({ paper: paper({ origin: 'openreview', key: 'openreview:abc', viaArxivVersion: '1706.03762v7' }) }));
    expect(text(header)).toContain('Checked using the arXiv version (arXiv:1706.03762v7)');
    const link = header.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://arxiv.org/abs/1706.03762v7');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('an invalid arXiv id is shown as text and never linked', () => {
    const header = renderHeader(doc, model({ paper: paper({ viaArxivVersion: 'javascript:alert(1)' }) }));
    expect(header.querySelector('a')).toBeNull();
  });

  test('a Beta pill with one line of help when the references came from the PDF', () => {
    const header = renderHeader(doc, model({ beta: true }));
    expect(header.querySelector('.pill')?.textContent).toBe('Beta');
    expect(text(header)).toContain('References read from the PDF. A few may be misread.');
    expect(text(renderHeader(doc, model()))).not.toContain('Beta');
  });

  test.each(['interrupted', 'stopped'] as const)('a %s check with nothing found says "No results yet", not "No references"', (phase) => {
    const header = renderHeader(doc, model({ phase, done: 0, total: 5, counts: counts([]) }));
    expect(text(header)).toContain('No results yet');
    expect(text(header)).not.toContain('No references');
  });

  test('a finished check with no references still says so', () => {
    expect(text(renderHeader(doc, model({ done: 0, total: 0, counts: counts([]) })))).toContain('No references');
  });

  test('says when the results are a saved earlier check', () => {
    expect(text(renderHeader(doc, model({ savedAt: Date.UTC(2026, 9, 21, 10, 0, 0) })))).toContain('Saved check from');
  });
});
