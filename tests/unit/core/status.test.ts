import { describe, expect, test } from 'vitest';
import { completionMessage, countStatuses, emptyCounts, isProblem, joinAnd, sortProblemsFirst, STATUS_MEANING, STATUS_ORDER, STATUS_WORD, STATUSES, totalsText } from '../../../src/core/status';
import { result } from '../helpers/results';

describe('status vocabulary', () => {
  test('problems come first, verified last', () => {
    expect(STATUS_ORDER).toEqual(['retracted', 'wrong_id', 'not_found', 'details_differ', 'cant_check', 'verified']);
  });

  test("words match the badges and never accuse", () => {
    expect(STATUS_WORD.wrong_id).toBe('Wrong ID');
    expect(STATUS_WORD.cant_check).toBe("Can't check");
    expect(Object.values(STATUS_WORD).join(' ')).not.toMatch(/fake|hallucinat/i);
  });

  test("only the four 'look at this' statuses are problems", () => {
    expect(STATUS_ORDER.filter(isProblem)).toEqual(['retracted', 'wrong_id', 'not_found', 'details_differ']);
  });

  test('sorting puts problems first and keeps reference order within a status, without changing the input', () => {
    const input = [result({ index: 1, status: 'verified' }), result({ index: 3, status: 'not_found' }), result({ index: 2, status: 'not_found' }), result({ index: 4, status: 'retracted' })];
    expect(sortProblemsFirst(input).map((r) => r.index)).toEqual([4, 2, 3, 1]);
    expect(input.map((r) => r.index)).toEqual([1, 3, 2, 4]);
  });
});

describe('shared lists and counts', () => {
  test('every status once, the good news first', () => {
    expect(STATUSES).toEqual(['verified', 'details_differ', 'wrong_id', 'retracted', 'not_found', 'cant_check']);
    expect([...STATUSES].sort()).toEqual([...STATUS_ORDER].sort());
  });

  test('counts start at zero for every status, and a fresh object each time', () => {
    const counts = emptyCounts();
    expect(counts).toEqual({ verified: 0, details_differ: 0, wrong_id: 0, retracted: 0, not_found: 0, cant_check: 0 });
    counts.verified = 3;
    expect(emptyCounts().verified).toBe(0);
  });

  test('results are counted by status', () => {
    const counts = countStatuses([result({ index: 1, status: 'verified' }), result({ index: 2, status: 'not_found' }), result({ index: 3, status: 'verified' })]);
    expect(counts).toEqual({ verified: 2, details_differ: 0, wrong_id: 0, retracted: 0, not_found: 1, cant_check: 0 });
  });

  test.each([
    [[], ''],
    [['Crossref'], 'Crossref'],
    [['Crossref', 'arXiv'], 'Crossref and arXiv'],
    [['Crossref', 'arXiv', 'DBLP'], 'Crossref, arXiv and DBLP'],
  ])('a list reads as a sentence: %j', (parts, text) => {
    expect(joinAnd(parts)).toBe(text);
  });
});

describe('status wording', () => {
  test('Not found says what it does not mean, and Wrong ID explains the identifier', () => {
    expect(STATUS_MEANING.not_found).toBe(
      'No close match in Crossref, arXiv, OpenReview or OpenAlex. Some real works (reports, theses, some proceedings) are not in these databases, so look it up by hand.',
    );
    expect(STATUS_MEANING.wrong_id).toContain('DOI or arXiv ID (its permanent identifier)');
  });

  test('the totals line reads in plain words', () => {
    const counts = { verified: 40, details_differ: 1, wrong_id: 0, retracted: 0, not_found: 1, cant_check: 2 };
    expect(totalsText(counts)).toBe("40 verified · 1 with different details · 1 not found · 2 couldn't be checked");
  });

  test('the completion message counts what to look at, not "problems"', () => {
    const counts = { verified: 35, details_differ: 3, wrong_id: 0, retracted: 0, not_found: 1, cant_check: 0 };
    expect(completionMessage(counts)).toBe('Check complete: 35 verified, 4 to look at');
  });
});
