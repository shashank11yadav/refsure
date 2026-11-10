// One numbered entry that cites more than one work ("A, in Proceedings ..., 2009; B and C, Classical
// Quantum Gravity 27, 084024 (2010).") is checked as one work at a time by nothing in RefSure. Read whole, such an entry
// is never Not found or Wrong ID (its venue and numbers may be another work's), and never Verified on one of its works
// alone. (When its first part is a complete work, the engine checks that part by itself: firstWork.test.ts.)
// An erratum, addendum or translation of the same work cited beside it is not a second work.
import { describe, expect, test } from 'vitest';
import { classify, preLookupVerdict } from '../../../src/core/classify';
import { journalLocator } from '../../../src/core/journalLocator';
import { parseCitation } from '../../../src/core/parseCitation';
import { citesSeveralWorks, firstWorkText } from '../../../src/core/severalWorks';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });
const ALL = [...REQUIRED_SOURCES];
const SEVERAL = 'This entry cites more than one work, and RefSure checks one work at a time';

// 1602.03837 [64], read from the paper's PDF.
const LIGO_64 = 'E. Goetz et al., in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi Conference, Amaldi, New York, 2009; E. Goetz and R. L. Savage Jr., Classical Quantum Gravity 27, 084024 (2010).';
const TWO = 'A. Author and B. Author, Gravitational self-force in extreme mass ratio inspirals at second order, Phys. Rev. D 82, 104001 (2010); C. Author, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2011)';

describe('an entry that cites more than one work', () => {
  test.each([
    ['a second author list after ";" (1602.03837 [64])', LIGO_64],
    ['two title-less journal citations by different people', 'A. Smith and B. Jones, Phys. Rev. D 82, 022003 (2010); C. Brown, Class. Quantum Grav. 27, 084024 (2011).'],
    ['two journal locators of the same authors with different years', 'J. Roe and K. Poe, Phys. Rev. Lett. 98, 100401 (2007); Phys. Rev. D 80, 064012 (2009).'],
    ['a continuation in the same journal with another year', 'J. Roe, Phys. Rev. D 73, 064030 (2006); 80, 012345 (2009).'],
    ['a titled paper and a second paper by others', 'A. Smith, Deep residual learning for image recognition, Phys. Rev. D 82, 1 (2010); B. Jones et al., Phys. Rev. D 83, 2 (2011).'],
    // A bracket with names or title words in it is another work, not a reprint of this one.
    ['a bracketed second work with its own author', 'J. Roe, Phys. Rev. D 73, 064030 (2006) [K. Poe, Phys. Rev. D 80, 012345 (2009)].'],
    ['a bracketed second work with its own title', 'J. Roe, Phys. Rev. D 73, 064030 (2006) [Waves in the early universe, Phys. Rev. D 80, 012345 (2009)].'],
    ['a bracketed second work by two people', 'J. Roe, Phys. Rev. D 73, 064030 (2006) [Smith and Jones, Phys. Rev. D 80, 012345 (2009)].'],
    // A bracket that names a person, even by surname alone, is another work.
    ['a bracketed second work by a surname alone', 'J. Doe, Phys. Rev. D 82, 1 (2010) [Smith, Phys. Rev. Lett. 107, 2 (2011)].'],
    // A note marks only itself: an erratum or a note on the last work does not hide that work.
    ['[64] with an INSPIRE erratum on its second work', `${LIGO_64.slice(0, -1)} [Erratum: Classical Quantum Gravity 27, 179801 (2010)].`],
    ['[64] with "[erratum]" on its second work', `${LIGO_64.slice(0, -1)} [erratum].`],
    ['[64] with a note field', `${LIGO_64} Note: calibration paper.`],
    ['two titled works, an erratum on the second', `${TWO} [Erratum: Phys. Rev. Lett. 108, 069901 (2012)].`],
    ['two titled works, "Erratum ibid." on the second', `${TWO}; Erratum ibid. 108, 069901 (2012).`],
    ['two titled works, "[erratum]" on the first', 'A. Author, Gravitational self-force at second order, Phys. Rev. D 82, 104001 (2010) [erratum]; C. Author, Quasinormal ringing of rotating black holes, Phys. Rev. Lett. 107, 151101 (2011).'],
    ['two titled works, an erratum named after the first', 'A. Author, Gravitational self-force at second order, Phys. Rev. D 82, 104001 (2010), Erratum: Phys. Rev. D 83, 1 (2011); C. Author, Quasinormal ringing of rotating black holes, Phys. Rev. Lett. 107, 151101 (2012).'],
    // A bracketed note marks only the locator it stands after: the second work's locator still counts.
    ['"(E)" on the first work, then another', 'A. Author, Gravitational self-force at second order, Phys. Rev. D 82, 104001 (2010) (E), Phys. Rev. Lett. 107, 151101 (2011).'],
    ['a first title with a note word in it', 'A. Author, Neural machine translation of physics papers, Phys. Rev. D 82, 104001 (2010), Phys. Rev. Lett. 107, 151101 (2011).'],
  ])('is read as several works: %s', (_what, text) => {
    expect(citesSeveralWorks(text)).toBe(true);
  });

  test('is Can\'t check before any lookup, with a plain reason', () => {
    const v = preLookupVerdict(parse(LIGO_64));
    expect(v?.status).toBe('cant_check');
    expect(v?.reason).toBe(SEVERAL);
  });

  test('read whole, is never Not found, even when every source was searched and nothing matched', () => {
    const v = classify({ citation: parse(LIGO_64), searched: ALL, failed: [] });
    expect(v.status).toBe('cant_check');
    expect(v.reason).toBe(SEVERAL);
  });

  test('has no journal locator, so the second work alone cannot make the row Verified', () => {
    expect(journalLocator(parse(LIGO_64))).toBeUndefined();
    expect(journalLocator(parse('A. Smith and B. Jones, Phys. Rev. D 82, 022003 (2010); C. Brown, Class. Quantum Grav. 27, 084024 (2011).'))).toBeUndefined();
  });

  test('read whole, is never Wrong ID, whatever its identifier resolves to', () => {
    const c = parse('A. Smith, Deep residual learning for image recognition, Phys. Rev. D 82, 1 (2010), arXiv:1001.00001; B. Jones and C. Doe, Phys. Rev. D 83, 2 (2011).');
    const other: WorkRecord = { source: 'arxiv', title: 'A completely different study of protein folding kinetics', authors: ['someone', 'else'], year: 2010, isRetracted: false, notes: [] };
    const v = classify({ citation: c, idResolvedTo: other, matchedVia: 'id', searched: ALL, failed: [] });
    expect(v.status).toBe('cant_check');
    expect(v.reason).toBe(SEVERAL);
  });
});

