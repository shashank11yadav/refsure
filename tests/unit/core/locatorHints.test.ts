// A title-less "et al." citation ("P. Astone et al., Phys. Rev. D 82, 022003 (2010).") is often not
// among Crossref's first ten answers, which are errata of the same volume. A second request is made with what the
// locator itself gives: the DOI some publishers build from it, or else the first author's surname.
import { describe, expect, test } from 'vitest';
import { journalLocator } from '../../../src/core/journalLocator';
import { locatorFirstSurname, publisherDoi } from '../../../src/core/locatorHints';
import type { ParsedCitation } from '../../../src/core/types';

// What the locator path sees: a reference that has no title.
const parse = (text: string): ParsedCitation => ({ raw: text, authors: [], kind: 'paper', confidence: 0.9 });

function doiOf(text: string): string | undefined {
  const c = parse(text);
  const loc = journalLocator(c);
  if (loc === undefined) throw new Error(`no locator in ${text}`);
  return publisherDoi(c, loc);
}

function surnameOf(text: string): string | undefined {
  const c = parse(text);
  const loc = journalLocator(c);
  if (loc === undefined) throw new Error(`no locator in ${text}`);
  return locatorFirstSurname(c, loc);
}

describe('publisherDoi: the DOI APS and IOP build from journal, volume and page', () => {
  test.each([
    // From 1602.03837 (LIGO).
    ['P. Astone et al., Phys. Rev. D 82, 022003 (2010).', '10.1103/PhysRevD.82.022003'],
    ['A. H. Mroué et al., Phys. Rev. Lett. 111, 241104 (2013).', '10.1103/PhysRevLett.111.241104'],
    ['B. Allen, Phys. Rev. D 71, 062001 (2005).', '10.1103/PhysRevD.71.062001'],
    ['S. M. Aston et al., Classical Quantum Gravity 29, 235004 (2012).', '10.1088/0264-9381/29/23/235004'],
    ['F. Acernese et al., Classical Quantum Gravity 32, 024001 (2015).', '10.1088/0264-9381/32/2/024001'],
    ['J. Aasi et al., Classical Quantum Gravity 32, 074001 (2015).', '10.1088/0264-9381/32/7/074001'],
    // other ways of writing the same journals
    ['C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)', '10.1103/PhysRev.124.925'],
    ['H. Everett, Rev. Mod. Phys. 29, 454 (1957)', '10.1103/RevModPhys.29.454'],
    ['E.V. Linder, Phys. Rev. D81, 127301 (2010)', '10.1103/PhysRevD.81.127301'],
    ['G. Amelino-Camelia, M. Arzano, Phys. Rev. D 88(4), 041303 (2013)', '10.1103/PhysRevD.88.041303'],
    ['C. Johnson, Phys. Rev. D 101, no.10, 106023 (2020)', '10.1103/PhysRevD.101.106023'],
    ['J. Roe et al., Phys. Rev. D 82 (2010) 022003.', '10.1103/PhysRevD.82.022003'],
    ['J. Roe, Physical Review Letters 116, 061102 (2016).', '10.1103/PhysRevLett.116.061102'],
    ['J. Roe, Phys. Rev. B 41, 11697 (1990).', '10.1103/PhysRevB.41.11697'],
    ['J. Roe, Phys. Rev. X 6, 041004 (2016).', '10.1103/PhysRevX.6.041004'],
    ['J. Roe, Phys. Rev. Applied 10, 064008 (2018).', '10.1103/PhysRevApplied.10.064008'],
    ['J. Roe, Phys. Rev. Research 3, 043066 (2021).', '10.1103/PhysRevResearch.3.043066'],
    ['J. Roe, PRX Quantum 2, 040317 (2021).', '10.1103/PRXQuantum.2.040317'],
    ['J. Roe, Class. Quantum Grav. 25, 065007 (2008).', '10.1088/0264-9381/25/6/065007'],
    ['J. Roe, Class. Quant. Grav. 33, 245006 (2016).', '10.1088/0264-9381/33/24/245006'],
    ['J. Roe, New J. Phys. 12, 063020 (2010).', '10.1088/1367-2630/12/6/063020'],
    ['J. Roe, J. Phys.: Condens. Matter 22, 255502 (2010).', '10.1088/0953-8984/22/25/255502'],
    ['J. Roe, J. Phys. A: Math. Theor. 43, 285205 (2010).', '10.1088/1751-8113/43/28/285205'],
    ['J. Roe, J. Phys. A 41, 145501 (2008).', '10.1088/1751-8113/41/14/145501'],
  ])('%s', (text, doi) => {
    expect(doiOf(text)).toBe(doi);
  });

  test.each([
    // IOP gave Classical and Quantum Gravity other DOIs before article numbers (2008) and after 2016 (1361-6382/aa556f)
    'G. M. Harry et al., Classical Quantum Gravity 24, 405 (2007).',
    'J. Roe, Class. Quantum Grav. 34, 035020 (2017).',
    'J. Roe, Class. Quantum Grav. 21, S1595 (2004).',
    // other publishers build their DOIs some other way
    'C. L. Mueller et al., Rev. Sci. Instrum. 87, 014502 (2016).',
    'J. Roe, Nucl. Phys. B 474 (1996) 122',
    'D. Aronov, R. Nevers, and D. W. Tank, Nature 543, 719 (2017).',
    // the Physical Review itself ended with volume 188 (1969); a page with letters is no APS page
    'J. Roe, Phys. Rev. 212, 925 (1975).',
    'J. Roe, Phys. Rev. D 82, e022003 (2010).',
    // a longer journal name that only ends like an APS one
    'J. Roe, Chin. Phys. Rev. D 82, 022003 (2010).',
  ])('none for %s', (text) => {
    expect(doiOf(text)).toBeUndefined();
  });
});

describe('locatorFirstSurname: the first author, for a search by author', () => {
  test.each([
    ['P. Astone et al., Phys. Rev. D 82, 022003 (2010).', 'astone'],
    ['A. H. Mroué et al., Phys. Rev. Lett. 111, 241104 (2013).', 'mroue'],
    ['G. M. Harry et al., Classical Quantum Gravity 24, 405 (2007).', 'harry'],
    ['C. L. Mueller et al., Rev. Sci. Instrum. 87, 014502 (2016).', 'mueller'],
    ['C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)', 'brans'],
    ['Aasi, J., Abbott, B. P., et al., Phys. Rev. D 87, 022002 (2013).', 'aasi'],
  ])('%s', (text, surname) => {
    expect(surnameOf(text)).toBe(surname);
  });

  test.each([
    'Phys. Rev. D 82, 022003 (2010).',
    'Nature 571, 95 (2019).',
    'LIGO Scientific Collaboration, Phys. Rev. D 82, 022003 (2010).',
  ])('none for %s', (text) => {
    expect(surnameOf(text)).toBeUndefined();
  });
});
