import { describe, expect, test, vi } from 'vitest';
import { renderFilters } from '../../../src/ui/filters';
import { byText, click, makeDom, text } from '../helpers/dom';

const { doc } = makeDom();
const counts = { verified: 40, details_differ: 2, wrong_id: 0, retracted: 1, not_found: 1, cant_check: 3 };

describe('filter chips', () => {
  test('show a count on every chip, problems first, and skip statuses with none', () => {
    const bar = renderFilters(doc, counts, 'all', vi.fn());
    const chips = [...bar.querySelectorAll('button')].map((b) => text(b));
    expect(chips).toEqual(['All 47', 'Retracted 1', 'Not found 1', 'Details differ 2', "Can't check 3", 'Verified 40']);
  });

  test('mark the active chip with aria-pressed and report clicks', () => {
    const onSelect = vi.fn();
    const bar = renderFilters(doc, counts, 'not_found', onSelect);
    expect(byText(bar, 'button', 'Not found 1').getAttribute('aria-pressed')).toBe('true');
    expect(byText(bar, 'button', 'All 47').getAttribute('aria-pressed')).toBe('false');
    click(byText(bar, 'button', 'Verified 40'));
    expect(onSelect).toHaveBeenCalledWith('verified');
    click(byText(bar, 'button', 'All 47'));
    expect(onSelect).toHaveBeenCalledWith('all');
  });

  test('the group has an accessible name', () => {
    expect(renderFilters(doc, counts, 'all', vi.fn()).getAttribute('aria-label')).toBe('Filter by status');
  });
});
