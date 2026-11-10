import { describe, expect, test } from 'vitest';
import { heldOutSetsText, pathReport, pathTables, TIMING_NOTE } from '../../../scripts/eval/report';

describe('the held-out sets in RESULTS.md', () => {
  const full = (papers: number) => ({ papers, scored: papers });

  test('sets that are all complete are counted, not listed one by one', () => {
    expect(heldOutSetsText([8, 8, 8, 8, 8, 8].map(full))).toBe('six sets of 8 papers, all scored here');
    expect(heldOutSetsText([8, 8, 8].map(full))).toBe('three sets of 8 papers, all scored here');
    expect(heldOutSetsText([full(1)])).toBe('one set of 1 paper, all scored here');
    expect(heldOutSetsText([8, 10, 8].map(full))).toBe('three sets of 8, 10 and 8 papers, all scored here');
    expect(heldOutSetsText(Array.from({ length: 12 }, () => full(5)))).toBe('12 sets of 5 papers, all scored here');
  });

  test('a set with papers that could not be scored is listed with what was scored', () => {
    expect(heldOutSetsText([full(8), { papers: 8, scored: 7 }, full(8)])).toBe('8, 8 and 8 papers, of which 8, 7 and 8 are scored here');
  });
});

describe('the timing table of RESULTS.md', () => {
  test('says the times come from the first live run and that the engine has since added requests', () => {
    expect(TIMING_NOTE).toMatch(/first live run/);
    expect(TIMING_NOTE).toMatch(/has since added requests/i);
  });
});

describe('the Can\'t check split in RESULTS.md', () => {
  // The budget and a source not answering are counted apart: a source that does not answer can hide a bug.
  test('shows Can\'t check all-in and its four parts per path', () => {
    const report = pathReport('arXiv HTML', 'arxiv-html', [], {}, new Set());
    const text = pathTables([report]);
    expect(text).toMatch(/\| Path \| Can't check \(all\) \| out of scope \(judged by hand\) \| engine shortfall \(books included\) \| lookup budget \| a source not answering \|/);
  });
});
