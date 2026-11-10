import { describe, expect, test } from 'vitest';
import { pathReport } from '../../../scripts/eval/report';
import { cantCheckCause, cantCheckParts, caseKeyOf, corruptedByKind, flagRate, flaggedCases, judge, readInspection, tally, timeToShare } from '../../../scripts/eval/score';
import type { Inspection, RunFile } from '../../../scripts/eval/types';
import { result } from '../helpers/results';

function run(key: string, statuses: ('verified' | 'details_differ' | 'wrong_id' | 'retracted' | 'not_found' | 'cant_check')[], over: Partial<RunFile> = {}): RunFile {
  return {
    key,
    group: 'real',
    path: 'arxiv-html',
    title: key,
    referencesInPaper: statuses.length,
    refs: [],
    results: statuses.map((status, i) => result({ index: i + 1, status, reason: status === 'cant_check' ? "Couldn't read this reference reliably" : 'x' })),
    timing: { live: true, runMs: 1000, t90Ms: 900, firstResultMs: 100, requests: { live: 1, cached: 0, byHost: {} } },
    ...over,
  };
}

describe('why a reference is Can\'t check', () => {
  const reason = (text: string) => cantCheckCause(result({ status: 'cant_check', reason: text }));
  test.each([
    ['Lookup limit reached for OpenAlex. Try later', 'budget'],
    ["OpenAlex's free daily search limit is used up. Try again tomorrow.", 'budget'],
    ["Crossref's lookup limit is reached for now. Try again later.", 'budget'],
    ['Not a paper (website/software)', 'not_a_paper'],
    ['Not a journal or conference paper', 'not_a_paper'],
    ['Looks like a website or software, not a paper, so there is nothing to look up', 'not_a_paper'],
    ["Looks like a book or thesis, which these databases don't list reliably", 'not_a_paper'],
    ["Looks like a technical report, which these databases don't list reliably", 'not_a_paper'],
    ['Marked as unpublished, so these databases are not expected to list it', 'not_a_paper'],
    ['Marked as in preparation, so these databases may not list it yet', 'not_a_paper'],
    ["A private communication, which these databases don't list", 'not_a_paper'],
    ['This entry cites more than one work, and RefSure checks one work at a time', 'unreadable'],
    ['The record for this DOI or arXiv ID has no title to compare with. Try again later', 'source_unavailable'],
    ["Couldn't read this reference reliably", 'unreadable'],
    ['The journal, volume and page were read, but no Crossref record was found there', 'not_listed'],
    ["Couldn't confirm the identifier matches this reference", 'id_unconfirmed'],
    ["Couldn't search OpenAlex. Try again later", 'source_unavailable'],
    ['You appear to be offline. Check your connection and try again', 'source_unavailable'],
    ['something new', 'other'],
  ])('%s is %s', (text, cause) => {
    expect(reason(text)).toBe(cause);
  });
});

describe('tallies', () => {
  test('count statuses and Can\'t check causes; a paper that failed counts as a paper, not as references', () => {
    const t = tally([run('a', ['verified', 'verified', 'not_found', 'cant_check']), run('b', [], { error: 'no references' }), run('c', [])]);
    expect(t.papers).toBe(3);
    expect(t.failedPapers).toBe(2);
    expect(t.refs).toBe(4);
    expect(t.counts).toMatchObject({ verified: 2, not_found: 1, cant_check: 1 });
    expect(t.cantCheck.unreadable).toBe(1);
  });
});

