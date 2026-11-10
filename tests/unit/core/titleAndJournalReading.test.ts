// How the parser reads titles and journal names: physics references (many from 1602.03837, the LIGO paper, read from
// its PDF), TeX titles, Nature style and part numbers.
import { describe, expect, test } from 'vitest';
import { classify, isCredibleTitle, isVerifiedOnlyLookup, preLookupVerdict } from '../../../src/core/classify';
import { journalLocator, locatorMatch, matchesLocator, natureStyleLocatorReading } from '../../../src/core/journalLocator';
import { normalizeTitle, plainQueryText, titleSimilarity } from '../../../src/core/normalize';
import { parseCitation } from '../../../src/core/parseCitation';
import { VERIFIED_TITLE } from '../../../src/core/thresholds';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });
const ALL = [...REQUIRED_SOURCES];
const UNREADABLE = "Couldn't read this reference reliably";

function journalRecord(over: Partial<WorkRecord> = {}): WorkRecord {
  return { source: 'crossref', title: 'Some article', authors: ['roe'], year: 1970, venue: 'Nature', venues: ['Nature'], volume: '227', pages: ['936'], isRetracted: false, notes: [], ...over };
}

describe('a leading lower-case "in <Venue>" is where the work appeared, not its title', () => {
  test.each([
    // The first work of 1602.03837 [64] alone.
    'E. Goetz et al., in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi Conference, Amaldi, New York, 2009.',
    'J. Roe, in Gravitational Waves: Proceedings of the 8th Edoardo Amaldi Conference, New York, 2009.',
    'A. B. Roe and C. D. Smith, in Frontiers of Physics: Workshop on Lasers, Rome, 2011.',
    'J. Roe, in Relativity and Gravitation: Symposium Proceedings, Paris, 1967.',
  ])('no title: %s', (text) => {
    const c = parse(text);
    expect(c.title).toBeUndefined();
    expect(c.venue).toMatch(/^in /);
  });

  test('so nothing is searched for it, and it is never Not found', () => {
    const c = parse('E. Goetz et al., in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi Conference, Amaldi, New York, 2009.');
    expect(preLookupVerdict(c)?.reason).toBe(UNREADABLE);
    expect(classify({ citation: c, searched: ALL, failed: [] }).status).toBe('cant_check');
  });

  test('a paper with its own title before "in <Proceedings>" keeps it', () => {
    expect(parse('J. Roe and K. Poe, Calibration of the detectors, in Gravitational Waves: Proceedings of the 8th Amaldi Conference, New York, 2009.').title).toBe('Calibration of the detectors');
  });

  test.each([
    'in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi Conference, Amaldi, New York',
    'in Search of Lost Detectors and Their Noise',
  ])('a "title" that still opens with lower-case "in " and a capital is not credible: %s', (title) => {
    expect(isCredibleTitle(title)).toBe(false);
  });

  test.each([
    'In Defense of the Triplet Loss for Person Re-Identification',
    'In Search of Lost Domain Generalization',
    'in situ measurements of the detector noise',
    'Inference in deep networks',
  ])('a real title stays credible: %s', (title) => {
    expect(isCredibleTitle(title)).toBe(true);
  });

  test.each([
    // A conference paper with its own title and a capitalised "In" is untouched.
    ['J. Roe, In defense of the triplet loss for person re-identification, in Proceedings of CVPR, 2017.', 'In defense of the triplet loss for person re-identification'],
    ['J. Roe, K. Poe, and L. Doe, In Search of Lost Domain Generalization, in International Conference on Learning Representations, 2021.', 'In Search of Lost Domain Generalization'],
  ])('a capitalised "In" title is kept: %s', (text, title) => {
    expect(parse(text).title).toBe(title);
  });
  test.each([
    'J. Roe and K. Poe, An invented study of interferometer noise, in Gravitational Waves: Proceedings of the 8th Amaldi Conference, New York, 2009.',
    'J. Roe and K. Poe, An invented study of interferometer noise, Phys. Rev. D 82, 022003 (2010).',
    'J. Roe, K. Poe, and L. Doe, In Search of Invented Interferometer Noise, in International Conference on Learning Representations, 2021.',
  ])('an invented paper with its own title is still Not found when nothing matches it: %s', (text) => {
    expect(classify({ citation: parse(text), searched: ALL, failed: [] }).status).toBe('not_found');
  });
});

