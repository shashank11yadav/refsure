import { describe, expect, test } from 'vitest';
import { classify, effectiveCitation, isNamesAndVenue } from '../../../src/core/classify';
import { resplitWithRecord } from '../../../src/core/reread';
import { authorOverlap, titleSimilarity } from '../../../src/core/normalize';
import { parseCitation } from '../../../src/core/parseCitation';
import { yearAgrees } from '../../../src/core/years';
import { arxivOtherYears } from '../../../src/sources/arxiv';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const ALL = [...REQUIRED_SOURCES];

function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return { source: 'crossref', title: 'A title', authors: [], isRetracted: false, notes: [], ...over };
}

function parsed(text: string): ParsedCitation {
  return effectiveCitation(parseCitation({ index: 1, label: '[1]', text }));
}

describe('arXiv journal reference years', () => {
  test('the year of the journal version is another date of the work', () => {
    expect(arxivOtherYears(1993, 'Phys.Rept.254:1-133,1995')).toEqual([1995]);
    expect(arxivOtherYears(2001, 'JHEP 0304 (2003) 021')).toEqual([2003]);
    expect(arxivOtherYears(2016, 'JHEP 1705:118, 2017')).toEqual([2017]);
  });
  test('volumes, pages and far-off numbers are not years', () => {
    expect(arxivOtherYears(2016, 'Phys. Rev. D 94, 106002')).toEqual([]);
    expect(arxivOtherYears(2016, 'Nucl.Phys. B474 (1996) 122-140')).toEqual([]);
    expect(arxivOtherYears(2016, undefined)).toEqual([]);
  });
});

describe('year tolerance with an arXiv version', () => {
  const c: ParsedCitation = { raw: 'r', title: 'T', authors: [], year: 2016, kind: 'paper', confidence: 0.9 };
  test('two years apart agree when the work has an arXiv version', () => {
    expect(yearAgrees(c, record({ source: 'arxiv', year: 2014, arxivId: '1411.0690' }))).toBe(true);
    expect(yearAgrees({ ...c, arxivId: '1411.0690' }, record({ year: 2014, otherVersion: { arxivId: '1411.0690' } }))).toBe(true);
  });
  // An arXiv id that only the reference gives opens no two-year window and lends no date to the work: nothing shows
  // that it exists or belongs to this record.
  test('an arXiv id that only the reference gives is no arXiv version of the record', () => {
    expect(yearAgrees({ ...c, arxivId: '1411.0690' }, record({ year: 2014 }))).toBe(false);
    expect(yearAgrees({ ...c, year: 2017, arxivId: '1709.99999' }, record({ year: 2015 }))).toBe(false);
  });
  test('without one, the tolerance stays one year', () => {
    expect(yearAgrees(c, record({ year: 2014 }))).toBe(false);
    expect(yearAgrees(c, record({ year: 2015 }))).toBe(true);
  });
  test('three years apart never agree', () => {
    expect(yearAgrees(c, record({ source: 'arxiv', year: 2013, arxivId: '1311.0001' }))).toBe(false);
  });
});

describe('a title-less entry with an identifier is checked by the identifier', () => {
  test('names and a venue are not a title', () => {
    expect(isNamesAndVenue('E. Bousquet, M. Fava, and A. H. Romero, Journal of Physics: Condensed Matter (2024), 10.1088/1361-648X/adb674')).toBe(true);
    expect(isNamesAndVenue('D. Sivan and M. Tsodyks, arXiv preprint arXiv:2411.12728')).toBe(true);
    expect(isNamesAndVenue('H. Watanabe, H. C. Po, and A. Vishwanath, Science Advances 4 (2018), 10.1126/sciadv.aat8685')).toBe(true);
  });
  test('a real title is still a title', () => {
    expect(isNamesAndVenue('Attention is all you need')).toBe(false);
    expect(isNamesAndVenue('P. Kehayias et al., Measurement and simulation of the magnetic fields, Phys')).toBe(false);
  });
  test('Verified when the author zone names the record authors', () => {
    const c = parsed('D. Sivan and M. Tsodyks, arXiv preprint arXiv:2411.12728 (2024).');
    expect(c.title).toBeUndefined();
    const r = record({ source: 'arxiv', title: 'Information Theory of Meaningful Communication', authors: ['sivan', 'tsodyks'], year: 2024, arxivId: '2411.12728' });
    expect(classify({ citation: c, match: r, matchedVia: 'id', idResolvedTo: r, retraction: { retracted: false }, searched: ALL, failed: [] }).status).toBe('verified');
  });
  test('never Verified when the zone names other people', () => {
    const c = parsed('J. Roe and K. Moe, arXiv preprint arXiv:2411.12728 (2024).');
    const r = record({ source: 'arxiv', title: 'Information Theory of Meaningful Communication', authors: ['sivan', 'tsodyks'], year: 2024, arxivId: '2411.12728' });
    expect(classify({ citation: c, match: r, matchedVia: 'id', idResolvedTo: r, searched: ALL, failed: [] }).status).toBe('cant_check');
  });
});