describe('what is looked at by hand', () => {
  const runs = [run('arxiv-html:1', ['verified', 'not_found', 'wrong_id', 'retracted', 'details_differ'])];

  test('Not found, Wrong ID and Retracted on real papers are flagged; nothing else is', () => {
    expect(flaggedCases(runs).map((c) => c.index)).toEqual([2, 3, 4]);
  });

  test('synthetic lists are never flagged for inspection', () => {
    expect(flaggedCases([run('corrupted', ['not_found'], { group: 'corrupted' })])).toEqual([]);
  });

  test('a case is a false positive when the reference turned out to be real, confirmed when it is faulty, pending when not looked at', () => {
    const inspection: Inspection = {
      [caseKeyOf('arxiv-html:1', 2)]: { verdict: 'real', cause: 'book', note: '' },
      [caseKeyOf('arxiv-html:1', 3)]: { verdict: 'problem', cause: 'wrong DOI in the paper', note: '' },
    };
    const judged = judge(flaggedCases(runs), inspection);
    expect(judged.falsePositives.map((c) => c.index)).toEqual([2]);
    expect(judged.confirmed.map((c) => c.index)).toEqual([3]);
    expect(judged.pending.map((c) => c.index)).toEqual([4]);
  });
});

describe('the quality bar', () => {
  // 100 references: 2 Not found (one real, one faulty), 3 Details differ, 4 Can't check.
  const statuses = [...Array<'verified'>(91).fill('verified'), 'not_found', 'not_found', 'details_differ', 'details_differ', 'details_differ', 'cant_check', 'cant_check', 'cant_check', 'cant_check'] as const;
  const runs = [run('arxiv-html:1', [...statuses])];
  const notFound = flaggedCases(runs).map((c) => c.caseKey);

  test('with every flagged case inspected, only the real references count against the bar', () => {
    const inspection: Inspection = {
      [notFound[0] ?? '']: { verdict: 'real', cause: 'book', note: '' },
      [notFound[1] ?? '']: { verdict: 'problem', cause: 'nonexistent', note: '' },
    };
    const report = pathReport('x', 'arxiv-html', runs, inspection);
    expect(report.pending).toBe(0);
    expect(report.falsePositives).toBe(1);
    expect(report.notFoundOrWrongIdRate).toBeCloseTo(0.01);
    expect(report.pass).toBe(true);
  });

  test('with cases still to inspect, the labels as they are decide (2% misses the 1% bar)', () => {
    const report = pathReport('x', 'arxiv-html', runs, {});
    expect(report.pending).toBe(2);
    expect(report.notFoundOrWrongIdRate).toBeCloseTo(0.02);
    expect(report.pass).toBe(false);
  });

  test('the PDF bar is looser than the HTML bar for the same numbers', () => {
    expect(pathReport('x', 'arxiv-pdf', runs, {}).pass).toBe(true);
  });

  test('Details differ and Can\'t check are held to their own limits', () => {
    const many = [run('arxiv-html:2', [...Array<'verified'>(80).fill('verified'), ...Array<'cant_check'>(20).fill('cant_check')])];
    const report = pathReport('x', 'arxiv-html', many, {});
    expect(report.cantCheckRate).toBeCloseTo(0.2);
    expect(report.pass).toBe(false);
  });
});

describe('the synthetic sets', () => {
  test('anything but Verified counts as flagged', () => {
    const rate = flagRate([result({ status: 'verified' }), result({ status: 'details_differ' }), result({ status: 'cant_check' })]);
    expect(rate).toMatchObject({ total: 3, flagged: 2 });
  });

  test('corrupted citations are grouped by the kind of corruption', () => {
    const kinds = new Map([
      [1, 'wrong_year' as const],
      [2, 'wrong_year' as const],
      [3, 'wrong_doi' as const],
    ]);
    const by = corruptedByKind([result({ index: 1, status: 'details_differ' }), result({ index: 2, status: 'verified' }), result({ index: 3, status: 'wrong_id' })], (i) => kinds.get(i));
    expect(by.get('wrong_year')).toMatchObject({ total: 2, flagged: 1 });
    expect(by.get('wrong_doi')).toMatchObject({ total: 1, flagged: 1 });
  });
});

describe('time until most results have arrived', () => {
  test('is when the 90th percentile result came in, whatever order they are given in', () => {
    expect(timeToShare([5000, 1000, 2000, 3000, 4000, 6000, 7000, 8000, 9000, 10_000], 10)).toBe(9000);
  });
  test('is unknown when fewer than 90% arrived', () => {
    expect(timeToShare([1000, 2000], 10)).toBeNull();
    expect(timeToShare([], 0)).toBeNull();
  });
});

