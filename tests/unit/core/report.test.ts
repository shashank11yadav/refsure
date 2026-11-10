import { describe, expect, test } from 'vitest';
import { resultLinks, toCsv, toJson, toPlainTextReport } from '../../../src/core/report';
import type { CheckResult } from '../../../src/core/types';
import { paper, result, summaryOf } from '../helpers/results';

const results: CheckResult[] = [
  result({ index: 1, status: 'verified' }),
  result({ index: 2, status: 'not_found', reason: 'Not found in Crossref, arXiv, OpenReview or OpenAlex', sourcesSearched: ['crossref', 'arxiv', 'openreview', 'openalex'] }),
  result({
    index: 3,
    status: 'details_differ',
    reason: 'Year differs',
    diffs: [{ field: 'year', cited: '2018', actual: '2019' }],
    links: [{ label: 'DOI', url: 'https://doi.org/10.1000/xyz' }],
    notes: ['Note: withdrawn by authors on arXiv'],
  }),
  result({ index: 4, status: 'retracted', reason: 'Retracted: the cited version carries a retraction notice' }),
  result({ index: 5, status: 'wrong_id', reason: 'This DOI points to a different paper than the title cited' }),
  result({ index: 6, status: 'cant_check', reason: 'Not a paper' }),
];
const p = paper();
const summary = summaryOf(p, results);

describe('toPlainTextReport', () => {
  test('starts with the RefSure line and the paper title', () => {
    const text = toPlainTextReport(summary, results);
    expect(text).toMatch(/^RefSure check — /);
    expect(text.split('\n')[0]).toContain('Attention Is All You Need');
  });

  test('never uses accusing words', () => {
    expect(toPlainTextReport(summary, results)).not.toMatch(/fake|hallucinat/i);
  });

  test('lists problems before verified references and shows a totals line', () => {
    const text = toPlainTextReport(summary, results);
    expect(text).toContain('1 verified');
    expect(text).toContain('1 retracted');
    expect(text.indexOf('Retracted')).toBeLessThan(text.indexOf('Verified'));
    expect(text.indexOf('Not found')).toBeLessThan(text.indexOf("Can't check"));
  });

  test('includes the reason, the differences, notes and the match link', () => {
    const text = toPlainTextReport(summary, results);
    expect(text).toContain('Year differs');
    expect(text).toContain('    Year: cited 2018, found 2019');
    expect(text).toContain('Note: withdrawn by authors on arXiv');
    expect(text).toContain('https://doi.org/10.1000/xyz');
  });

  test('a stopped check says how far it got', () => {
    const text = toPlainTextReport(summary, results, { stoppedAfter: { checked: 5, total: 40 } });
    expect(text).toContain('Stopped after 5 of 40 references');
    // The totals line counts what was checked, not what was left: "5 of 40 references checked: ...".
    expect(text).toContain('5 of 40 references checked: ');
    expect(text).not.toMatch(/^40 references: /m);
    expect(toPlainTextReport(summary, results)).not.toContain('Stopped after');
    expect(toPlainTextReport(summary, results)).toMatch(/^\d+ references: /m);
  });

  test('a stopped check of one reference reads "1 of 40 references checked"', () => {
    expect(toPlainTextReport(summary, results, { stoppedAfter: { checked: 1, total: 40 } })).toContain('1 of 40 references checked: ');
  });

  test('says when the arXiv version or the PDF was used', () => {
    const viaArxiv = summaryOf(paper({ origin: 'openreview', key: 'openreview:abc123', viaArxivVersion: '1706.03762' }), results);
    expect(toPlainTextReport(viaArxiv, results)).toContain('Checked using the arXiv version (arXiv:1706.03762)');
    const viaPdf = summaryOf(paper({ viaPdf: true }), results);
    expect(toPlainTextReport(viaPdf, results)).toContain('References read from the PDF');
  });
});