describe('a bracketed place name after a journal word is part of the venue ("Nature (London) 227, 936 (1970)")', () => {
  test.each([
    // 1602.03837 [8] [17] [18] [105].
    ['C. V. Vishveshwara, Nature (London) 227, 936 (1970).', '227', '936', 1970, journalRecord({ authors: ['vishveshwara'] })],
    ['B. L. Webster and P. Murdin, Nature (London) 235, 37 (1972).', '235', '37', 1972, journalRecord({ authors: ['webster', 'murdin'], year: 1972, volume: '235', pages: ['37'] })],
    ['S. Sigurdsson and L. Hernquist, Nature (London) 364, 423 (1993).', '364', '423', 1993, journalRecord({ authors: ['sigurdsson', 'hernquist'], year: 1993, volume: '364', pages: ['423'] })],
    ['J. Roe, Ann. Phys. (N.Y.) 140, 372 (1982).', '140', '372', 1982, journalRecord({ venue: 'Annals of Physics', venues: ['Annals of Physics'], year: 1982, volume: '140', pages: ['372'] })],
    ['J. Roe, Ann. Phys. (Berlin) 17, 891 (1905).', '17', '891', 1905, journalRecord({ venue: 'Annalen der Physik', venues: ['Annalen der Physik'], year: 1905, volume: '17', pages: ['891'] })],
    ['J. Roe, J. Phys. (Paris) 43, 1 (1982).', '43', '1', 1982, journalRecord({ venue: 'Journal de Physique', venues: ['Journal de Physique'], year: 1982, volume: '43', pages: ['1'] })],
  ] as [string, string, string, number, WorkRecord][])('%s', (text, volume, page, year, r) => {
    const c = parse(text);
    expect(c.title).toBeUndefined();
    const loc = journalLocator(c);
    expect(loc).toMatchObject({ volume, page, year });
    expect(loc && matchesLocator(c, loc, r)).toBe(true);
  });

  test('the place name does not stand for another journal', () => {
    const c = parse('C. V. Vishveshwara, Nature (London) 227, 936 (1970).');
    const loc = journalLocator(c);
    expect(loc).toBeDefined();
    if (loc === undefined) return;
    expect(matchesLocator(c, loc, journalRecord({ authors: ['vishveshwara'], venue: 'Nature Physics', venues: ['Nature Physics'] }))).toBe(false);
    expect(matchesLocator(c, loc, journalRecord({ authors: ['vishveshwara'], venue: 'London Mathematical Society', venues: ['London Mathematical Society'] }))).toBe(false);
    expect(matchesLocator(c, loc, journalRecord({ authors: ['someone'] }))).toBe(false);
    expect(matchesLocator(c, loc, journalRecord({ authors: ['vishveshwara'], pages: ['937'] }))).toBe(false);
  });

  test('a bracket with digits or a single letter is not a place name', () => {
    expect(parse('J. Roe, Deep features of things (2) 12, 3 (2019).').title).toBeDefined();
  });
});

describe('a title-less journal citation may end with a comma ("... (2014),")', () => {
  test.each([
    // 1602.03837 [86] [96] [107]: the PDF prints the comma.
    ['S. Privitera, S. R. P. Mohapatra, P. Ajith, K. Cannon, N. Fotopoulos, M. A. Frei, C. Hanna, A. J. Weinstein, and J. T. Whelan, Phys. Rev. D 89, 024003 (2014),', '89', '24003', 2014],
    ['C. L. Rodriguez, M. Morscher, B. Pattabiraman, S. Chatterjee, C.-J. Haster, and F. A. Rasio, Phys. Rev. Lett. 115, 051101 (2015),', '115', '51101', 2015],
    ['J. Roe, Phys. Rev. D 89, 024003 (2014);', '89', '24003', 2014],
  ])('%s', (text, volume, page, year) => {
    const c = parse(text);
    expect(c.title).toBeUndefined();
    expect(journalLocator(c)).toMatchObject({ volume, page, year });
    const r = journalRecord({ authors: ['privitera', 'rodriguez', 'roe'], venue: 'Physical Review D', venues: ['Physical Review D', 'Phys. Rev. D'], year, volume, pages: [page.padStart(6, '0')] });
    if (text.includes('Lett.')) Object.assign(r, { venue: 'Physical Review Letters', venues: ['Physical Review Letters', 'Phys. Rev. Lett.'] });
    const loc = journalLocator(c);
    expect(loc && locatorMatch(c, loc, [r])).toBe(r);
  });
});

