import { describe, expect, test } from 'vitest';
import { journalLocator, journalNameLead, locatorKey, locatorMatch, locatorQuery, matchesLocator } from '../../../src/core/journalLocator';
import { parseCitation } from '../../../src/core/parseCitation';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });

function record(over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    source: 'crossref',
    title: 'Some article',
    authors: ['brans', 'dicke'],
    year: 1961,
    venue: 'Physical Review',
    venues: ['Physical Review', 'Phys. Rev.'],
    volume: '124',
    pages: ['925'],
    doi: '10.1103/physrev.124.925',
    isRetracted: false,
    notes: [],
    ...over,
  };
}

describe('journalLocator: reading the locator of a citation with no title', () => {
  test.each([
    ['C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)', '124', '925', 1961],
    ['E.V. Linder, Phys. Rev. D81, 127301 (2010)', '81', '127301', 2010],
    ['A. Fert, N. Reyren, and V. Cros, Nature Reviews Materials 2, 1 (2017).', '2', '1', 2017],
    ['A. Georgiou, T. Can, M. Katkov, and M. Tsodyks, Learning & Memory 32, a054043 (2025).', '32', 'a054043', 2025],
    ['A. Starobinsky, Phys. Lett. B 91(1), 99 (1980)', '91', '99', 1980],
    ['G. Amelino-Camelia, M. Arzano, Phys. Rev. D 88(4), 041303 (2013)', '88', '41303', 2013],
    ['C. Johnson, Phys. Rev. D 101, no.10, 106023 (2020)', '101', '106023', 2020],
    ['T. Moriya, Physical review 120, 91 (1960).', '120', '91', 1960],
    ['E. Levine, M. Turner, Nanophotonics 8 (Nov., 2019) 1945–1973.', '8', '1945', 2019],
    ['A. Gruber, C. v. Borczyskowski, Science 276 (June, 1997) 2012–2014.', '276', '2012', 1997],
    ['D. Aronov, R. Nevers, and D. W. Tank, Nature 543, 719 (2017).', '543', '719', 2017],
    ['Burez D, den Poel V. Expert Syst Appl. 2009;36(3):4626–36.', '36', '4626', 2009],
    ['H. Everett, Rev. Mod. Phys. 29, 454 (1957)', '29', '454', 1957],
    ['A. H. Mayo, Y. Onose, Proceedings of the National Academy of Sciences 122, e2405839122 (2025).', '122', 'e2405839122', 2025],
    // Physics PDF entries (2610.31730, 2610.27843): a letters page, an abbreviation that is no common one, a bracketed
    // place, and an erratum after the locator.
    ['E. Fonseca et al., Astrophys. J. Lett. 915, L12 (2021).', '915', 'l12', 2021],
    ['X.-K. Dong, F.-K. Guo, and B.-S. Zou, Progr. Phys. 41, 65 (2021).', '41', '65', 2021],
    ['Z.-G. Wang, Front. Phys. (Beijing) 21, 016300 (2026).', '21', '16300', 2026],
    ['F.-K. Guo, C. Hanhart, U.-G. Meißner, Q. Wang, Q. Zhao, and B.-S. Zou, Rev. Mod. Phys. 90, 015004 (2018), [Erratum: Rev.Mod.Phys. 94, 029901 (2022)].', '90', '15004', 2018],
  ])('%s', (text, volume, page, year) => {
    const loc = journalLocator(parse(text));
    expect(loc).toMatchObject({ volume, page, year });
  });

  test('the series letter stuck to the volume goes with the journal', () => {
    expect(journalLocator(parse('E.V. Linder, Phys. Rev. D81, 127301 (2010)'))?.before).toMatch(/Phys\. Rev\. D$/);
  });

  test.each([
    ['no volume or page', 'J. Roe, Journal of Stuff, 2019.'],
    ['no year', 'J. Roe, Phys. Rev. Lett. 98, 100401.'],
    ['a title and a venue the ordinary way', 'J. Roe and K. Smith. Deep things in shallow water. Journal of Stuff 4, 1-9 (2019).'],
    ['a DOI', 'J. Roe, Phys. Rev. Lett. 98, 100401 (2007), 10.1103/PhysRevLett.98.100401.'],
    ['an arXiv id', 'J. Roe, Phys. Rev. Lett. 98, 100401 (2007) [arXiv:hep-th/0601001].'],
    ['a book', 'N.D. Birrell, P.C.W. Davies, Quantum Fields in Curved Space (Cambridge Univ. Press, Cambridge, UK, 1984)'],
    ['a web page', 'OpenAI GPT-4o: multimodal large language model. Note: Accessed: 2025-02-17 External Links: Link'],
    ['a year out of range', 'J. Roe, Phys. Rev. Lett. 98, 100401 (1750)'],
    ['nothing in front of the volume', '98, 100401 (2007)'],
  ])('%s gives none', (_why, text) => {
    expect(journalLocator(parse(text))).toBeUndefined();
  });

  test('a hostile text is read in linear time', () => {
    const start = Date.now();
    for (const text of [`${'A. B, '.repeat(200)}Phys. Rev. 1,`, `${'x '.repeat(1000)}12 (2007)`, `${'(1) '.repeat(500)}`, `Phys. Rev. ${'1'.repeat(5000)}, 12 (2007)`]) journalLocator(parse(text));
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('the query is the reference as written, without arXiv’s trailing notes', () => {
    expect(locatorQuery(parse('[3] E. Linder, Phys. Rev. D81, 127301 (2010) Cited by: §2.'))).toBe('E. Linder, Phys. Rev. D81, 127301 (2010)');
  });

  test('the cache key is the same for the same article', () => {
    const a = journalLocator(parse('E. Linder, Phys. Rev. D81, 127301 (2010)'));
    const b = journalLocator(parse('Eric V. Linder, Phys. Rev. D 81, 127301 (2010).'));
    expect(a && b && locatorKey(a)).toBe(b && locatorKey(b));
  });
});

describe('locatorMatch: is this record the article the locator names?', () => {
  const c = parse('C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)');
  const loc = journalLocator(c);
  if (loc === undefined) throw new Error('no locator');

  test('every part agrees', () => {
    expect(matchesLocator(c, loc, record())).toBe(true);
    expect(locatorMatch(c, loc, [record({ doi: '10.1/other', volume: '1' }), record()])?.doi).toBe('10.1103/physrev.124.925');
  });

  test.each([
    ['volume', { volume: '125' }],
    ['volume that is not a number', { volume: '124-A' }],
    ['no volume', { volume: undefined }],
    ['first page', { pages: ['926'] }],
    ['no page', { pages: [] }],
    ['year', { year: 1965 }],
    ['no date at all', { year: undefined }],
    ['journal', { venues: ['Physical Review Letters'], venue: 'Physical Review Letters' }],
    ['journal that merely begins the same', { venues: ['Physical Review D'], venue: 'Physical Review D' }],
    ['journal that is only the end of it', { venues: ['Review'], venue: 'Review' }],
    ['author', { authors: ['someone', 'else'] }],
    ['an author list that is empty while the reference names people', { authors: [] }],
  ] satisfies [string, Partial<WorkRecord>][])('a different %s is not a match', (_what, over) => {
    expect(matchesLocator(c, loc, record(over))).toBe(false);
  });

  test('the year may be that of any known date of the work', () => {
    expect(matchesLocator(c, loc, record({ year: 1963, otherYears: [1961] }))).toBe(true);
  });

  test('a page may be the article number', () => {
    const l = journalLocator(parse('J. Roe, K. Smith, Phys. Rev. Lett. 98, 100401 (2007)'));
    if (l === undefined) throw new Error('no locator');
    const r = record({ authors: ['roe', 'smith'], year: 2007, venues: ['Physical Review Letters', 'Phys. Rev. Lett.'], volume: '98', pages: ['100401', '1'] });
    expect(matchesLocator(parse('J. Roe, K. Smith, Phys. Rev. Lett. 98, 100401 (2007)'), l, r)).toBe(true);
  });

  test('one matching author is enough, and a reference that names nobody needs none', () => {
    expect(matchesLocator(c, loc, record({ authors: ['dicke', 'unknown'] }))).toBe(true);
    const bare: ParsedCitation = { raw: 'Phys. Rev. 124, 925 (1961)', authors: [], kind: 'unknown', confidence: 0.1 };
    const l = journalLocator(bare);
    if (l === undefined) throw new Error('no locator');
    expect(matchesLocator(bare, l, record({ authors: ['someone'] }))).toBe(true);
  });

  test('two records that both match are not told apart', () => {
    expect(locatorMatch(c, loc, [record(), record({ doi: '10.1103/second' })])).toBeUndefined();
  });

  test('none matching gives none', () => {
    expect(locatorMatch(c, loc, [])).toBeUndefined();
    expect(locatorMatch(c, loc, [record({ volume: '3' })])).toBeUndefined();
  });
});

describe('journal names: abbreviated and spelled out', () => {
  // [as cited, names the record gives, whether they are the same journal]
  test.each([
    ['E. Linder, Phys. Rev. Lett. 98, 5 (2007)', ['Physical Review Letters'], true],
    ['E. Linder, Physical review letters 98, 5 (2007)', ['Phys. Rev. Lett.'], true],
    ['E. Linder, Phys. Rev. D81, 5 (2007)', ['Physical Review D'], true],
    ['E. Linder, Phys. Rev. B 81, 5 (2007)', ['Physical Review D'], false],
    ['E. Linder, Phys. Rev. A 81, 5 (2007)', ['Physical Review Applied'], false],
    ['E. Linder, Phys. Rev. 81, 5 (2007)', ['Physical Review D'], false],
    ['E. Linder, Phys. Rev. D 81, 5 (2007)', ['Physical Review'], false],
    ['E. Linder, Phys. Rept. 81, 5 (2007)', ['Physics Reports'], true],
    ['E. Linder, Rept. Prog. Phys. 79(10), 5 (2007)', ['Reports on Progress in Physics'], true],
    ['E. Linder, Class. Quant. Grav. 21, 5 (2007)', ['Classical and Quantum Gravity'], true],
    ['E. Linder, Eur. Phys. J. C 79(6), 5 (2007)', ['The European Physical Journal C'], true],
    ['E. Linder, Annalen Phys. 347(13), 5 (2007)', ['Annalen der Physik'], true],
    ['E. Linder, Lect. Notes Phys. 720, 5 (2007)', ['Lecture Notes in Physics'], true],
    ['E. Linder, J. Math. Phys. 3, 5 (2007)', ['Journal of Mathematical Physics'], true],
    ['E. Linder, Nat. Phys. 18, 5 (2007)', ['Nature Physics'], true],
    ['E. Linder, Nature 18, 5 (2007)', ['Nature Physics'], false],
    ['E. Linder, Nat. Phys. 18, 5 (2007)', ['Nature'], false],
    ['E. Linder, Nature Communications 18, 5 (2007)', ['Nature Communications'], true],
    ['E. Linder, Europhysics Letters 107, 5 (2007)', ['EPL (Europhysics Letters)'], true],
    ['E. Linder, Proc. Natl. Acad. Sci. U.S.A. 107, 5 (2007)', ['Proceedings of the National Academy of Sciences'], false],
    ['E. Linder, Proc. Natl. Acad. Sci. U.S.A. 107, 5 (2007)', ['Proceedings of the National Academy of Sciences', 'Proc. Natl. Acad. Sci. U.S.A.'], true],
    ['E. Linder, Expert Syst Appl. 2009;36(3):5', ['Expert Systems with Applications'], true],
    ['E. Linder, Journal of Physics F: Metal Physics 5, 5 (2007)', ['Journal of Physics F: Metal Physics'], true],
    ['E. Linder, Science advances 4, 5 (2007)', ['Science Advances'], true],
    ['E. Linder, Science 4, 5 (2007)', ['Science Advances'], false],
    ['E. Linder, Cell 4, 5 (2007)', ['Cell Reports'], false],
    ['E. Linder, Jazz 4, 5 (2007)', ['Journal'], false],
  ] satisfies [string, string[], boolean][])('%s ~ %j: %s', (text, names, same) => {
    const cited = parse(text);
    const loc = journalLocator(cited);
    if (loc === undefined) throw new Error(`no locator in ${text}`);
    const volume = String(loc.volume);
    const r = record({ authors: ['linder'], year: loc.year, venues: names, venue: names[0], volume, pages: [loc.page] });
    expect(matchesLocator(cited, loc, r)).toBe(same);
  });

  // An abbreviation that is a prefix of two journals' words must not pick the wrong journal.
  test.each([
    ['E. Linder, J. Phys. 98, 5 (2007)', ['The Journal of Physiology', 'J. Physiol.'], ['J. Physiol.'], false],
    ['E. Linder, J. Phys. 98, 5 (2007)', ['The Journal of Physiology'], [], false],
    ['E. Linder, J. Phys. 98, 5 (2007)', ['Journal of Physics', 'J. Phys.'], ['J. Phys.'], true],
    ['E. Linder, J. Phys. 98, 5 (2007)', ['Journal of Physics'], [], true],
    ['E. Linder, Mat. Res. 98, 5 (2007)', ['Mathematical Research'], [], false],
    ['E. Linder, Mat. Res. 98, 5 (2007)', ['Materials Research'], [], true],
    ['E. Linder, Chem. Commun. 98, 5 (2007)', ['Chemotherapy Communications'], [], false],
    ['E. Linder, Chem. Commun. 98, 5 (2007)', ['Chemical Communications', 'Chem. Commun.'], ['Chem. Commun.'], true],
    ['E. Linder, Math. Ann. 98, 5 (2007)', ['Mathematische Annalen', 'Math. Ann.'], ['Math. Ann.'], true],
    ['E. Linder, Phys. Rev. Lett. 98, 5 (2007)', ['Physical Review Letters', 'Phys. Rev. Lett.'], ['Phys. Rev. Lett.'], true],
    ['E. Linder, Physiol. Rev. 98, 5 (2007)', ['Physical Review'], [], false],
  ] satisfies [string, string[], string[], boolean][])('%s ~ %j (short %j): %s', (text, venues, shortVenues, same) => {
    const cited = parse(text);
    const loc = journalLocator(cited);
    if (loc === undefined) throw new Error(`no locator in ${text}`);
    const r = record({ authors: ['linder'], year: 2007, venues, venue: venues[0], shortVenues, volume: '98', pages: ['5'] });
    expect(matchesLocator(cited, loc, r)).toBe(same);
  });

  test('a title in front of the journal does not stop the journal from matching', () => {
    // The parser reads this Nature-style entry with its title (and it is searched by it); the locator is read here
    // from the same text without one, as for any entry the parser leaves without a title.
    const text = 'Fang, W. Q., He, Z. Z. & Liu, J. Electro-hydrodynamic shooting phenomenon of liquid metal stream. Appl. Phys. Lett. 105, 134104 (2014).';
    const cited: ParsedCitation = { raw: text, authors: [], kind: 'paper', confidence: 0.1 };
    const loc = journalLocator(cited);
    if (loc === undefined) throw new Error('no locator');
    const r = record({ authors: ['fang', 'he', 'liu'], year: 2014, venues: ['Applied Physics Letters', 'Appl. Phys. Lett.'], volume: '105', pages: ['134104'] });
    expect(matchesLocator(cited, loc, r)).toBe(true);
    expect(matchesLocator(cited, loc, { ...r, authors: ['someone'] })).toBe(false);
  });
});

// A title-less reading takes every word in front of the volume for the journal's name. With the record in hand, the words
// its journal name does not account for are a title.
describe('words in front of the journal\'s name', () => {
  const nuclear = record({ venue: 'Nuclear Physics B', venues: ['Nuclear Physics B'] });
  const NAMES = 'M. G. Alford, K. Rajagopal, and F. Wilczek,';

  test.each([
    [`${NAMES} Dark matter from locked quarks. Nucl. Phys. B537, 443 (1999).`, 'Dark matter from locked quarks'],
    [`${NAMES} Dark matter from locked quarks: Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).`, 'Dark matter from locked quarks'],
    [`${NAMES} Dark Matter From Locked Quarks Nucl. Phys. B537, 443 (1999).`, 'Dark Matter From Locked Quarks'],
    ['Allen, J. F. & Misener, A. D. Flow of liquid helium II. Nucl. Phys. B 141, 75 (1938).', 'Flow of liquid helium II'],
    // The reading kept "Y. LeCun," as the authors; the record's other names before the title are no part of it.
    ['Y. LeCun, Y. Bengio and G. Hinton. Deep learning. Nucl. Phys. B 521, 436–444 (2015).', 'Deep learning'],
    // A title that opens with an author's name keeps it.
    ['J. J. Hopfield, Hopfield networks in nuclear matter. Nucl. Phys. B 521, 436 (2015).', 'Hopfield networks in nuclear matter'],
  ])('are read as the title: %s', (text, title) => {
    const nuclear = record({ authors: ['lecun', 'bengio', 'hinton', 'hopfield'], venue: 'Nuclear Physics B', venues: ['Nuclear Physics B'] });
    expect(journalNameLead(parse(text), nuclear)).toMatchObject({ title });
  });

  test.each([
    `${NAMES} Nucl. Phys. B537, 443 (1999).`,
    'Alford, M. G. & Rajagopal, K. Nucl. Phys. B 537, 443 (1999).',
    'Abbott, B. P. et al. Nucl. Phys. B 537, 443 (1999).',
    'K. Bakke and C. Furtado, The Nuclear Physics B 537, 443 (1999).',
  ])('names, initials and joining words are not: %s', (text) => {
    expect(journalNameLead(parse(text), nuclear)).toBeUndefined();
  });

  test('a year is no volume, so a report named with its year is left alone', () => {
    const c: ParsedCitation = { raw: 'Qwen, Qwen2.5 technical report, 2025', authors: [], kind: 'unknown', confidence: 0.2, venue: 'Qwen2.5 technical report, 2025' };
    expect(journalNameLead(c, record({ venue: undefined, venues: undefined }))).toBeUndefined();
  });

  test('with no journal name on the record, words that could be a title are unaccounted for; a journal\'s own are not', () => {
    const bare = record({ venue: undefined, venues: undefined });
    expect(journalNameLead(parse(`${NAMES} Dark matter from locked quarks. Nucl. Phys. B537, 443 (1999).`), bare)).toBe('unaccounted');
    expect(journalNameLead(parse(`${NAMES} Nucl. Phys. B537, 443 (1999).`), bare)).toBeUndefined();
    expect(journalNameLead(parse('U. K. Laemmli, Nature (London) 227, 680 (1970).'), bare)).toBeUndefined();
  });

  test('a reference with a title is left alone', () => {
    expect(journalNameLead(parse('A. Vaswani, Attention is all you need, Nucl. Phys. B 537, 443 (1999).'), nuclear)).toBeUndefined();
  });
});
