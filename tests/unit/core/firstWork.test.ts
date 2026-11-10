// The first work of an entry that cites several, checked alone when it is complete on its own.
import { describe, expect, test } from 'vitest';
import { SEVERAL_WORKS_REASON } from '../../../src/core/classify';
import { FIRST_WORK_FOUND_REASON, firstWorkOf, firstWorkVerdict } from '../../../src/core/firstWork';
import { parseCitation } from '../../../src/core/parseCitation';
import { firstWorkText } from '../../../src/core/severalWorks';

const parse = (text: string) => parseCitation({ index: 1, label: '[1]', text });
const INVENTED = 'J. Doe, A. Roe, Invented dynamics of quantum lattice spin chains in curved backgrounds, Phys. Rev. D 82, 123456 (2010)';
const LIGO_64 = 'E. Goetz et al., in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi Conference, Amaldi, New York, 2009; E. Goetz and R. L. Savage Jr., Classical Quantum Gravity 27, 084024 (2010).';

describe('the first work of an entry', () => {
  test.each([
    ['; A. Einstein, Ann. Phys. 49, 769 (1916).'],
    ['; 83, 1 (2011).'],
    ['; B. Jones et al., Phys. Rev. D 83, 2 (2011).'],
  ])('a titled journal paper with "%s" after it is checked by itself', (tail) => {
    expect(firstWorkText(INVENTED + tail)).toBe(INVENTED);
    const first = firstWorkOf(parse(INVENTED + tail));
    expect(first?.title).toBe('Invented dynamics of quantum lattice spin chains in curved backgrounds');
    expect(first?.raw).toBe(INVENTED);
  });

  // Whatever separates the works: the first part ends with its locator and the identifiers after it.
  test.each([
    [', A. Einstein, Ann. Phys. 49, 769 (1916).'],
    ['. A. Einstein, Ann. Phys. 49, 769 (1916).'],
    [';A. Einstein, Ann. Phys. 49, 769 (1916).'],
    [', Phys. Rev. D 83, 2 (2011).'],
    [' and Phys. Rev. D 83, 2 (2011).'],
    [' [A. Smith, Phys. Rev. Lett. 107, 2 (2011)].'],
  ])('a titled journal paper with "%s" after it is checked by itself', (tail) => {
    expect(firstWorkText(INVENTED + tail)).toBe(INVENTED);
    expect(firstWorkOf(parse(INVENTED + tail))?.raw).toBe(INVENTED);
  });

  test('the identifiers after the first locator are the first work\'s', () => {
    expect(firstWorkText(`${INVENTED}, doi:10.1103/PhysRevD.82.022003, Phys. Rev. D 83, 2 (2011).`)).toBe(`${INVENTED}, doi:10.1103/PhysRevD.82.022003`);
    expect(firstWorkText(`${INVENTED} [arXiv:1001.00001 [hep-th]]; A. Einstein, Ann. Phys. 49, 769 (1916).`)).toBe(`${INVENTED} [arXiv:1001.00001 [hep-th]]`);
  });

  test('a first part with an identifier and a year, and no locator, is checked by itself', () => {
    const text = 'J. Doe, Invented dynamics of quantum lattice spin chains, arXiv:1001.00001 (2010); A. Einstein, Ann. Phys. 49, 769 (1916).';
    expect(firstWorkText(text)).toBe('J. Doe, Invented dynamics of quantum lattice spin chains, arXiv:1001.00001 (2010)');
    expect(firstWorkOf(parse(text))?.arxivId).toBe('1001.00001');
  });

  test('a DOI before the first locator: the first work runs to the locator', () => {
    const text = 'J. Doe, Invented dynamics of quantum lattice spin chains, doi:10.1103/PhysRevD.82.123456, Phys. Rev. D 82, 123456 (2010); A. Einstein, Ann. Phys. 49, 769 (1916).';
    expect(firstWorkText(text)).toBe('J. Doe, Invented dynamics of quantum lattice spin chains, doi:10.1103/PhysRevD.82.123456, Phys. Rev. D 82, 123456 (2010)');
  });

  test('a first part with an identifier and no year is not complete', () => {
    expect(firstWorkText('J. Doe, Invented dynamics of quantum lattice spin chains, arXiv:1001.00001; A. Einstein, Ann. Phys. 49, 769 (1916).')).toBeUndefined();
  });

  test('a first part with its own identifier is checked by itself', () => {
    const first = firstWorkOf(parse('A. Smith, Deep residual learning for image recognition, Phys. Rev. D 82, 1 (2010), arXiv:1001.00001; B. Jones and C. Doe, Phys. Rev. D 83, 2 (2011).'));
    expect(first?.arxivId).toBe('1001.00001');
  });

  test.each([
    ['[64]: "in <Proceedings>" is no title, and the first part has no venue of its own', LIGO_64],
    ['a title-less first part', 'J. Roe, Phys. Rev. D 73, 064030 (2006); K. Poe, Phys. Rev. D 80, 012345 (2009).'],
    // A first part with no year of its own is not complete: the first year is the second work's.
    ['a first part with no year, then two works', 'A. Author, Tidal deformability of neutron stars in scalar tensor gravity, Phys. Rev. D 82, 104001; B. Other, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2013); C. Third, Gravitational self-force at second order, Phys. Rev. D 84, 104001 (2014).'],
    ['a first part with no year, then a second locator', 'A. Author, Tidal deformability of neutron stars in scalar tensor gravity, Phys. Rev. D 82, 104001, Phys. Rev. Lett. 107, 151101 (2013), Phys. Rev. D 84, 104001 (2014).'],
    ['a first part with no year, then names after a comma', 'A. Author, Tidal deformability of neutron stars in scalar tensor gravity, Phys. Rev. D 82, 104001, B. Other, Quasinormal ringing, Phys. Rev. Lett. 107, 151101 (2013), C. Third, Phys. Rev. D 84, 104001 (2014).'],
    // A proceedings paper with no locator: the [64] shape with a title.
    ['a proceedings first part, erratum on the second', 'A. Author, Gravitational self-force in extreme mass ratio inspirals at second order, in Proceedings of the Capra Meeting, 2010; C. Author, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2011) [Erratum: Phys. Rev. Lett. 108, 069901 (2012)].'],
    ['one work (nothing to split)', `${INVENTED}.`],
  ])('none: %s', (_what, text) => {
    expect(firstWorkOf(parse(text))).toBeUndefined();
  });
});