describe('an invented paper with a title is not taken for a title-less citation by these two readings', () => {
  test.each([
    'J. Roe and K. Poe, An invented study of interferometer noise, Nature (London) 227, 936 (1970).',
    'J. Roe and K. Poe, An invented study of interferometer noise, Phys. Rev. D 89, 024003 (2014),',
  ])('%s', (text) => {
    const c = parse(text);
    expect(c.title).toBe('An invented study of interferometer noise');
    expect(journalLocator(c)).toBeUndefined();
    expect(classify({ citation: c, searched: ALL, failed: [] }).status).toBe('not_found');
  });
});

describe('journal names that the record writes in full', () => {
  const MNRAS = journalRecord({ authors: ['lipunov', 'postnov', 'prokhorov'], year: 1997, venue: 'Monthly Notices of the Royal Astronomical Society', venues: ['Monthly Notices of the Royal Astronomical Society'], shortVenues: ['Monthly Notices of the Royal Astronomical Society'], volume: '288', pages: ['245'] });
  const PRSA = journalRecord({ authors: ['chandrasekhar', 'detweiler'], year: 1975, venue: 'Proceedings of the Royal Society of London. A. Mathematical and Physical Sciences', venues: ['Proceedings of the Royal Society of London. A. Mathematical and Physical Sciences'], volume: '344', pages: ['441'] });
  const APJ = journalRecord({ authors: ['portegies zwart', 'mcmillan'], year: 2000, venue: 'The Astrophysical Journal', venues: ['The Astrophysical Journal'], volume: '528', pages: ['l17'] });

  test.each([
    // 1602.03837 [103] [10] [106]: Crossref returned these records; the journal name was the only part that failed.
    ['V. M. Lipunov, K. A. Postnov, and M. E. Prokhorov, Mon. Not. R. Astron. Soc. 288, 245 (1997).', MNRAS],
    ['S. Chandrasekhar and S. L. Detweiler, Proc. R. Soc. A 344, 441 (1975).', PRSA],
    ['S. Chandrasekhar and S. L. Detweiler, Proc. R. Soc. Lond. A 344, 441 (1975).', PRSA],
    ['S. F. Portegies Zwart and S. L. W. McMillan, Astrophys. J. Lett. 528, L17 (2000).', APJ],
    ['S. F. Portegies Zwart and S. L. W. McMillan, Astrophys. J. Letters 528, L17 (2000).', APJ],
  ] as [string, WorkRecord][])('%s', (text, r) => {
    const c = parse(text);
    const loc = journalLocator(c);
    expect(loc).toBeDefined();
    expect(loc && locatorMatch(c, loc, [r])).toBe(r);
  });

  test.each([
    ['another series letter', 'S. Chandrasekhar and S. L. Detweiler, Proc. R. Soc. B 344, 441 (1975).', PRSA],
    ['"Letters" with a page that is not a letter\'s', 'S. F. Portegies Zwart and S. L. W. McMillan, Astrophys. J. Lett. 528, 17 (2000).', { ...APJ, pages: ['17'] }],
    ['an initial with too few other words', 'J. Roe, Phys. R. Lett. 12, 345 (2000).', journalRecord({ authors: ['roe'], year: 2000, venue: 'Physical Reports Letters', venues: ['Physical Reports Letters'], volume: '12', pages: ['345'] })],
    ['an initial for a word the record does not have', 'V. M. Lipunov, K. A. Postnov, and M. E. Prokhorov, Mon. Not. S. Astron. Soc. 288, 245 (1997).', MNRAS],
    ['the right journal, other authors', 'A. Smith and B. Jones, Mon. Not. R. Astron. Soc. 288, 245 (1997).', MNRAS],
    ['the right journal, another page', 'V. M. Lipunov, K. A. Postnov, and M. E. Prokhorov, Mon. Not. R. Astron. Soc. 288, 246 (1997).', MNRAS],
    ['a dotted word in front of the name is the start of a longer one', 'J. Roe, Phys. Proc. R. Soc. A 344, 441 (1975).', { ...PRSA, authors: ['roe'] }],
  ] as [string, string, WorkRecord][])('no match: %s', (_what, text, r) => {
    const c = parse(text);
    const loc = journalLocator(c);
    expect(loc === undefined ? undefined : locatorMatch(c, loc, [r])).toBeUndefined();
  });
});

