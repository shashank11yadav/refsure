// References a database can check, which must not end in Can't check (parser, locator and identifier readings), and
// the ones that must stay Can't check.
import { describe, expect, test } from 'vitest';
import { classify, preLookupVerdict } from '../../../src/core/classify';
import { findArxivId } from '../../../src/core/identifiers';
import { journalLocator, locatorMatch } from '../../../src/core/journalLocator';
import { parseCitation } from '../../../src/core/parseCitation';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });
const ALL = [...REQUIRED_SOURCES];
const UNREADABLE = "Couldn't read this reference reliably";

describe('Springer style: "Surname, I.: Title. Journal vol, pages (year)"', () => {
  test('the colon after an initial ends the author list, so the entry has a title', () => {
    const c = parse('Gretton, A., Borgwardt, K.M., Rasch, M.J., Schölkopf, B., Smola, A.: A kernel two-sample test. J. Mach. Learn. Res. 13(1), 723–773 (2012)');
    expect(c.title).toBe('A kernel two-sample test');
    expect(c.authors.slice(0, 2)).toEqual(['gretton', 'borgwardt']);
  });

  test('a title-less journal citation stays title-less', () => {
    expect(parse('C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)').title).toBeUndefined();
  });
});

describe('an eprint printed alone in square brackets (INSPIRE, JHEP)', () => {
  test('is an arXiv id when it has a real year and month', () => {
    expect(findArxivId('T. Weigand, F-theory, PoS TASI2017 (2018) 016 [1806.01854].')).toBe('1806.01854');
    expect(findArxivId('JHEP 03 (2022) 054 [2201.04634v2]')).toBe('2201.04634v2');
  });

  test('is not when the entry prints several (an erratum or a companion paper with its own id)', () => {
    expect(findArxivId('A. Roe, Title one, JHEP 03 (2022) 054 [2201.04634]; Erratum: JHEP 05 (2022) 001 [2203.00001].')).toBeUndefined();
    expect(findArxivId('A. Roe, Title one, JHEP 03 (2022) 054 [2201.04634]; B. Moe, Title two, JHEP 04 (2022) 012 [2202.11111].')).toBeUndefined();
    expect(findArxivId('A. Roe, Title one, JHEP 03 (2022) 054 [2201.04634]; Erratum ibid. [2201.04634v2].')).toBe('2201.04634');
  });

  test('is not when the month is impossible or the number is not in brackets', () => {
    expect(findArxivId('Proc. 12 [1813.01854]')).toBeUndefined();
    expect(findArxivId('pages 1806.01854 to 1807')).toBeUndefined();
  });
});

describe('one long entry with one identifier', () => {
  const authors = Array.from({ length: 220 }, (_, i) => `Author${String.fromCharCode(65 + (i % 26))} Name${i}`).join(', ');

  test('hundreds of authors and one arXiv id are one work, looked up by the id', () => {
    const c: ParsedCitation = { raw: `DeepSeek-AI, ${authors}. DeepSeek-V3 technical report, 2024. arXiv:2412.19437.`, authors: [], arxivId: '2412.19437', year: 2024, kind: 'paper', confidence: 0.2 };
    expect(c.raw.length).toBeGreaterThan(1000);
    expect(preLookupVerdict(c)).toBeUndefined();
  });

  test('several identifiers or several years are still several references run together', () => {
    const two: ParsedCitation = { raw: `${authors}. One, 2019. arXiv:1901.00001. Two, 2020. arXiv:2001.00002.`, authors: [], arxivId: '1901.00001', kind: 'paper', confidence: 0.2 };
    expect(preLookupVerdict(two)?.reason).toBe(UNREADABLE);
    const years: ParsedCitation = { raw: `${authors}. One, 2019. Two, 2020. arXiv:1901.00001.`, authors: [], arxivId: '1901.00001', kind: 'paper', confidence: 0.2 };
    expect(preLookupVerdict(years)?.reason).toBe(UNREADABLE);
  });

  // The author list is read piece by piece; a long run of capitals with no space must not make that slow, whether the
  // run is too long to be a name or just short enough to be tested as one.
  test.each([[3980], [199]])('a run of %i capitals in front of the identifier is read in linear time', (run) => {
    const raw = `${'A'.repeat(run)}! ${'x '.repeat(Math.max(0, 520 - run / 2))}arXiv:2101.00001`;
    const c: ParsedCitation = { raw, authors: [], arxivId: '2101.00001', kind: 'paper', confidence: 0.2 };
    expect(raw.length).toBeGreaterThan(1000);
    expect(raw.length).toBeLessThanOrEqual(4000);
    const start = performance.now();
    preLookupVerdict(c);
    expect(performance.now() - start).toBeLessThan(100);
  });

  test('a name piece still reads as before: up to four capitalised words, after an optional "and" or "&"', () => {
    const lookup = (names: string): string | undefined => {
      const raw = `${names}, B. Other, C. Person, ${'Author Name, '.repeat(80)}Title, 2024. arXiv:2101.00001.`;
      return preLookupVerdict({ raw, authors: [], arxivId: '2101.00001', kind: 'paper', confidence: 0.2 })?.reason;
    };
    // The first piece is a name, so "B. Other, C. Person" after it is part of the one author list.
    expect(lookup('A. B. Name')).toBeUndefined();
    expect(lookup('and DeepSeek-AI')).toBeUndefined();
    expect(lookup('& Mary Ann Van Dyke')).toBeUndefined();
    // Five words, or a lower-case word, are not a name: the pair after them reads as another reference's authors.
    expect(lookup('One Two Three Four Five')).toBe(UNREADABLE);
    expect(lookup('A. van Name')).toBe(UNREADABLE);
  });
});