test('two works with no semicolon between them: the first is checked by itself', () => {
  const text = 'J. Roe, Waves in the early universe and their spectra, Phys. Rev. D 73, 064030 (2006), Phys. Rev. D 80, 012345 (2009).';
  expect(firstWorkOf(parse(text))?.raw).toBe('J. Roe, Waves in the early universe and their spectra, Phys. Rev. D 73, 064030 (2006)');
});

describe('the entry\'s verdict from its first work\'s', () => {
  test('Verified is never shown: it is Can\'t check, saying the first work was found', () => {
    expect(firstWorkVerdict({ status: 'verified', reason: 'Matches', diffs: [], notes: [] })).toEqual({ status: 'cant_check', reason: FIRST_WORK_FOUND_REASON, diffs: [], notes: [] });
  });
  test('Can\'t check is the entry\'s own', () => {
    expect(firstWorkVerdict({ status: 'cant_check', reason: 'x', diffs: [], notes: [] }).reason).toBe(SEVERAL_WORKS_REASON);
  });
  test.each(['not_found', 'wrong_id', 'retracted', 'details_differ'] as const)('%s stands, and says it is about the first work', (status) => {
    const v = firstWorkVerdict({ status, reason: 'Some reason', diffs: [], notes: [] });
    expect(v.status).toBe(status);
    expect(v.reason).toMatch(/^About the first work in this entry, which cites more than one: Some reason$/);
  });
});