describe('the reason says what the reference calls itself (wording only, same status)', () => {
  const REPORT = "Looks like a technical report, which these databases don't list reliably";
  test.each([
    // 1602.03837 [27] [29] [31] [32].
    'R. Weiss, Electromagnetically coupled broadband gravitational antenna, Quarterly Report of the Research Laboratory for Electronics, MIT Report No. 105, 1972, https://dcc.ligo.org/LIGO‑P720002/public/main.',
    'R. W. P. Drever, F. J. Raab, K. S. Thorne, R. Vogt, and R. Weiss, Laser Interferometer Gravitational-wave Observatory (LIGO) Technical Report, 1989, https://dcc.ligo.org/LIGO‑M890001/public/main.',
    'A. Brillet, A. Giazotto et al., Virgo Project Technical Report No. VIR-0517A-15, 1989, https://tds.ego‑gw.it/ql/?c=11247.',
    'J. Hough et al., Proposal for a joint German-British interferometric gravitational wave detector, MPQ Technical Report 147, No. GWD/137/JH(89), 1989, http://eprints .gla.ac.uk/114852.',
  ])('a technical report: %s', (text) => {
    const v = preLookupVerdict(parse(text));
    expect(v?.status).toBe('cant_check');
    expect(v?.reason).toBe(REPORT);
  });

  test.each([
    'B. Abbott et al., https://dcc.ligo.org/LIGO‑P1500218/public/main.',
    'The waveform shown is SXS:BBH:0305, available for download at http://www.black‑holes.org/waveforms.',
  ])('a web page is still a web page: %s', (text) => {
    expect(preLookupVerdict(parse(text))?.reason).toMatch(/^Looks like a website or software/);
  });

  test.each([
    ['R. Schilling (unpublished).', 'Marked as unpublished, so these databases are not expected to list it'],
    ['J. Roe, A study of interferometer noise (unpublished).', 'Marked as unpublished, so these databases are not expected to list it'],
    ['J. Roe and K. Poe, A study of interferometer noise (in preparation).', 'Marked as in preparation, so these databases may not list it yet'],
    ['J. Roe, private communication (2015).', 'A private communication, which these databases don\'t list'],
  ])('%s', (text, reason) => {
    const v = preLookupVerdict(parse(text));
    expect(v?.status).toBe('cant_check');
    expect(v?.reason).toBe(reason);
  });

  test('a thesis keeps the book reason', () => {
    expect(preLookupVerdict(parse('J. Roe, A study of interferometer noise, PhD thesis, University of Glasgow, 2010.'))?.reason).toBe("Looks like a book or thesis, which these databases don't list reliably");
  });

  test('an unpublished work with a real title may still be verified by a Crossref title search', () => {
    const c = parse('J. Roe and K. Poe. A study of interferometer noise in long baseline detectors. Unpublished, 2012.');
    expect(isVerifiedOnlyLookup(c, preLookupVerdict(c))).toBe(true);
  });
});