describe('a note on the same work is not a second work', () => {
  test.each([
    // Erratum and addendum entries from arXiv HTML pages, each one work.
    ['2503.00346#2', 'S. W. Hawking, “Particle Creation by Black Holes,” Commun. Math. Phys. 43, 199-220 (1975) [erratum: Commun. Math. Phys. 46, 206 (1976)].'],
    ['2503.00346#11', 'J. S. Cotler, G. Gur-Ari, M. Hanada, J. Polchinski, P. Saad, S. H. Shenker, D. Stanford, A. Streicher and M. Tezuka, “Black Holes and Random Matrices,” JHEP 05, 118 (2017) [erratum: JHEP 09, 002 (2018)] [arXiv:1611.04650 [hep-th]].'],
    ['2610.00844#9', 'R. Basu, A. Ganguly, S. Nath, and O. Parrikar (2024) Complexity growth and the Krylov–Wigner function. JHEP 2024 (05), pp. 264. Note: [Erratum: JHEP 03 (2026) 202]'],
    ['2610.00844#18', 'J. S. Cotler, G. Gur-Ari, M. Hanada, J. Polchinski, P. Saad, S. H. Shenker, D. Stanford, A. Streicher, and M. Tezuka (2017) Black holes and random matrices. JHEP 2017 (05), pp. 118. Note: [Erratum: JHEP 09 (2018) 002]'],
    ['2610.00844#57', 'L. Susskind (2016) Computational complexity and black hole horizons. Fortsch. Phys. 64, pp. 24–43. Note: [Addendum: Fortsch. Phys. 64 (2016) 44–48]'],
    ['an erratum page marked (E)', 'J. Roe and K. Poe, Phys. Rev. D 73, 064030 (2006); 74, 019901(E) (2006).'],
    ['an erratum page marked (E) a year later', 'J. Roe and K. Poe, Phys. Rev. D 73, 064030 (2005); 74, 019901(E) (2006).'],
    ['an erratum named after a comma', 'J. Roe, Phys. Rev. D 73, 064030 (2005), Erratum: Phys. Rev. D 74, 019901 (2006).'],
    ['"Erratum-ibid." after a semicolon', 'J. Roe, Phys. Rev. Lett. 95, 121101 (2005); Erratum-ibid. 96, 019901 (2006).'],
    ['a translation in brackets', 'M. E. Gertsenshtein and V. I. Pustovoit, Zh. Eksp. Teor. Fiz. 43, 605 (1962) [Sov. Phys. JETP 16, 433 (1963), English translation].'],
    // A bracketed part that holds only a journal locator is the same work printed again (a translation, a reprint).
    ['INSPIRE\'s Maldacena, with its republication in brackets', 'J. M. Maldacena, “The Large N limit of superconformal field theories and supergravity,” Adv. Theor. Math. Phys. 2, 231-252 (1998) [Int. J. Theor. Phys. 38, 1113 (1999)] [arXiv:hep-th/9711200 [hep-th]].'],
    ['the same, volume and year in brackets', 'J. M. Maldacena, The Large N limit of superconformal field theories and supergravity, Adv. Theor. Math. Phys. 2 (1998) 231 [Int. J. Theor. Phys. 38 (1999) 1113] [hep-th/9711200].'],
    ['a Russian journal and its translation', 'L. V. Keldysh, Zh. Eksp. Teor. Fiz. 47, 1515 (1964) [Sov. Phys. JETP 20, 1018 (1965)].'],
    ['a reprint with a place name', 'A. Einstein, Ann. Phys. (Leipzig) 17, 891 (1905) [Ann. Phys. (Berlin) 14, 194 (2005)].'],
    // An erratum marked after its own locator.
    ['"[erratum]" after the erratum\'s locator', 'W. Israel, Nuovo Cimento B 44, 1 (1966); B 48, 463 (1967) [erratum].'],
    ['"(Erratum)" after the erratum\'s locator', 'S. Coleman, Phys. Rev. D 15, 2929 (1977); 16, 1248 (1977) (Erratum).'],
    ['", Erratum." after the erratum\'s locator', 'S. Coleman, Phys. Rev. D 15, 2929 (1977); Phys. Rev. D 16, 1248 (1978), Erratum.'],
    // An "(E)" after the year, and an "(Erratum to ...)" after the erratum's locator.
    ['"(E)" after the erratum\'s year', 'A. Author, Tidal deformability of neutron stars in scalar tensor gravity, Phys. Rev. D 82, 104001 (2010); 84, 029901 (2011) (E).'],
    ['"(Erratum to ...)" after the erratum\'s locator', 'A. Author, Tidal deformability of neutron stars in scalar tensor gravity, Phys. Rev. D 82, 104001 (2010); Phys. Rev. D 84, 029901 (2011) (Erratum to Phys. Rev. D 82, 104001).'],
  ])('%s', (_what, text) => {
    expect(citesSeveralWorks(text)).toBe(false);
    expect(preLookupVerdict(parse(text))?.reason).not.toBe(SEVERAL);
  });
});

