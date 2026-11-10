import { describe, expect, test } from 'vitest';
import { STATUS_ORDER, STATUS_WORD } from '../../../src/core/status';
import { renderWelcome } from '../../../src/ui/welcomeView';
import { makeDom, text } from '../helpers/dom';

const { doc } = makeDom('chrome-extension://ext-id/welcome.html');

describe('welcome page', () => {
  const page = renderWelcome(doc);

  test('shows the six statuses with an icon, the word and a one-line meaning', () => {
    const rows = [...page.querySelectorAll('.status-list li')];
    expect(rows).toHaveLength(6);
    for (const status of STATUS_ORDER) {
      const row = rows.find((r) => r.getAttribute('data-status') === status);
      expect(row?.querySelector('svg')).not.toBeNull();
      expect(row?.textContent).toContain(STATUS_WORD[status]);
      expect(text(row as Element).length).toBeGreaterThan(STATUS_WORD[status].length + 15);
    }
  });

  test('explains how to use it: open a paper, click the toolbar button', () => {
    expect(text(page)).toMatch(/arXiv/);
    expect(text(page)).toMatch(/OpenReview/);
    expect(text(page)).toMatch(/toolbar button/);
  });

  test('step 2 says how long a check takes and that results arrive as they go', () => {
    const step = [...page.querySelectorAll('.steps li')][1];
    expect(text(step as Element)).toContain('A check takes one to two minutes; results appear as they arrive.');
  });

  test('states the privacy line exactly', () => {
    expect(text(page)).toContain(
      'The developer receives nothing. Reference details are sent only to the public databases listed: Crossref, OpenAlex, arXiv, OpenReview and DBLP.',
    );
  });

  test('turns nothing on: no switches, no fields, no links out', () => {
    expect(page.querySelector('input, select, textarea, a[href]')).toBeNull();
  });

  test('never accuses', () => {
    expect(text(page)).not.toMatch(/fake|hallucinat/i);
  });
});