// Balram and Wójs, "Fractional quantum Hall effect at ν=2+4/9", cited in TeX. The databases hold "ν" (Unicode, or
// MathML in Crossref), so a search phrase that says "nu" misses the record.
describe('Greek letters in a title written in TeX', () => {
  const CITED = 'A. C. Balram and A. Wójs (2020) Fractional quantum Hall effect at \\nu=2+4/9 . Phys. Rev. Research 2, pp. 032035.';

  test('the search phrase writes them as the databases print them', () => {
    expect(plainQueryText('Fractional quantum Hall effect at \\nu=2+4/9')).toBe('Fractional quantum Hall effect at ν=2+4/9');
    expect(plainQueryText('Rates for $\\alpha$-divergences and $\\Delta$-matroids')).toBe('Rates for α-divergences and Δ-matroids');
    expect(plainQueryText('Mod-$\\varphi$ convergence')).toBe('Mod-φ convergence');
  });

  test.each([
    'Fractional quantum Hall effect at ν=2+4/9',
    'Fractional quantum Hall effect at ν = 2 + 4 / 9',
    'Fractional quantum Hall effect at $\\nu=2+4/9$',
    'Fractional quantum Hall effect at $ν=2+4/9$',
    'Fractional quantum Hall effect at nu=2+4/9',
  ])('a title in TeX is the same title as the record\'s, however the record writes the letter: %s', (recordTitle) => {
    expect(titleSimilarity('Fractional quantum Hall effect at \\nu=2+4/9', recordTitle)).toBe(1);
  });

  test('a letter and its TeX name fold the same way, a variant form included', () => {
    expect(normalizeTitle('Mod-$φ$ convergence')).toBe(normalizeTitle('Mod-$\\phi$ convergence'));
    expect(normalizeTitle('Mod-$ϕ$ convergence')).toBe(normalizeTitle('Mod-$\\varphi$ convergence'));
    expect(normalizeTitle('$\\epsilon$-nets and ε-nets')).toBe('epsilon nets and epsilon nets');
  });

  test('a word written in Greek is left as it is', () => {
    expect(normalizeTitle('Γλώσσα και λόγος')).toBe('γλωσσα και λογος');
  });

  test('the reference is Verified against the record', () => {
    const c = parse(CITED);
    const r: WorkRecord = { source: 'crossref', title: 'Fractional quantum Hall effect at ν=2+4/9', authors: ['balram', 'wojs'], year: 2020, venue: 'Physical Review Research', volume: '2', pages: ['032035'], isRetracted: false, notes: [] };
    expect(classify({ citation: c, match: r, matchedVia: 'search', searched: ALL, failed: [] }).status).toBe('verified');
  });

  test.each([
    ['another filling fraction', 'Fractional quantum Hall effect at \\nu=2+3/8', 'Fractional quantum Hall effect at ν=2+4/9'],
    ['another short fraction', 'Fractional quantum Hall effect at \\nu=1/3', 'Fractional quantum Hall effect at ν=2/5'],
    ['another Greek letter', 'Stable \\alpha-divergences in deep generative models', 'Stable β-divergences in deep generative models'],
  ])('an invented title written in maths is not the record\'s: %s', (_what, cited, recordTitle) => {
    expect(titleSimilarity(cited, recordTitle)).toBeLessThan(VERIFIED_TITLE);
  });

  test('a title that is only maths is still no title to call Not found', () => {
    expect(isCredibleTitle('$\\nu=2+4/9$')).toBe(false);
    expect(isCredibleTitle('\\alpha\\beta\\gamma')).toBe(false);
  });
});