describe('toCsv', () => {
  test('neutralises a formula and quotes the cell', () => {
    const csv = toCsv([result({ citedText: '=HYPERLINK("http://x")' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  test.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('prefixes an apostrophe to a cell that starts with %j', (cell) => {
    const csv = toCsv([result({ reason: cell })]);
    expect(csv).toContain(`"'${cell}"`);
  });

  test('does not touch ordinary text, and doubles quotes and keeps newlines inside quotes', () => {
    const csv = toCsv([result({ citedText: 'He said "hi",\nthen left' })]);
    expect(csv).toContain('"He said ""hi"",\nthen left"');
    expect(csv).not.toContain("'He said");
  });

  test('quotes every cell, also plain ones, so a split on ";" cannot start a formula', () => {
    const csv = toCsv([result({ index: 7, citedText: "Smith J. A study;=cmd|' /C calc'!A0" })]);
    const dataRow = csv.split('\r\n')[1] ?? '';
    expect(dataRow.startsWith('"7","[7]","Verified",')).toBe(true);
    expect(dataRow).toContain(`"Smith J. A study;=cmd|' /C calc'!A0"`);
    expect(csv.split('\r\n')[0]).toBe('"Number","Label","Status","Reason","Cited reference","Matched title","Matched year","Matched DOI","Matched arXiv ID","Differences","Notes","Links","Sources searched","Sources not reached"');
  });

  test('uses the same field and source names as the panel', () => {
    const csv = toCsv([
      result({ status: 'details_differ', diffs: [{ field: 'year', cited: '2018', actual: '2019' }], sourcesSearched: ['arxiv', 'crossref', 'openalex'], sourcesFailed: ['openreview', 'dblp'] }),
    ]);
    expect(csv).toContain('"Year: cited 2018, found 2019"');
    expect(csv).toContain('"arXiv; Crossref; OpenAlex"');
    expect(csv).toContain('"OpenReview; DBLP"');
  });

  test('has a header row and one row per result, using CRLF between rows', () => {
    const csv = toCsv(results);
    const lines = csv.split('\r\n');
    expect(lines[0]).toMatch(/^"Number",/);
    expect(lines.filter((l) => l !== '')).toHaveLength(1 + results.length);
  });

  test('neutralises the matched title and the differences too', () => {
    const csv = toCsv([result({ status: 'details_differ', diffs: [{ field: 'title', cited: '=evil()', actual: '@bad' }], match: { source: 'crossref', title: '=Matched()', authors: [], isRetracted: false, notes: [] } })]);
    expect(csv).toContain("'=Matched()");
    expect(csv).not.toMatch(/(^|,|\r\n)"?=Matched/);
  });
});

describe('a malformed match', () => {
  test('cannot throw in the CSV and leaves no object text in it', () => {
    const bad = { source: 'crossref', title: { evil: 1 }, year: { y: 1 }, doi: 42, arxivId: ['x'], authors: 'x', isRetracted: false, notes: [] } as unknown as CheckResult['match'];
    const csv = toCsv([result({ match: bad })]);
    expect(csv).not.toContain('[object Object]');
    expect(() => toJson(summary, [result({ match: bad })])).not.toThrow();
  });
});

describe('toJson', () => {
  test('is valid JSON with the paper, the counts and every result', () => {
    const parsed = JSON.parse(toJson(summary, results)) as { paper: { title: string }; counts: Record<string, number>; results: unknown[] };
    expect(parsed.paper.title).toBe('Attention Is All You Need');
    expect(parsed.counts['verified']).toBe(1);
    expect(parsed.results).toHaveLength(6);
  });

  test('carries no key and no settings', () => {
    const settings = { openAlexKey: 'sk-secret-key-0123456789', autoCheckArxiv: true };
    const json = toJson(summary, results);
    expect(json).not.toContain(settings.openAlexKey);
    expect(json).not.toMatch(/openAlexKey|autoCheck|settings/);
  });
});

describe('a link to the matched record when it has no DOI', () => {
  type Match = NonNullable<CheckResult['match']>;
  const record = (over: Partial<Match>): Match => ({ source: 'openalex', title: 'A study of things', authors: ['roe'], year: 2019, isRetracted: false, notes: [], ...over });
  const openalexOnly = result({ index: 7, match: record({ openalexId: 'W2626778328' }) });
  const dblpOnly = result({ index: 8, match: record({ source: 'dblp', dblpKey: 'conf/nips/VaswaniSPUJGKP17' }) });

  test('an OpenAlex or DBLP match with no DOI, arXiv or OpenReview link gets its record page', () => {
    expect(resultLinks(openalexOnly)).toEqual([{ label: 'OpenAlex', url: 'https://openalex.org/works/W2626778328' }]);
    expect(resultLinks(dblpOnly)).toEqual([{ label: 'DBLP', url: 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17' }]);
  });

  test('the DOI (or arXiv, or OpenReview) link is preferred when there is one', () => {
    const withDoi = result({ match: record({ doi: '10.1000/xyz', openalexId: 'W1' }), links: [{ label: 'DOI', url: 'https://doi.org/10.1000/xyz' }] });
    expect(resultLinks(withDoi)).toEqual(withDoi.links);
    const withArxiv = result({ match: record({ source: 'dblp', arxivId: '1706.03762', dblpKey: 'conf/nips/X17' }), links: [{ label: 'arXiv', url: 'https://arxiv.org/abs/1706.03762' }] });
    expect(resultLinks(withArxiv)).toEqual(withArxiv.links);
  });

  test('a retraction notice alone does not count as a link to the matched record', () => {
    const notice = { label: 'Retraction notice', url: 'https://doi.org/10.1000/notice' };
    expect(resultLinks(result({ status: 'retracted', match: record({ openalexId: 'W5' }), links: [notice] }))).toEqual([{ label: 'OpenAlex', url: 'https://openalex.org/works/W5' }, notice]);
  });

  test('no link from an id of the wrong shape, from another source\'s record, or without a match', () => {
    const odd: unknown[] = ['W1/../../evil', 'https://evil.example/W1', 'A123', 42, { toString: () => 'W1' }, ['W1']];
    for (const openalexId of odd) expect(resultLinks(result({ match: record({ openalexId: openalexId as string }) })), String(openalexId)).toEqual([]);
    for (const dblpKey of ['../../evil', 'conf/x/a?b', 'https://evil.example/conf/a/b', 7]) {
      expect(resultLinks(result({ match: record({ source: 'dblp', dblpKey: dblpKey as string }) })), String(dblpKey)).toEqual([]);
    }
    expect(resultLinks(result({ match: record({ source: 'crossref', openalexId: 'W1' }) }))).toEqual([]);
    expect(resultLinks(result({ match: record({ source: 'openalex', dblpKey: 'conf/nips/X17' }) }))).toEqual([]);
    expect(resultLinks(result({ links: [] }))).toEqual([]);
    expect(resultLinks(result({ match: 'W1' as unknown as Match }))).toEqual([]);
  });

  test('the plain-text report, the CSV and the JSON all carry it', () => {
    const rs = [openalexOnly, dblpOnly];
    const s = summaryOf(p, rs);
    const text = toPlainTextReport(s, rs);
    expect(text).toContain('    OpenAlex: https://openalex.org/works/W2626778328');
    expect(text).toContain('    DBLP: https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17');
    const csv = toCsv(rs);
    expect(csv).toContain('"https://openalex.org/works/W2626778328"');
    expect(csv).toContain('"https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17"');
    const parsed = JSON.parse(toJson(s, rs)) as { results: CheckResult[] };
    expect(parsed.results.map((r) => r.links)).toEqual([[{ label: 'OpenAlex', url: 'https://openalex.org/works/W2626778328' }], [{ label: 'DBLP', url: 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17' }]]);
  });
});