describe('the record shows where the author list ends', () => {
  const ganor = record({ source: 'arxiv', title: 'Small $E_8$ Instantons and Tensionless Non-critical Strings', authors: ['ganor', 'hanany'], year: 1996 });
  // A venue fragment left after the title ("Nucl") has to run straight into the venue the parser read, so the test
  // gives the reference as the parser sees it, raw text and venue included.
  test('names before the title', () => {
    const raw = 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, Nucl. Phys. B 474 (1996) 122.';
    const c: ParsedCitation = { raw, title: 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, Nucl', venue: 'Phys. B 474 (1996) 122', authors: [], year: 1996, kind: 'paper', confidence: 0.6 };
    const out = resplitWithRecord(c, ganor);
    expect(out.authors).toEqual(['ganor', 'hanany']);
    expect(titleSimilarity(out.title ?? '', ganor.title)).toBeGreaterThanOrEqual(0.9);
  });
  test('names after the title', () => {
    const r = record({ title: 'Reducing the Dimensionality of Data with Neural Networks', authors: ['hinton', 'salakhutdinov'], year: 2006 });
    const c: ParsedCitation = { raw: 'r', title: 'Reducing the dimensionality of data with neural networks; G. Hinton and R Salakhutdinov', authors: [], year: 2006, kind: 'paper', confidence: 0.5 };
    expect(resplitWithRecord(c, r).authors).toEqual(['hinton', 'salakhutdinov']);
  });
  test('other names around the title change nothing', () => {
    const c: ParsedCitation = { raw: 'r', title: 'J. Roe and K. Moe, Small E(8) instantons and tensionless noncritical strings, Nucl', authors: [], year: 1996, kind: 'paper', confidence: 0.6 };
    expect(resplitWithRecord(c, ganor)).toBe(c);
  });
  test('a title cut at a full stop is read whole when the reference writes the record title out', () => {
    const raw = 'Ian Langmore, Michael Dikovsky. Hamiltonian Monte Carlo in inverse problems. Ill-Conditioning and multimodality. IJUQ, 13(1), 2023.';
    const c: ParsedCitation = { raw, title: 'Hamiltonian Monte Carlo in inverse problems', authors: ['langmore', 'dikovsky'], year: 2023, kind: 'paper', confidence: 0.9 };
    const r = record({ title: 'HAMILTONIAN MONTE CARLO IN INVERSE PROBLEMS. ILL-CONDITIONING AND MULTIMODALITY', authors: ['langmore', 'dikovsky'], year: 2023 });
    expect(titleSimilarity(resplitWithRecord(c, r).title ?? '', r.title)).toBe(1);
  });
  test('a volume after the title is not part of it', () => {
    const c: ParsedCitation = { raw: 'r', title: 'Methods of information geometry, volume 191', authors: ['amari', 'nagaoka'], year: 2007, kind: 'paper', confidence: 0.9 };
    const r = record({ title: 'Methods of Information Geometry', authors: ['amari', 'nagaoka'], year: 2007 });
    expect(resplitWithRecord(c, r).title).toBe('methods of information geometry');
  });
});

describe('names and maths', () => {
  test('German spellings and compound surnames count', () => {
    expect(authorOverlap(['guhr', 'muller groeling', 'weidenmuller'], ['guhr', 'mueller groeling', 'weidenmueller'])).toBe(1);
    expect(authorOverlap(['sridhar'], ['rangarajan sridhar'])).toBe(1);
    expect(authorOverlap(['smith'], ['rangarajan sridhar'])).toBe(0);
  });
  test('LaTeX operators read like the symbols a database prints', () => {
    expect(titleSimilarity('On the sandpile group of the graph k_{3}\\times c_{n}', 'On the sandpile group of the graph K3×Cn')).toBe(1);
  });
});

// The re-read may only move words of the cited text between its title, author and venue parts. It never takes words
// from the record, and a cited title with words the record's title does not have must not become Verified through it.
describe('guard: the re-read never verifies an invented title', () => {
  const graphs = record({ title: 'Deep Learning Methods for Graphs', authors: ['smith', 'jones'], year: 2020 });
  const verdictOf = (c: ParsedCitation, r: WorkRecord, via: 'id' | 'search' = 'search'): string =>
    classify({ citation: c, match: r, matchedVia: via, ...(via === 'id' && { idResolvedTo: r }), retraction: { retracted: false }, searched: ALL, failed: [] }).status;
  const titled = (title: string, over: Partial<ParsedCitation> = {}): ParsedCitation => ({ raw: `${title}. Journal of Things 3, 1-10 (2020).`, title, authors: [], year: 2020, kind: 'paper', confidence: 0.6, ...over });

  test('the real title after the real names is read again', () => {
    const c = titled('J. Smith and A. Jones, Deep learning methods for graphs');
    expect(resplitWithRecord(c, graphs).authors).toEqual(['smith', 'jones']);
    expect(verdictOf(c, graphs)).toBe('verified');
  });

  test('an invented word in front of the real title is not taken for a given name', () => {
    const c = titled('J. Smith and A. Jones, Quantum deep learning methods for graphs');
    expect(resplitWithRecord(c, graphs)).toBe(c);
    expect(verdictOf(c, graphs)).not.toBe('verified');
  });

  test('an invented word set off by commas is not taken for a given name either', () => {
    const c = titled('J. Smith, A. Jones, Quantum, Deep learning methods for graphs');
    expect(resplitWithRecord(c, graphs)).toBe(c);
    expect(verdictOf(c, graphs)).not.toBe('verified');
  });

  test('an invented word after the real title is not taken for a venue or a name', () => {
    for (const title of ['Deep Learning Methods for Graphs Revisited; J. Smith and A. Jones', 'J. Smith and A. Jones, Deep learning methods for graphs revisited', 'J. Smith and A. Jones, Deep learning methods for graphs in the wild, Phys']) {
      const c = titled(title);
      expect(resplitWithRecord(c, graphs)).toBe(c);
      expect(verdictOf(c, graphs)).not.toBe('verified');
    }
  });

  test('a title that is part of the record title is not filled in from the record', () => {
    // The record's longer title does not stand in the reference, so the cited part stays as cited.
    const c: ParsedCitation = { raw: 'J. Smith and A. Jones. Deep learning methods. Journal of Things 3 (2020).', title: 'Deep learning methods', authors: ['smith', 'jones'], year: 2020, kind: 'paper', confidence: 0.9 };
    expect(resplitWithRecord(c, graphs)).toBe(c);
    expect(verdictOf(c, graphs)).not.toBe('verified');
  });

  test('an invented title with real authors and a real arXiv id stays non-Verified', () => {
    const attention = record({ source: 'arxiv', title: 'Attention Is All You Need', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017, arxivId: '1706.03762' });
    for (const text of [
      'A. Vaswani, N. Shazeer, and N. Parmar, Sparse attention for protein folding, arXiv:1706.03762 (2017).',
      'A. Vaswani, N. Shazeer, and N. Parmar, Attention is all you need for protein folding, arXiv:1706.03762 (2017).',
      'Vaswani, A., Shazeer, N., Parmar, N.: Attention is not all you need. arXiv:1706.03762 (2017)',
    ]) {
      const c = parsed(text);
      expect(c.title).toBeDefined();
      expect(verdictOf(c, attention, 'id')).not.toBe('verified');
    }
  });

  test('an invented title with real authors and a real DOI stays non-Verified', () => {
    const lecun = record({ title: 'Deep learning', authors: ['lecun', 'bengio', 'hinton'], year: 2015, doi: '10.1038/nature14539' });
    const c = parsed('Y. LeCun, Y. Bengio, and G. Hinton, Deep learning for quantum chemistry, Nature 521, 436 (2015), doi:10.1038/nature14539.');
    expect(verdictOf(c, lecun, 'id')).not.toBe('verified');
  });
});

describe('notices about a work are not the work', () => {
  const main = 'Computational Complexity and Black Hole Horizons';
  test.each([['Addendum to'], ['Erratum to'], ['Comment on'], ['Reply to'], ['Erratum:'], ['Corrigendum:']])('"%s X" and "X" are close, never the same title', (prefix) => {
    expect(titleSimilarity(`${prefix} ${main}`, main)).toBeLessThan(0.9);
    expect(titleSimilarity(main, `${prefix} ${main}`)).toBeLessThan(0.9);
    expect(titleSimilarity(`${prefix} ${main}`, `${prefix} ${main}`)).toBe(1);
  });
  test('a citation of X is not Verified by the addendum record, nor the addendum by the record of X', () => {
    const c: ParsedCitation = { raw: 'r', title: main, authors: ['susskind'], year: 2016, kind: 'paper', confidence: 0.9 };
    const addendum = record({ source: 'arxiv', title: `Addendum to ${main}`, authors: ['susskind'], year: 2014, arxivId: '1403.5695' });
    expect(classify({ citation: c, match: addendum, matchedVia: 'search', searched: ALL, failed: [] }).status).toBe('details_differ');
    expect(classify({ citation: { ...c, arxivId: '1403.5695' }, match: addendum, matchedVia: 'id', idResolvedTo: addendum, searched: ALL, failed: [] }).status).toBe('details_differ');
    const cited: ParsedCitation = { ...c, title: `Reply to ${main}` };
    expect(classify({ citation: cited, match: record({ title: main, authors: ['susskind'], year: 2016 }), matchedVia: 'search', searched: ALL, failed: [] }).status).toBe('details_differ');
  });
});

describe('the locator query keeps its own year window', () => {
  test('one year either side, whatever the matching tolerance', async () => {
    const { LOCATOR_YEAR_WINDOW, PREPRINT_YEAR_TOLERANCE, YEAR_TOLERANCE } = await import('../../../src/core/thresholds');
    expect([YEAR_TOLERANCE, PREPRINT_YEAR_TOLERANCE, LOCATOR_YEAR_WINDOW]).toEqual([1, 2, 1]);
  });
});
