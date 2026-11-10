// An entry that cites more than one work (1602.03837 [64]) is Can't check before anything is looked up,
// unless its first part is a complete work on its own; then that part alone is checked (below). Whatever the services
// would answer, it is never Verified on one of its works alone.
import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));
import type { WorkRecord } from '../../../src/core/types';
import { checkReference } from '../../../src/engine/checker';
import { makeDeps, mockSources, ref } from '../helpers/engine';

const controller = (): AbortSignal => new AbortController().signal;
const SEVERAL = 'This entry cites more than one work, and RefSure checks one work at a time';
const LIGO_64 = 'E. Goetz et al., in Gravitational Waves: Proceedings, of the 8th Edoardo Amaldi Conference, Amaldi, New York, 2009; E. Goetz and R. L. Savage Jr., Classical Quantum Gravity 27, 084024 (2010).';

// The second work of [64], as Crossref holds it.
const SECOND_WORK: WorkRecord = {
  source: 'crossref',
  title: 'Calibration of the LIGO displacement actuators via laser frequency modulation',
  authors: ['goetz', 'savage', 'kissel'],
  year: 2010,
  venue: 'Classical and Quantum Gravity',
  venues: ['Classical and Quantum Gravity', 'Class. Quantum Grav.'],
  volume: '27',
  pages: ['084024'],
  doi: '10.1088/0264-9381/27/8/084024',
  isRetracted: false,
  notes: [],
};

describe('an entry that cites more than one work', () => {
  test('is Can\'t check, and nothing is looked up', async () => {
    const sources = mockSources();
    const searchLocator = vi.fn(() => Promise.resolve([SECOND_WORK]));
    Object.assign(sources.crossref, { searchLocator });
    const deps = makeDeps(sources);
    const r = await checkReference(ref(64, LIGO_64), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(SEVERAL);
    expect(searchLocator).not.toHaveBeenCalled();
    for (const s of [sources.crossref, sources.arxiv, sources.openreview, sources.dblp, sources.openalex]) {
      expect(s.search).not.toHaveBeenCalled();
      expect(s.lookupById).not.toHaveBeenCalled();
    }
  });

  test('is not Verified on its second work, even when a title search would find it', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([SECOND_WORK]) } });
    const r = await checkReference(ref(64, LIGO_64), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
  });

});

// When the entry's first part is a complete work on its own (a credible title with a venue or a locator, or its own
// identifier), that part is checked alone. Its Not found, Wrong ID, Retracted or Details differ stand, said to be about
// the first work; its Verified is not shown as Verified, since the entry cites more than one work.
describe('an entry whose first work is complete on its own', () => {
  const INVENTED = 'J. Doe, A. Roe, Invented dynamics of quantum lattice spin chains in curved backgrounds, Phys. Rev. D 82, 123456 (2010)';
  const FIRST = /first work in this entry/i;

  test.each([
    ['another author\'s paper', '; A. Einstein, Ann. Phys. 49, 769 (1916).'],
    ['a continuation of another year', '; 83, 1 (2011).'],
  ])('an invented first work is Not found when %s is appended', async (_what, tail) => {
    const deps = makeDeps(mockSources());
    const r = await checkReference(ref(1, INVENTED + tail), deps, controller());
    expect(r.status).toBe('not_found');
    expect(r.reason).toMatch(FIRST);
    expect(r.citedText).toBe(INVENTED + tail);
    expect(deps.cache.sets).toEqual([]);
  });

  test('a made-up first work with the real DOI of another paper is Wrong ID, with a second work appended', async () => {
    const other: WorkRecord = { source: 'crossref', title: 'Search for gravitational waves from known pulsars', authors: ['astone', 'babusci'], year: 2010, doi: '10.1103/physrevd.82.022003', isRetracted: false, notes: [] };
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(other) } });
    const text = `${INVENTED}, doi:10.1103/PhysRevD.82.022003; A. Einstein, Ann. Phys. 49, 769 (1916).`;
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(r.status).toBe('wrong_id');
    expect(r.reason).toMatch(FIRST);
  });

  test('a first work whose arXiv id names another paper is Wrong ID', async () => {
    const other: WorkRecord = { ...SECOND_WORK, source: 'arxiv', title: 'A completely different study of protein folding kinetics', authors: ['someone', 'else'], doi: undefined as unknown as string };
    const sources = mockSources({ arxiv: { lookupById: () => Promise.resolve(other) } });
    const text = 'A. Smith, Deep residual learning for image recognition, Phys. Rev. D 82, 1 (2010), arXiv:1001.00001; B. Jones and C. Doe, Phys. Rev. D 83, 2 (2011).';
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(r.status).toBe('wrong_id');
    expect(r.reason).toMatch(FIRST);
  });

  test('a first work that is found is Can\'t check, never Verified, and says the first work was found', async () => {
    const first: WorkRecord = { source: 'crossref', title: 'Invented dynamics of quantum lattice spin chains in curved backgrounds', authors: ['doe', 'roe'], year: 2010, doi: '10.1103/physrevd.82.123456', isRetracted: false, notes: [] };
    const sources = mockSources({ crossref: { search: () => Promise.resolve([first]) } });
    const deps = makeDeps(sources);
    const r = await checkReference(ref(1, `${INVENTED}; A. Einstein, Ann. Phys. 49, 769 (1916).`), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/first work in this entry was found/i);
    expect(r.match).toBeUndefined();
    expect(r.links).toEqual([]);
    expect(deps.cache.sets).toEqual([]);
  });

  test('a retracted first work is Retracted', async () => {
    const first: WorkRecord = { source: 'crossref', title: 'Invented dynamics of quantum lattice spin chains in curved backgrounds', authors: ['doe', 'roe'], year: 2010, doi: '10.1103/physrevd.82.123456', isRetracted: true, notes: [] };
    const sources = mockSources({ crossref: { search: () => Promise.resolve([first]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, noticeDoi: '10.1103/physrevd.99.000001' })) } });
    const r = await checkReference(ref(1, `${INVENTED}; A. Einstein, Ann. Phys. 49, 769 (1916).`), deps, controller());
    expect(r.status).toBe('retracted');
    expect(r.reason).toMatch(FIRST);
  });

  test('a first work with no venue of its own ([64]) keeps the Can\'t check for several works', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([SECOND_WORK]) } });
    const r = await checkReference(ref(64, LIGO_64), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(SEVERAL);
  });

  test('a first work with no title of its own keeps the Can\'t check for several works', async () => {
    const sources = mockSources();
    const r = await checkReference(ref(1, 'J. Roe, Phys. Rev. D 73, 064030 (2006); K. Poe, Phys. Rev. D 80, 012345 (2009).'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(SEVERAL);
  });
});