// A reference typed without Greek letters writes one as its Latin look-alike ("a-stable" for "α-stable"). The Latin letter
// stands for the Greek one only where the record's title has that letter in the same place, and the article "a" is never
// "α".
describe('a Greek letter written as its Latin look-alike', () => {
  const STABLE = 'Parameter estimation for α-stable distributions with heavy tails';

  test.each([
    ['joined to the next word by a hyphen', 'Parameter estimation for a-stable distributions with heavy tails', STABLE],
    ['in TeX on the record', 'Parameter estimation for a-stable distributions with heavy tails', 'Parameter estimation for $\\alpha$-stable distributions with heavy tails'],
    ['the record cited in Greek, the other way round', STABLE, 'Parameter estimation for a-stable distributions with heavy tails'],
    ['b for β', 'Learning b-VAE representations of shape', 'Learning β-VAE representations of shape'],
    ['a lone letter in the same place', 'The k parameter of the gamma distribution', 'The κ parameter of the gamma distribution'],
    ['m for μ, in the same place', 'Measuring the m parameter in muon decay', 'Measuring the μ parameter in muon decay'],
  ])('%s is the same title', (_what, cited, recordTitle) => {
    expect(titleSimilarity(cited, recordTitle)).toBe(1);
  });

  test('the reference is Verified against the record', () => {
    const c = parse('J. Roe and K. Poe, Parameter estimation for a-stable distributions with heavy tails, J. Stat. Phys. 113, 389 (2003).');
    const r: WorkRecord = { source: 'crossref', title: STABLE, authors: ['roe', 'poe'], year: 2003, venue: 'Journal of Statistical Physics', volume: '113', pages: ['389'], isRetracted: false, notes: [] };
    expect(classify({ citation: c, match: r, matchedVia: 'search', searched: ALL, failed: [] }).status).toBe('verified');
  });

  // Adversarial: a Latin letter is the Greek one only where nothing else could be meant.

  test.each([
    ['the article "a" as a word of its own', 'Parameter estimation for a stable distribution with heavy tails', STABLE],
    ['the article "A" opening the title', 'A stable estimator for heavy tails', 'α stable estimator for heavy tails'],
    ['a real word swapped for the article', 'Parameter estimation for a distributions with heavy tails', STABLE],
    ['another Greek letter\'s look-alike', 'Parameter estimation for b-stable distributions with heavy tails', STABLE],
    ['the letter somewhere else in the title', 'Parameter estimation a-for stable distributions with heavy tails', STABLE],
    ['a lone letter with other words around it', 'The k estimator of the gamma distribution', 'The κ parameter of the gamma distribution'],
  ])('%s stays below Verified', (_what, cited, recordTitle) => {
    expect(titleSimilarity(cited, recordTitle)).toBeLessThan(VERIFIED_TITLE);
  });

  test('an altered title that swaps a real word for "a" is not Verified', () => {
    const c = parse('J. Roe and K. Poe, Parameter estimation for a distributions with heavy tails, J. Stat. Phys. 113, 389 (2003).');
    const r: WorkRecord = { source: 'crossref', title: 'Parameter estimation for stable distributions with heavy tails', authors: ['roe', 'poe'], year: 2003, venue: 'Journal of Statistical Physics', volume: '113', pages: ['389'], isRetracted: false, notes: [] };
    expect(classify({ citation: c, match: r, matchedVia: 'search', searched: ALL, failed: [] }).status).not.toBe('verified');
  });

  test('two different Greek letters stay different ("α-stable" and "β-stable")', () => {
    expect(titleSimilarity('Stable \\alpha-divergences in deep generative models', 'Stable β-divergences in deep generative models')).toBeLessThan(VERIFIED_TITLE);
  });
});