describe('an author called Press is not a publisher', () => {
  test.each([['W. H. Press, Astrophys. J. 170, L105 (1971).'], ['W. Press and K. Thorne, Annu. Rev. Astron. Astrophys. 10, 335 (1972).']])('%s is a journal citation', (text) => {
    const c = parse(text);
    expect(c.kind).not.toBe('book');
    expect(journalLocator(c)).toBeDefined();
  });

  test.each([
    ['S. Weinberg, The quantum theory of fields: modern applications, Vol. 2 (Cambridge U. Press, 1996).'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (Princeton U. Press, Princeton, 1999).'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (Princeton U. Press, Princeton, 1999), p. 123.'],
    ['R. Feynman, Quantum electrodynamics and path integrals in physics, Oxford U. Press, 1985.'],
    ['S. Weinberg, The Quantum Theory of Fields and its many applications (Cambridge U. P. Press, 1995).'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (Harvard U. Press, Cambridge, MA, 1999).'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (Oxford Univ. Press, 1999).'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (Princeton U. Press, 1999), Vol. 2.'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (Cambridge University Press, 1999), pp. 12–15.'],
    ['J. Doe, Statistical mechanics of disordered elastic systems (MIT Press, Cambridge, MA, 1999).'],
    ['Doe, J. (1999). Statistical mechanics of disordered elastic systems. Princeton U. Press.'],
  ])('"U. Press", "Univ. Press" and a page or volume after the imprint are a publisher: %s', (text) => {
    expect(parse(text).kind).toBe('book');
    expect(preLookupVerdict(parse(text))?.reason).toMatch(/book or thesis/);
  });

  test('a real author named Press with a publisher is still a book', () => {
    expect(parse('W. H. Press, S. A. Teukolsky, W. T. Vetterling and B. P. Flannery, Numerical Recipes: The Art of Scientific Computing (Cambridge U. Press, 2007).').kind).toBe('book');
    expect(parse('Press, W. H., Teukolsky, S. A. (2007). Numerical Recipes. Cambridge University Press.').kind).toBe('book');
  });

  test('a page range in a proceedings with a press is still a paper', () => {
    expect(parse('J. Doe, Learning to rank, in Proceedings of the Annual Meeting (ACM Press, 2005), pp. 12–19.').kind).toBe('paper');
    expect(parse('J. Doe, Learning to rank, J. Mach. Learn. Res. 5, 12 (2005).').kind).not.toBe('book');
  });

  test('a publisher called Press still makes a book', () => {
    expect(parse('W. H. Press, S. A. Teukolsky, W. T. Vetterling and B. P. Flannery, Numerical Recipes (Cambridge University Press, 2007).').kind).toBe('book');
    expect(parse('N. Cowan, Working memory capacity (Psychology press, 2012).').kind).toBe('book');
  });
});

describe('Springer Science & Business Media is a book publisher', () => {
  test('its "Science" is not a journal', () => {
    expect(parse('Achim Klenke. Probability theory: a comprehensive course. Springer Science & Business Media, 2013.').kind).toBe('book');
    expect(parse('P. Bak. How nature works: the science of self-organized criticality. Springer Science+Business Media, 2013.').kind).toBe('book');
  });

  test('a journal named Science is still a journal', () => {
    expect(parse('J. Roe and K. Moe. Measuring things well. Science 276, 2012–2014 (1997).').kind).toBe('paper');
  });
});

describe('an IACR ePrint preprint', () => {
  const text = 'E. Heilman et al. (2023) OpenPubkey: Augmenting OpenID connect with user held signing keys. Note: https://eprint.iacr.org/2023/296';

  test('is not called a website, and is never Not found', () => {
    const v = preLookupVerdict(parse(text));
    expect(v?.status).toBe('cant_check');
    expect(v?.reason).not.toMatch(/website/i);
    expect(v?.reason).toMatch(/ePrint/);
  });
});

describe('Crossref journal names with an escaped ampersand', () => {
  test('"Perception &amp; Psychophysics" is the cited "Perception and Psychophysics"', () => {
    const c = parse('J. S. Sachs, Perception and Psychophysics 2, 437 (1967).');
    const locator = journalLocator(c);
    expect(locator).toBeDefined();
    if (locator === undefined) return;
    const r: WorkRecord = { source: 'crossref', title: 'Recognition memory for syntactic and semantic aspects of connected discourse', authors: ['sachs'], year: 1967, venue: 'Perception &amp; Psychophysics', venues: ['Perception &amp; Psychophysics'], volume: '2', pages: ['437'], doi: '10.3758/bf03208784', isRetracted: false, notes: [] };
    expect(locatorMatch(c, locator, [r])).toBe(r);
  });
});

describe('a "title" that can never be Not found', () => {
  test('is unreadable whatever source could not answer', () => {
    const c: ParsedCitation = { raw: 'X. Zhang, Deep residual learning for image recognition, CVPR 2016.', title: 'X. Zhang, Deep residual learning for image recognition', authors: [], year: 2016, kind: 'paper', confidence: 0.6 };
    expect(classify({ citation: c, searched: ['crossref', 'arxiv', 'openreview'], failed: ['openalex'] }).reason).toBe(UNREADABLE);
    expect(classify({ citation: c, searched: ALL, failed: [] }).reason).toBe(UNREADABLE);
  });
});
