import { describe, expect, test } from 'vitest';
import { cleanTabTitle } from '../../../src/core/title';

// The title the background keeps for a paper, from its tab or its page, and the panel shows before a check.
describe('cleanTabTitle', () => {
  test.each([
    ['[1706.03762] Attention Is All You Need', 'Attention Is All You Need'],
    ['Attention Is All You Need | OpenReview', 'Attention Is All You Need'],
    ['  Attention\n Is   All You Need  |  openreview', 'Attention Is All You Need'],
    ['[a label longer than forty characters, so it is kept] Title', '[a label longer than forty characters, so it is kept] Title'],
    ['OpenReview | OpenReview', 'OpenReview'],
  ])('%j becomes %j', (raw, clean) => {
    expect(cleanTabTitle(raw)).toBe(clean);
  });

  test.each([undefined, '', '   ', '[1706.03762]', ' | OpenReview'])('%j leaves nothing', (raw) => {
    expect(cleanTabTitle(raw)).toBeUndefined();
  });

  test('is cut at 300 characters', () => {
    expect(cleanTabTitle('x'.repeat(1000))).toHaveLength(300);
  });
});