// In Nature style the names end with the last author's initials and a full stop, and the title follows. The title is
// not part of the journal's name.
describe('Nature style: "Surname, I. & Surname, I. Title. Journal vol, pages (year)."', () => {
  test.each([
    ['Blum, A. & Mansour, Y. From external to internal regret. Journal of Machine Learning Research 8, 1307–1324 (2007). https://jmlr.org/papers/v8/blum07a.html.', 'From external to internal regret', ['blum', 'mansour'], 2007],
    ['Blum, A. & Mansour, Y. From external to internal regret. Journal of Machine Learning Research 8, 1307–1324 (2007).', 'From external to internal regret', ['blum', 'mansour'], 2007],
    ['Moessner, R. & Ramirez, A. P. Geometrical frustration. Physics Today 59, 24 (2006).', 'Geometrical frustration', ['moessner', 'ramirez'], 2006],
    ['Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012).', 'Generic quantum spin ice', ['lee', 'onoda', 'balents'], 2012],
    ['Monceau, P. Electronic crystals: an experimental overview. Adv Phys 61, 325–581 (2012).', 'Electronic crystals: an experimental overview', ['monceau'], 2012],
    // An author list that ends with "et al.:" before the title (2503.00266#1).
    ['Antonelli, M., Reinke, A., Bakas, S., Summers, R.M., et al.: The medical segmentation decathlon. Nature communications 13(1), 4128 (2022)', 'The medical segmentation decathlon', ['antonelli', 'reinke', 'bakas', 'summers'], 2022],
    // A title that opens in lower case, with a symbol or with a formula is still a title.
    ['Lee, S., Onoda, S. & Balents, L. invented classical spin liquid on the kagome lattice. Phys. Rev. B 86, 104412 (2012).', 'invented classical spin liquid on the kagome lattice', ['lee', 'onoda', 'balents'], 2012],
    ['Lee, S., Onoda, S. & Balents, L. k-means clustering of frustrated magnets. Phys. Rev. B 86, 104412 (2012).', 'k-means clustering of frustrated magnets', ['lee', 'onoda', 'balents'], 2012],
    ['Lee, S., Onoda, S. & Balents, L. de Sitter vacua in string theory. Phys. Rev. B 86, 104412 (2012).', 'de Sitter vacua in string theory', ['lee', 'onoda', 'balents'], 2012],
  ])('%s', (text, title, authors, year) => {
    const c = parse(text);
    expect(c.title).toBe(title);
    expect(c.authors).toEqual(authors);
    expect(c.year).toBe(year);
    expect(preLookupVerdict(c)).toBeUndefined();
  });

  test.each([
    'C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)',
    'W. Press and K. Thorne, Annu. Rev. Astron. Astrophys. 10, 335 (1972).',
    'Smith, J. & Jones, K. Phys. Rev. Lett. 12, 345 (2000).',
    'J. Roe, Z. Physik 12, 3 (1920).',
    'J. Roe, Proc. natl. Acad. Sci. 12, 3 (1990).',
    'A. Einstein, Sitzungsber. K. Preuss. Akad. Wiss. 1, 688 (1916).',
    // A title in Title Case ends with no lower-case word: still read without a title, and looked up by its journal.
    'Smith, A., Knolle, J., Kovrizhin, D. L. & Moessner, R. Disorder-Free Localization. PRL 118, 201 (2017).',
  ])('a journal citation with no title stays title-less: %s', (text) => {
    const c = parse(text);
    expect(c.title).toBeUndefined();
    expect(journalLocator(c)).toBeDefined();
  });

  // A sentence that ends in a lower-case word is always read as a title, even one that is the
  // start of a journal's name with a lower-case abbreviation in it. The locator fallback takes such a "title" as the
  // journal when the record's journal name accounts for it (engine journalLocator.test.ts).
  test.each([
    ['Weil, A. J. reine angew. Math. 179, 129 (1938).', 'reine angew'],
    ['Prandtl, L. Zeitschrift für angew. Math. Mech. 5, 136 (1925).', 'Zeitschrift für angew'],
    ['Hückel, E. Zeitschrift für anorg. Chemie 50, 1 (1930).', 'Zeitschrift für anorg'],
    ['Lee, S., Onoda, S. & Balents, L. Emergent photons and the unreasonable effectiveness of math. Phys. Rev. B 86, 104412 (2012).', 'Emergent photons and the unreasonable effectiveness of math'],
  ])('a sentence ending in a lower-case word is read as a title: %s', (text, title) => {
    expect(parse(text).title).toBe(title);
    expect(natureStyleLocatorReading(parse(text))).toBeDefined();
  });

  test('an invented paper in Nature style can be Not found', () => {
    const c = parse('Blum, A. & Mansour, Y. From invented to imaginary regret bounds. Journal of Machine Learning Research 8, 1307–1324 (2007).');
    expect(classify({ citation: c, searched: ALL, failed: [] }).status).toBe('not_found');
  });
});