// A note marks only itself, so an erratum on a later work does not hide that work.
describe('an erratum on the second work', () => {
  test('two titled works, erratum on the second, the first found: Can\'t check, never Details differ', async () => {
    const first: WorkRecord = { source: 'crossref', title: 'Gravitational self-force in extreme mass ratio inspirals at second order', authors: ['author', 'author'], year: 2010, venue: 'Physical Review D', venues: ['Physical Review D', 'Phys. Rev. D'], volume: '82', pages: ['104001'], doi: '10.1103/physrevd.82.104001', isRetracted: false, notes: [] };
    const text = 'A. Author and B. Author, Gravitational self-force in extreme mass ratio inspirals at second order, Phys. Rev. D 82, 104001 (2010); C. Author, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2011) [Erratum: Phys. Rev. Lett. 108, 069901 (2012)].';
    const r = await checkReference(ref(1, text), makeDeps(mockSources({ crossref: { search: () => Promise.resolve([first]) } })), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/first work in this entry was found/i);
  });

  // Each of these is one work, and Verified.
  test.each([
    ['"(E)" after the year', 'Phys. Rev. D 82, 104001 (2010); 84, 029901 (2011) (E).'],
    ['"(Erratum to ...)" after the second locator', 'Phys. Rev. D 82, 104001 (2010); Phys. Rev. D 84, 029901 (2011) (Erratum to Phys. Rev. D 82, 104001).'],
  ])('a single work with its erratum written %s is Verified', async (_what, tail) => {
    const title = 'Tidal deformability of neutron stars in scalar tensor gravity';
    const a: WorkRecord = { source: 'crossref', title, authors: ['author'], year: 2010, venue: 'Physical Review D', venues: ['Physical Review D', 'Phys. Rev. D'], volume: '82', pages: ['104001'], doi: '10.1103/physrevd.82.104001', isRetracted: false, notes: [] };
    const r = await checkReference(ref(1, `A. Author, ${title}, ${tail}`), makeDeps(mockSources({ crossref: { search: () => Promise.resolve([a]) } })), controller());
    expect(r.status).toBe('verified');
  });

  test('a real single work with an erratum stays Verified', async () => {
    const hawking: WorkRecord = { source: 'crossref', title: 'Particle creation by black holes', authors: ['hawking'], year: 1975, venue: 'Communications in Mathematical Physics', venues: ['Communications in Mathematical Physics', 'Commun. Math. Phys.'], volume: '43', pages: ['199-220'], doi: '10.1007/bf02345020', isRetracted: false, notes: [] };
    const text = 'S. W. Hawking, “Particle Creation by Black Holes,” Commun. Math. Phys. 43, 199-220 (1975) [erratum: Commun. Math. Phys. 46, 206 (1976)].';
    const r = await checkReference(ref(1, text), makeDeps(mockSources({ crossref: { search: () => Promise.resolve([hawking]) } })), controller());
    expect(r.status).toBe('verified');
  });
});