describe('one work, read as such (controls)', () => {
  test.each([
    ['AAAI names separated by ";"', 'Belkin, M.; and Niyogi, P. 2003. Laplacian eigenmaps for dimensionality reduction and data representation. Neural computation 15(6): 1373–1396.'],
    ['three AAAI names', 'Smith, J.; Jones, K.; and Brown, L. 2019. A study of things. In Proceedings of AAAI, 1–8.'],
    ['Vancouver "year;volume:pages"', 'Burez D, den Poel V. Handling class imbalance in customer churn prediction. Expert Syst Appl. 2009;36(3):4626–36.'],
    ['a title-less journal citation', 'C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)'],
    ['a title with a semicolon', 'A. Smith, Waves; a study of their motion, Phys. Rev. D 82, 1 (2010).'],
    ['a collaboration in brackets', 'B. P. Abbott et al. (LIGO Scientific Collaboration and Virgo Collaboration), Phys. Rev. Lett. 116, 061102 (2016).'],
    ['the volume and the year in brackets, and pages', 'G. ’t Hooft, Nucl. Phys. B 72 (1974) 461.'],
  ])('%s', (_what, text) => {
    expect(citesSeveralWorks(text)).toBe(false);
  });
});

describe('hostile text', () => {
  test('long runs of names, semicolons and numbers are read quickly', () => {
    const texts = [
      `${'A. B. Cd Ef Gh, '.repeat(400)}x`,
      `2009; ${'A. B. Cd and E. F. Gh '.repeat(300)}`,
      `${'1 (2000), '.repeat(800)}`,
      `${'J. Roe, 2001; '.repeat(500)}`,
      `${'A. '.repeat(2000)}`,
      `${', A. B. Cd'.repeat(400)}`,
      `${'. A. B. Cd, '.repeat(300)}x`,
    ];
    for (const text of texts) {
      const start = performance.now();
      citesSeveralWorks(text);
      firstWorkText(text);
      firstWorkText(`J. Doe, A title, Phys. Rev. D 82, 1 (2010)${text}`);
      firstWorkText(`${text}, Phys. Rev. D 82, 1 (2010); A. Roe, Phys. Rev. D 83, 2 (2011)`);
      expect(performance.now() - start).toBeLessThan(200);
    }
  });
});

describe('a republication in brackets keeps the work checkable', () => {
  // INSPIRE prints Maldacena 1997 this way; it is Verified by its arXiv id.
  const record: WorkRecord = { source: 'arxiv', title: 'The Large N Limit of Superconformal Field Theories and Supergravity', authors: ['maldacena'], year: 1997, arxivId: 'hep-th/9711200', doi: '10.1023/A:1026654312961', isRetracted: false, notes: [] };
  test.each([
    'J. M. Maldacena, “The Large N limit of superconformal field theories and supergravity,” Adv. Theor. Math. Phys. 2, 231-252 (1998) [Int. J. Theor. Phys. 38, 1113 (1999)] [arXiv:hep-th/9711200 [hep-th]].',
    'J. M. Maldacena, The Large N limit of superconformal field theories and supergravity, Adv. Theor. Math. Phys. 2 (1998) 231 [Int. J. Theor. Phys. 38 (1999) 1113] [hep-th/9711200].',
  ])('%s', (text) => {
    const c = parse(text);
    expect(preLookupVerdict(c)).toBeUndefined();
    expect(classify({ citation: c, idResolvedTo: record, match: record, matchedVia: 'id', searched: ALL, failed: [] }).status).toBe('verified');
  });
});