// "Quantum Theory of Gravity. II. The Manifestly Covariant Theory" is not "Quantum Theory of Gravity", which would
// match part I. The part number and its own title belong to the title.
describe('a part number after a title stays in the title', () => {
  const PART_II = 'B. S. DeWitt (1967) Quantum Theory of Gravity. II. The Manifestly Covariant Theory. Physical Review 162 (5), pp. 1195–1239.';
  test.each([
    [PART_II, 'Quantum Theory of Gravity. II. The Manifestly Covariant Theory'],
    ['B. S. DeWitt (1967) Quantum Theory of Gravity. I. The Canonical Theory. Physical Review 160 (5), pp. 1113–1148.', 'Quantum Theory of Gravity. I. The Canonical Theory'],
    ['B. S. DeWitt. Quantum Theory of Gravity. II. The Manifestly Covariant Theory. Phys. Rev. 162, 1195 (1967).', 'Quantum Theory of Gravity. II. The Manifestly Covariant Theory'],
    ['DeWitt, B. S. Quantum theory of gravity. I. The canonical theory. Phys. Rev. 160, 1113–1148 (1967).', 'Quantum theory of gravity. I. The canonical theory'],
    ['B. S. DeWitt (1967) Quantum Theory of Gravity. II. Physical Review 162 (5), pp. 1195–1239.', 'Quantum Theory of Gravity. II'],
    ['J. Roe (2001) Spin waves in thin films. Part II. Anisotropic layers. Phys. Rev. B 64, 1 (2001).', 'Spin waves in thin films. Part II. Anisotropic layers'],
  ])('%s', (text, title) => {
    expect(parse(text).title).toBe(title);
  });

  test.each([
    // Names after a title are not a part's title: "I. Goodfellow and Y. Bengio" are editors.
    ['J. Roe. Deep networks for speech. I. Goodfellow and Y. Bengio, editors, Book of Things, 2016.', 'Deep networks for speech'],
    ['J. Roe (2001) Spin waves in thin films. I. Physical Review B 64, 1 (2001).', 'Spin waves in thin films. I'],
  ])('what is not a part\'s title stays out: %s', (text, title) => {
    expect(parse(text).title).toBe(title);
  });

  const record = (title: string, volume: string): WorkRecord => ({ source: 'crossref', title, authors: ['dewitt'], year: 1967, venue: 'Physical Review', volume, pages: [volume === '162' ? '1195' : '1113'], isRetracted: false, notes: [] });

  test('part II is Verified against part II', () => {
    const v = classify({ citation: parse(PART_II), match: record('Quantum Theory of Gravity. II. The Manifestly Covariant Theory', '162'), matchedVia: 'search', searched: ALL, failed: [] });
    expect(v.status).toBe('verified');
  });

  test('part II is never Verified against part I: the title differs, as any other title would', () => {
    const v = classify({ citation: parse(PART_II), match: record('Quantum Theory of Gravity. I. The Canonical Theory', '160'), matchedVia: 'search', searched: ALL, failed: [] });
    expect(v.status).toBe('details_differ');
    expect(v.diffs.map((d) => d.field)).toContain('title');
  });
});

// The title-less reading a Nature-style entry falls back to when its title searches miss.
describe('the journal-locator reading of a Nature-style entry', () => {
  test.each([
    'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012).',
    'Moessner, R. & Ramirez, A. P. Geometrical frustration. Physics Today 59, 24 (2006).',
  ])('exists for %s', (text) => {
    const reading = natureStyleLocatorReading(parse(text));
    expect(reading?.title).toBeUndefined();
    expect(reading && journalLocator(reading)).toBeDefined();
  });

  test.each([
    ['another style with a title', 'S. Lee, S. Onoda, and L. Balents, Generic quantum spin ice, Phys. Rev. B 86, 104412 (2012).'],
    ['no locator', 'Blum, A. & Mansour, Y. From external to internal regret. Journal of Machine Learning Research (2007).'],
    ['an identifier', 'Lee, S., Onoda, S. & Balents, L. Generic quantum spin ice. Phys. Rev. B 86, 104412 (2012). doi:10.1103/PhysRevB.86.104412'],
    ['no title (the title-less path already reads it)', 'Smith, J. & Jones, K. Phys. Rev. Lett. 12, 345 (2000).'],
  ])('does not exist: %s', (_what, text) => {
    expect(natureStyleLocatorReading(parse(text))).toBeUndefined();
  });
});