// The first work is cut off whatever separates it from the second, and only when it has its own
// year and locator; an erratum on a later work does not hide that work.
describe('the first work, whatever separates it', () => {
  const INVENTED = 'J. Doe, A. Roe, Invented dynamics of quantum lattice spin chains in curved backgrounds, Phys. Rev. D 82, 123456 (2010)';
  const OTHER: WorkRecord = { source: 'crossref', title: 'Search for gravitational waves from known pulsars', authors: ['astone', 'babusci'], year: 2010, doi: '10.1103/physrevd.82.022003', isRetracted: false, notes: [] };

  test.each([
    ['", " then another author\'s paper', `${INVENTED}, A. Einstein, Ann. Phys. 49, 769 (1916).`],
    ['". " then another author\'s paper', `${INVENTED}. A. Einstein, Ann. Phys. 49, 769 (1916).`],
    ['";" with no space', `${INVENTED};A. Einstein, Ann. Phys. 49, 769 (1916).`],
    ['a second locator after a comma', `${INVENTED}, Phys. Rev. D 83, 2 (2011).`],
    ['a second locator after "and"', `${INVENTED} and Phys. Rev. D 83, 2 (2011).`],
    ['the first year left out (one work)', 'J. Doe, A. Roe, Invented dynamics of quantum lattice spin chains in curved backgrounds, Phys. Rev. D 82, 123456; A. Einstein, Ann. Phys. 49, 769 (1916).'],
  ])('an invented first work is Not found: %s', async (_what, text) => {
    expect((await checkReference(ref(1, text), makeDeps(mockSources()), controller())).status).toBe('not_found');
  });

  test('a made-up first work with the DOI of another, then a second locator after a comma, is Wrong ID', async () => {
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(OTHER) } });
    const r = await checkReference(ref(1, `${INVENTED}, doi:10.1103/PhysRevD.82.022003, Phys. Rev. D 83, 2 (2011).`), makeDeps(sources), controller());
    expect(r.status).toBe('wrong_id');
  });

  // A first work with no year: the first year is the second work's, so the "first work" would be two read as one.
  const A: WorkRecord = { source: 'crossref', title: 'Tidal deformability of neutron stars in scalar tensor gravity', authors: ['author'], year: 2010, venue: 'Physical Review D', volume: '82', pages: ['104001'], doi: '10.1103/physrevd.82.104001', isRetracted: false, notes: [] };
  const B: WorkRecord = { source: 'crossref', title: 'Quasinormal ringing of rotating black holes in modified gravity', authors: ['other'], year: 2013, venue: 'Physical Review Letters', volume: '107', pages: ['151101'], doi: '10.1103/physrevlett.107.151101', isRetracted: false, notes: [] };
  const HEAD_A = 'A. Author, Tidal deformability of neutron stars in scalar tensor gravity, Phys. Rev. D 82, 104001';
  const TAIL_C = '; C. Third, Gravitational self-force at second order, Phys. Rev. D 84, 104001 (2014).';
  test.each([
    ['A, B (2013), C', `${HEAD_A}; B. Other, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2013)${TAIL_C}`],
    ['A, B (2013) with B\'s DOI, C', `${HEAD_A}; B. Other, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2013), doi:10.1103/PhysRevLett.107.151101${TAIL_C}`],
    ['A, B (2013), C, with commas', `${HEAD_A}, B. Other, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2013), doi:10.1103/PhysRevLett.107.151101, C. Third, Phys. Rev. D 84, 104001 (2014).`],
  ])('a first work with no year is never set against the second\'s year or DOI: %s', async (_what, text) => {
    const r = await checkReference(ref(1, text), makeDeps(mockSources({ crossref: { search: () => Promise.resolve([A]), lookupById: () => Promise.resolve(B) } })), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(SEVERAL);
  });

  // [64] with a title: a proceedings paper no database holds, then a journal paper with an INSPIRE erratum.
  test('a proceedings first work, erratum on the second, is Can\'t check', async () => {
    const text = 'A. Author, Gravitational self-force in extreme mass ratio inspirals at second order, in Proceedings of the Capra Meeting, 2010; C. Author, Quasinormal ringing of rotating black holes in modified gravity, Phys. Rev. Lett. 107, 151101 (2011) [Erratum: Phys. Rev. Lett. 108, 069901 (2012)].';
    const r = await checkReference(ref(64, text), makeDeps(mockSources()), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(SEVERAL);
  });
});