// Can't check shown all-in (the gate) and split into what no engine could check (judged by hand),
// what a better engine could (books included), and what the budget or a silent source left unchecked.
describe('the parts of Can\'t check', () => {
  const reasons = [
    "Couldn't read this reference reliably",
    "Looks like a book or thesis, which these databases don't list reliably",
    "OpenAlex's free daily search limit is used up. Try again tomorrow.",
    "Couldn't search OpenAlex. Try again later",
    'Looks like a website or software, not a paper, so there is nothing to look up',
  ];
  const paper: RunFile = {
    ...run('arxiv-html:1', ['cant_check', 'cant_check', 'cant_check', 'cant_check', 'cant_check', 'verified']),
  };
  paper.results = paper.results.map((r, i) => (r.status === 'cant_check' ? { ...r, reason: reasons[i] ?? r.reason } : r));

  // A source that did not answer ("Couldn't search OpenAlex") has its own part, apart from the budget, so a source or
  // engine bug cannot hide behind the budget.
  test('a case judged out of scope by hand counts there, whatever its reason; the rest by reason', () => {
    const parts = cantCheckParts([paper], new Set(['arxiv-html:1#5']));
    expect(parts).toEqual({ outOfScope: 1, engine: 2, budget: 1, unavailable: 1 });
  });

  test('only a lookup limit counts as budget', () => {
    const odd: RunFile = { ...paper, results: paper.results.map((r, i) => (i === 3 ? { ...r, reason: 'The record for this DOI or arXiv ID has no title to compare with. Try again later' } : r)) };
    expect(cantCheckParts([odd], new Set())).toMatchObject({ budget: 1, unavailable: 1 });
  });

  test('a "not a paper" label the engine gave is no judgement: a book is an engine shortfall', () => {
    expect(cantCheckParts([paper], new Set()).engine).toBe(3);
  });

  test('a judged case that is not Can\'t check any more counts nowhere', () => {
    expect(cantCheckParts([paper], new Set(['arxiv-html:1#6']))).toEqual({ outOfScope: 0, engine: 3, budget: 1, unavailable: 1 });
  });

  test('the out-of-scope list is read from inspection.json beside the cases', () => {
    const { cases, outOfScope } = readInspection({ 'arxiv-html:1#2': { verdict: 'real', cause: 'c', note: 'n' }, outOfScope: [{ case: 'arxiv-html:1#5', kind: 'website', note: 'n' }] });
    expect(Object.keys(cases)).toEqual(['arxiv-html:1#2']);
    expect([...outOfScope]).toEqual(['arxiv-html:1#5']);
    expect([...readInspection({}).outOfScope]).toEqual([]);
  });

  test('new reasons have their own cause', () => {
    const reason = (text: string) => cantCheckCause(result({ status: 'cant_check', reason: text }));
    expect(reason("Not in Crossref, arXiv, OpenReview or OpenAlex, and it names no journal or conference: reports, manuals, news and other works like it are often not listed there")).toBe('not_listed');
    expect(reason("Not in Crossref, arXiv, OpenReview or OpenAlex, and no journal or conference could be read from it: reports, manuals, news and other works like it are often not listed there")).toBe('not_listed');
    expect(reason("Looks like an IACR ePrint preprint, which these databases don't list reliably")).toBe('not_listed');
    expect(reason('Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk, slides or other material from a meeting: such works are often not listed there')).toBe('not_listed');
    expect(reason("Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as legislation, a dataset or an agency's document: such works are often not listed there")).toBe('not_listed');
    expect(reason('Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk about software at a technology conference, cited with its code repository: such works are often not listed there')).toBe('not_listed');
    expect(reason('Not in Crossref, arXiv, OpenReview or OpenAlex, and it was published before 1970: older journals are often not indexed there')).toBe('not_listed');
    expect(reason("The matched record is marked as retracted, but the retraction notice couldn't be looked up. Try again later")).toBe('source_unavailable');
  });
});
