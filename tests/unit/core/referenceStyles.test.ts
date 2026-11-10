// Citation styles that can put authors, a venue or a note into the cited title: SIAM's "Authors, Title, Abbrev. J., 16
// (2001), pp. 263–277", REVTeX's "Authors, Title (2025), arXiv:2502.13522 [physics.chem-ph] ." and a BibTeX "Note:
// arXiv preprint ..." field, none of which is more of the title.
import { describe, expect, test } from 'vitest';
import { classify, comparedWith, isCredibleTitle } from '../../../src/core/classify';
import { parseCitation } from '../../../src/core/parseCitation';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, RawReference, WorkRecord } from '../../../src/core/types';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });
const ALL = [...REQUIRED_SOURCES];
const rec = (o: Partial<WorkRecord> & { title: string; authors: string[] }): WorkRecord => ({ source: 'crossref', isRetracted: false, notes: [], ...o });
const byId = (c: ParsedCitation, r: WorkRecord): string => classify({ citation: c, match: r, matchedVia: 'id', idResolvedTo: r, searched: ALL, failed: [] }).status;
const bySearch = (c: ParsedCitation, r: WorkRecord): string => classify({ citation: c, match: r, matchedVia: 'search', searched: ALL, failed: [] }).status;
const nothingFound = (c: ParsedCitation): string => classify({ citation: c, searched: ALL, failed: [] }).status;

// --- SIAM -------------------------------------------------------------------------------------------------------------

// 2610.27434, as the page gives them.
const AU = 'S.-K. Au and J. L. Beck, Estimation of small failure probabilities in high dimensions by subset simulation, Probabilistic Eng. Mech., 16 (2001), pp. 263–277, https://doi.org/10.1016/S0266-8920(01)00019-4.';
const DEMATTEIS = 'G. Dematteis, T. Grafke, and E. Vanden-Eijnden, Extreme event quantification in dynamical systems with random components, SIAM/ASA J. Uncertain. Quant., 7 (2019), pp. 1029–1059, https://doi.org/10.1137/18M1211003.';
const EBENER = 'L. Ebener, G. Margazoglou, J. Friedrich, L. Biferale, and R. Grauer, Instanton based importance sampling for rare events in stochastic PDEs, Chaos, 29 (2019), p. 063102, https://doi.org/10.1063/1.5085119.';
const EHRE = 'M. Ehre, I. Papaioannou, and D. Straub, Estimating rare event probabilities with Stein variational gradient descent, Int. J. Uncertain. Quantif., 16 (2026), https://doi.org/10.1615/Int.J.UncertaintyQuantification.2025054946.';
const MAES = 'M. A. Maes, K. Breitung, and D. J. Dupuis, Asymptotic importance sampling, Structural Safety, 12 (1993), pp. 167–186, https://doi.org/10.1016/0167-4730(93)90001-H.';
const RACKWITZ = 'R. Rackwitz, Reliability analysis–a review and some perspectives, Struct. Saf., 23 (2001), pp. 365–395, https://doi.org/10.1016/S0167-4730(02)00009-7.';
const SIEGMUND = 'D. Siegmund, Importance Sampling in the Monte Carlo Study of Sequential Tests, Ann. Stat., 4 (1976), pp. 673 – 684, https://doi.org/10.1214/aos/1176343541.';

const auRecord = rec({ title: 'Estimation of small failure probabilities in high dimensions by subset simulation', authors: ['au', 'beck'], year: 2001, venue: 'Probabilistic Engineering Mechanics', venues: ['Probabilistic Engineering Mechanics'], volume: '16', pages: ['263'], doi: '10.1016/s0266-8920(01)00019-4' });
const dematteisRecord = rec({ title: 'Extreme Event Quantification in Dynamical Systems with Random Components', authors: ['dematteis', 'grafke', 'vanden eijnden'], year: 2019, venue: 'SIAM/ASA Journal on Uncertainty Quantification', venues: ['SIAM/ASA Journal on Uncertainty Quantification', 'SIAM/ASA J. Uncertainty Quantification'], shortVenues: ['SIAM/ASA J. Uncertainty Quantification'], volume: '7', pages: ['1029'], doi: '10.1137/18m1211003' });
const ebenerRecord = rec({ title: 'Instanton based importance sampling for rare events in stochastic PDEs', authors: ['ebener', 'margazoglou', 'friedrich', 'biferale', 'grauer'], year: 2019, venue: 'Chaos: An Interdisciplinary Journal of Nonlinear Science', venues: ['Chaos: An Interdisciplinary Journal of Nonlinear Science'], volume: '29', pages: ['063102'], doi: '10.1063/1.5085119' });
const ehreRecord = rec({ title: 'ESTIMATING RARE EVENT PROBABILITIES WITH STEIN VARIATIONAL GRADIENT DESCENT', authors: ['ehre', 'papaioannou', 'straub'], year: 2026, venue: 'International Journal for Uncertainty Quantification', venues: ['International Journal for Uncertainty Quantification', 'Int. J. UncertaintyQuantification'], volume: '16', pages: ['79'], doi: '10.1615/int.j.uncertaintyquantification.2025054946' });
const maesRecord = rec({ title: 'Asymptotic importance sampling', authors: ['maes', 'breitung', 'dupuis'], year: 1993, venue: 'Structural Safety', venues: ['Structural Safety'], volume: '12', pages: ['167'], doi: '10.1016/0167-4730(93)90001-h' });
const rackwitzRecord = rec({ title: 'Reliability analysis—a review and some perspectives', authors: ['rackwitz'], year: 2001, venue: 'Structural Safety', venues: ['Structural Safety'], volume: '23', pages: ['365'], doi: '10.1016/s0167-4730(02)00009-7' });
const siegmundRecord = rec({ title: 'Importance Sampling in the Monte Carlo Study of Sequential Tests', authors: ['siegmund'], year: 1976, venue: 'The Annals of Statistics', venues: ['The Annals of Statistics', 'Ann. Statist.'], shortVenues: ['Ann. Statist.'], volume: '4', pages: ['673'], doi: '10.1214/aos/1176343541' });

describe('SIAM style: the authors end at the comma after the last name, the title at the comma before the journal', () => {
  test.each([
    [AU, ['au', 'beck'], 'Estimation of small failure probabilities in high dimensions by subset simulation', 'Probabilistic Eng. Mech., 16 (2001)'],
    [DEMATTEIS, ['dematteis', 'grafke', 'vanden eijnden'], 'Extreme event quantification in dynamical systems with random components', 'SIAM/ASA J. Uncertain. Quant., 7 (2019)'],
    [EBENER, ['ebener', 'margazoglou', 'friedrich', 'biferale', 'grauer'], 'Instanton based importance sampling for rare events in stochastic PDEs', 'Chaos, 29 (2019)'],
    [EHRE, ['ehre', 'papaioannou', 'straub'], 'Estimating rare event probabilities with Stein variational gradient descent', 'Int. J. Uncertain. Quantif., 16 (2026)'],
    [MAES, ['maes', 'breitung', 'dupuis'], 'Asymptotic importance sampling', 'Structural Safety, 12 (1993)'],
    [RACKWITZ, ['rackwitz'], 'Reliability analysis–a review and some perspectives', 'Struct. Saf., 23 (2001)'],
    [SIEGMUND, ['siegmund'], 'Importance Sampling in the Monte Carlo Study of Sequential Tests', 'Ann. Stat., 4 (1976)'],
    [
      'X. En, Y. Zhang, and X. Huang, Modified control variates method based on second-order saddle-point approximation for practical reliability analysis, Mech. Sci., 14 (2023), pp. 439–450, https://doi.org/10.5194/ms-14-439-2023.',
      ['en', 'zhang', 'huang'],
      'Modified control variates method based on second-order saddle-point approximation for practical reliability analysis',
      'Mech. Sci., 14 (2023)',
    ],
    [
      'Z. Hu, R. Mansour, M. Olsson, and X. Du, Second-order reliability methods: a review and comparative study, Struct. Multidiscip. Optim., 64 (2021), pp. 3233–3263, https://doi.org/10.1007/s00158-021-03013-y.',
      ['hu', 'mansour', 'olsson', 'du'],
      'Second-order reliability methods: a review and comparative study',
      'Struct. Multidiscip. Optim., 64 (2021)',
    ],
    [
      'A. Der Kiureghian and M. De Stefano, Efficient algorithm for second-order reliability analysis, J. Eng. Mech., 117 (1991), pp. 2904–2923, https://doi.org/10.1061/(ASCE)0733-9399(1991)117:12(2904).',
      ['der kiureghian', 'de stefano'],
      'Efficient algorithm for second-order reliability analysis',
      'J. Eng. Mech., 117 (1991)',
    ],
    [
      'F. Bouchet and J. Reygner, Path Integral Derivation and Numerical Computation of Large Deviation Prefactors for Non-equilibrium Dynamics Through Matrix Riccati Equations, J. Stat. Phys., 189 (2022), p. 21, https://doi.org/10.1007/s10955-022-02983-5.',
      ['bouchet', 'reygner'],
      'Path Integral Derivation and Numerical Computation of Large Deviation Prefactors for Non-equilibrium Dynamics Through Matrix Riccati Equations',
      'J. Stat. Phys., 189 (2022)',
    ],
    [
      'T. Grafke, R. Grauer, and T. Schäfer, The instanton method and its numerical implementation in fluid mechanics, J. Phys. A: Math. Theor., 48 (2015), p. 333001, https://doi.org/10.1088/1751-8113/48/33/333001.',
      ['grafke', 'grauer', 'schafer'],
      'The instanton method and its numerical implementation in fluid mechanics',
      'J. Phys. A: Math. Theor., 48 (2015)',
    ],
    // No volume: "Stat. Sci., (2017), pp. 405–431".
    [
      'S. Agapiou, O. Papaspiliopoulos, D. Sanz-Alonso, and A. M. Stuart, Importance sampling: Intrinsic dimension and computational cost, Stat. Sci., (2017), pp. 405–431, https://doi.org/10.1214/17-STS611.',
      ['agapiou', 'papaspiliopoulos', 'sanz alonso', 'stuart'],
      'Importance sampling: Intrinsic dimension and computational cost',
      'Stat. Sci., (2017)',
    ],
  ])('%s', (text, authors, title, venue) => {
    const c = parse(text);
    expect(c.authors).toEqual(authors);
    expect(c.title).toBe(title);
    expect(c.venue?.startsWith(venue)).toBe(true);
    expect(isCredibleTitle(c.title ?? '')).toBe(true);
  });

  test.each([
    [AU, auRecord],
    [DEMATTEIS, dematteisRecord],
    [EBENER, ebenerRecord],
    [EHRE, ehreRecord],
    [MAES, maesRecord],
    [RACKWITZ, rackwitzRecord],
    [SIEGMUND, siegmundRecord],
  ])('the record its DOI names is Verified: %s', (text, record) => {
    expect(byId(parse(text), record)).toBe('verified');
  });

  test('a title with a comma keeps it ("..., and implications for ...")', () => {
    const c = parse('J. Beh, J. Morio, and F. Simatos, Phase transition for conditional covariance matrices estimated by importance sampling, and implications for cross-entropy schemes in high dimension, Ann. Appl. Probab., 35 (2025), pp. 1–30.');
    expect(c.title).toBe('Phase transition for conditional covariance matrices estimated by importance sampling, and implications for cross-entropy schemes in high dimension');
  });

  test('a book in the same list ("..., Springer, 2012") is read as a book', () => {
    const c = parse('M. I. Freidlin and A. D. Wentzell, Random perturbations of dynamical systems, vol. 260, Springer, 2012, https://doi.org/10.1007/978-3-642-25847-3.');
    expect(c.title).toBe('Random perturbations of dynamical systems');
  });
});

describe('SIAM style, adversarial: an invented or altered citation dressed the same way', () => {
  test('an invented paper is Not found', () => {
    const c = parse('S.-K. Roe and J. L. Poe, Estimation of invented failure probabilities in imaginary dimensions by subset dreaming, Probabilistic Eng. Mech., 16 (2001), pp. 263–277.');
    expect(c.title).toBe('Estimation of invented failure probabilities in imaginary dimensions by subset dreaming');
    expect(nothingFound(c)).toBe('not_found');
  });

  test('an invented paper under a whole-word journal is Not found', () => {
    const c = parse('M. A. Roe and K. Poe, Asymptotic invented sampling for imaginary safety, Structural Safety, 12 (1993), pp. 167–186.');
    expect(nothingFound(c)).toBe('not_found');
  });

  test.each([
    ['changed title words', AU.replace('subset simulation', 'adaptive splitting'), auRecord],
    ['changed year', AU.replace('(2001)', '(2011)'), auRecord],
    ['changed author', AU.replace('J. L. Beck', 'J. L. Smith'), auRecord],
    ['changed title words, whole-word journal', MAES.replace('Asymptotic importance sampling', 'Asymptotic adaptive splitting'), maesRecord],
    ['changed year, abbreviation read as names before', SIEGMUND.replace('(1976)', '(1986)'), siegmundRecord],
  ])('%s is not Verified against the real record', (_what, text, record) => {
    expect(['details_differ', 'wrong_id', 'not_found']).toContain(byId(parse(text), record));
    expect(['details_differ', 'not_found', 'cant_check']).toContain(bySearch(parse(text), record));
  });

  test('a phrase added before a whole-word journal goes back to the title when the record has another journal', () => {
    const text = 'M. A. Maes, K. Breitung, and D. J. Dupuis, Asymptotic importance sampling, Revisited Methods, 12 (1993), pp. 167–186.';
    expect(comparedWith(parse(text), maesRecord).title).toBe('Asymptotic importance sampling, Revisited Methods');
    expect(byId(parse(text), maesRecord)).toBe('details_differ');
  });

  // "&" has no word of its own; skipping it must not skip the record check.
  test('a whole-word chunk with "&" that is not the record\'s venue goes back to the title', () => {
    const text = 'M. A. Maes, K. Breitung, and D. J. Dupuis, Asymptotic importance sampling, Theory & Practice, 12 (1993), pp. 167–186, https://doi.org/10.1016/0167-4730(93)90001-H.';
    expect(comparedWith(parse(text), maesRecord).title).toBe('Asymptotic importance sampling, Theory & Practice');
    expect(byId(parse(text), maesRecord)).toBe('details_differ');
    expect(bySearch(parse(text), maesRecord)).toBe('details_differ');
    expect(byId(parse(text.replace('&', 'and')), maesRecord)).toBe('details_differ');
  });

  test('a real "&" journal still reads as the venue ("Statistics & Computing" against Statistics and Computing)', () => {
    const record = rec({ title: 'Adaptive importance sampling in high dimension', authors: ['smith'], year: 2010, venue: 'Statistics and Computing', venues: ['Statistics and Computing'], volume: '20', doi: '10.1/z' });
    const c = parse('A. Smith, Adaptive importance sampling in high dimension, Statistics & Computing, 20 (2010), pp. 1–10, https://doi.org/10.1/z.');
    expect(comparedWith(c, record).title).toBe('Adaptive importance sampling in high dimension');
    expect(byId(c, record)).toBe('verified');
  });

  test('a phrase added before the real journal stays in the title', () => {
    const text = 'M. A. Maes, K. Breitung, and D. J. Dupuis, Asymptotic importance sampling, Invented Extensions, Structural Safety, 12 (1993), pp. 167–186.';
    expect(byId(parse(text), maesRecord)).toBe('details_differ');
  });

  test('against a record with no journal (a preprint), a whole-word journal goes back to the title', () => {
    const preprint = rec({ source: 'arxiv', title: 'Asymptotic importance sampling', authors: ['maes', 'breitung', 'dupuis'], year: 1993 });
    expect(comparedWith(parse(MAES), preprint).title).toBe('Asymptotic importance sampling, Structural Safety');
  });
});

// --- REVTeX -----------------------------------------------------------------------------------------------------------

// 2610.27412 [5] [13] [15].
const ROCKEN = 'S. Röcken and J. Zavadlav, Enhancing machine learning potentials through transfer learning across chemical elements (2025), arXiv:2502.13522 [physics.chem-ph] .';
const KIM = 'J. Z. Kim, O. Lesser, and D. Chowdhury, Charting the emergent low-dimensional manifold of quantum materials (2026), arXiv:2606.12520 [cond-mat.supr-con] .';
const PANIGRAHI = 'A. Panigrahi, Y. Liu, O. Lesser, K. Mallayya, and E.-A. Kim, Graphlet histogram representation database of inorganic crystals (2026), arXiv:2606.10195 [cond-mat.mtrl-sci] .';
const rockenRecord = rec({ source: 'arxiv', title: 'Enhancing Machine Learning Potentials through Transfer Learning across Chemical Elements', authors: ['rocken', 'zavadlav'], year: 2025, arxivId: '2502.13522' });
const kimRecord = rec({ source: 'arxiv', title: 'Charting the emergent low-dimensional manifold of quantum materials', authors: ['kim', 'lesser', 'chowdhury'], year: 2026, arxivId: '2606.12520' });

describe('REVTeX arXiv style: the title ends before " (<year>), arXiv:"', () => {
  test.each([
    [ROCKEN, ['rocken', 'zavadlav'], 'Enhancing machine learning potentials through transfer learning across chemical elements', '2502.13522'],
    [KIM, ['kim', 'lesser', 'chowdhury'], 'Charting the emergent low-dimensional manifold of quantum materials', '2606.12520'],
    [PANIGRAHI, ['panigrahi', 'liu', 'lesser', 'mallayya', 'kim'], 'Graphlet histogram representation database of inorganic crystals', '2606.10195'],
  ])('%s', (text, authors, title, arxivId) => {
    const c = parse(text);
    expect(c.authors).toEqual(authors);
    expect(c.title).toBe(title);
    expect(c.arxivId).toBe(arxivId);
    expect(c.year).toBe(Number(/\((\d{4})\)/.exec(text)?.[1]));
  });

  test.each([
    [ROCKEN, rockenRecord],
    [KIM, kimRecord],
  ])('the record its arXiv ID names is Verified: %s', (text, record) => {
    expect(byId(parse(text), record)).toBe('verified');
  });

  test('a title with a comma keeps it', () => {
    expect(parse('A. Roe and B. Poe, Learning, fast and slow, in quantum materials (2025), arXiv:2502.00001 [cond-mat.str-el] .').title).toBe('Learning, fast and slow, in quantum materials');
  });

  test('an entry with no title ("M. C. Miller et al., (2026), arXiv:...") still has none', () => {
    expect(parse('M. C. Miller et al., (2026), arXiv:2609.00965 [astro-ph.HE].').title).toBeUndefined();
  });

  test('an invented paper whose identifier leads nowhere is Not found', () => {
    const c = parse('A. Roe and B. Poe, Invented transfer of imaginary potentials across chemical dreams (2025), arXiv:2502.99999 [physics.chem-ph] .');
    expect(c.title).toBe('Invented transfer of imaginary potentials across chemical dreams');
    expect(nothingFound(c)).toBe('not_found');
  });

  test.each([
    ['changed title words', ROCKEN.replace('chemical elements', 'organic molecules')],
    ['changed year', ROCKEN.replace('(2025)', '(2019)')],
    ['changed author', ROCKEN.replace('J. Zavadlav', 'J. Smith')],
  ])('%s is not Verified against the real record', (_what, text) => {
    expect(['details_differ', 'wrong_id']).toContain(byId(parse(text), rockenRecord));
  });

  test('a different paper behind the cited identifier is Wrong ID', () => {
    const c = parse('A. Roe and B. Poe, Invented transfer of imaginary potentials across chemical dreams (2025), arXiv:2502.13522 [physics.chem-ph] .');
    expect(byId(c, rockenRecord)).toBe('wrong_id');
  });
});

// apsrev's "journal (year), eprint" for an accepted paper with no volume yet. The chunk before the year is
// the journal (or "in press"), never the end of the title.
describe('REVTeX arXiv style: a journal named before " (<year>), arXiv:" stays out of the title', () => {
  const topological = rec({ source: 'arxiv', title: 'Topological order in twisted bilayer graphene', authors: ['smith', 'jones'], year: 2024, venue: 'Nature Physics', venues: ['Nature Physics'], arxivId: '2401.01234' });
  const accepted = (journal: string, title = 'Topological order in twisted bilayer graphene', names = 'A. Smith and B. Jones'): string => `${names}, ${title}, ${journal} (2024), arXiv:2401.01234 [cond-mat.str-el] .`;

  test.each([['Nature Physics'], ['Nature'], ['JHEP'], ['SciPost Phys.'], ['in press'], ['Phys. Rev. Lett.'], ['to appear'], ['accepted'], ['submitted'], ['forthcoming'], ['Accepted']])('%s (2024), arXiv:', (journal) => {
    const c = parse(accepted(journal));
    expect(c.title).toBe('Topological order in twisted bilayer graphene');
    expect(byId(c, topological)).toBe('verified');
  });

  // Adversarial: the same shape around an invented or altered citation.
  test('an invented paper marked "to appear" is Not found when nothing matched', () => {
    const c = parse(accepted('to appear', 'Invented topological dreams in imaginary trilayer graphene', 'A. Roe and B. Poe').replace('2401.01234', '2401.99999'));
    expect(c.title).toBe('Invented topological dreams in imaginary trilayer graphene');
    expect(nothingFound(c)).toBe('not_found');
  });

  test('a title that ends in a status word as part of a longer chunk keeps it ("..., Results submitted (2025)")', () => {
    expect(parse('A. Roe and B. Poe, Learning, fast and slow, results submitted (2025), arXiv:2502.00001 [cond-mat.str-el] .').title).toBe('Learning, fast and slow, results submitted');
  });

  test('an invented paper with a journal before the year is Not found when nothing matched', () => {
    const c = parse(accepted('Nature Physics', 'Invented topological dreams in imaginary trilayer graphene', 'A. Roe and B. Poe').replace('2401.01234', '2401.99999'));
    expect(c.title).toBe('Invented topological dreams in imaginary trilayer graphene');
    expect(nothingFound(c)).toBe('not_found');
  });

  test('another paper behind the cited identifier is Wrong ID', () => {
    expect(byId(parse(accepted('Nature Physics', 'Quantum annealing of invented heavy fermion lattices', 'A. Roe and B. Poe')), topological)).toBe('wrong_id');
  });

  test.each([
    ['changed title words', accepted('Nature Physics', 'Topological order in twisted trilayer graphite')],
    ['changed author', accepted('Nature Physics', undefined, 'A. Smith and B. Brown')],
    ['changed year', accepted('Nature Physics').replace('(2024)', '(2014)')],
  ])('%s is not Verified against the real record', (_what, text) => {
    expect(['details_differ', 'wrong_id']).toContain(byId(parse(text), topological));
  });
});

describe('SIAM style arXiv preprints ("..., arXiv preprint arXiv:2605.19989, (2026), https://...") keep their title', () => {
  const text = 'C. Aeckerle-Willems, I. Klebanov, and S. Weissmann, Error Bounds for Importance Sampling with Estimated Proposal Distributions, arXiv preprint arXiv:2605.19989, (2026), https://doi.org/10.48550/arXiv.2605.19989.';
  const record = rec({ source: 'arxiv', title: 'Error Bounds for Importance Sampling with Estimated Proposal Distributions', authors: ['aeckerle willems', 'klebanov', 'weissmann'], year: 2026, arxivId: '2605.19989' });

  test('the repository is no journal name to give back to the title', () => {
    const c = parse(text);
    expect(c.title).toBe('Error Bounds for Importance Sampling with Estimated Proposal Distributions');
    expect(comparedWith(c, record).title).toBe(c.title);
    expect(byId(c, record)).toBe('verified');
  });
});

// --- More SIAM and REVTeX shapes ---------------------------------------------------------------------------------------

const LECUN = 'Y. LeCun, Y. Bengio, and G. Hinton, Deep learning, Nature, 521 (2015), pp. 436–444.';
const lecunRecord = rec({ title: 'Deep learning', authors: ['lecun', 'bengio', 'hinton'], year: 2015, venue: 'Nature', venues: ['Nature'], volume: '521', pages: ['436'], doi: '10.1038/nature14539' });

describe('SIAM style: a two-word title before the journal\'s chunk', () => {
  test.each([
    [LECUN, 'Deep learning', 'Nature, 521 (2015)'],
    ['Y. LeCun, Y. Bengio, and G. Hinton, Deep learning, Nature Mach. Intell., 1 (2019), pp. 1–9.', 'Deep learning', 'Nature Mach. Intell., 1 (2019)'],
  ])('%s', (text, title, venue) => {
    const c = parse(text);
    expect(c.authors).toEqual(['lecun', 'bengio', 'hinton']);
    expect(c.title).toBe(title);
    expect(c.venue?.startsWith(venue)).toBe(true);
  });

  test('is Verified against its record', () => {
    expect(bySearch(parse(LECUN), lecunRecord)).toBe('verified');
  });

  test('a changed title word is not Verified', () => {
    expect(bySearch(parse(LECUN.replace('Deep learning', 'Deep thinking')), lecunRecord)).not.toBe('verified');
  });

  test('a whole-word chunk that is not the record\'s journal goes back to the title', () => {
    const c = parse(LECUN.replace('Nature,', 'Neural Dreams,'));
    expect(comparedWith(c, lecunRecord).title).toBe('Deep learning, Neural Dreams');
    expect(bySearch(c, lecunRecord)).toBe('details_differ');
  });

  test('an invented two-word title in this shape is never Verified when nothing matched', () => {
    expect(nothingFound(parse('A. Roe and B. Poe, Deep dreaming, Nature, 521 (2015), pp. 436–444.'))).not.toBe('verified');
  });
});

describe('a leading abbreviation the record\'s venue leaves out stays in the venue', () => {
  const krizhevsky = rec({ title: 'ImageNet classification with deep convolutional neural networks', authors: ['krizhevsky', 'sutskever', 'hinton'], year: 2012, venue: 'Neural Information Processing Systems', venues: ['Neural Information Processing Systems'] });
  const SIAM_ADV = 'A. Krizhevsky, I. Sutskever, and G. E. Hinton, Imagenet classification with deep convolutional neural networks, Adv. Neural Inf. Process. Syst., 25 (2012).';
  const SURNAME_ADV = 'Krizhevsky, A., Sutskever, I. and Hinton, G. E., Imagenet classification with deep convolutional neural networks. Adv. Neural Inf. Process. Syst. 25, 1097–1105 (2012).';
  const NATURE_ADV = 'Krizhevsky, A., Sutskever, I. & Hinton, G. E. Imagenet classification with deep convolutional neural networks. Adv. Neural Inf. Process. Syst. 25, 1097–1105 (2012).';

  test.each([[SIAM_ADV], [SURNAME_ADV], [NATURE_ADV]])('"Adv." against "Neural Information Processing Systems": %s', (text) => {
    const c = parse(text);
    expect(comparedWith(c, krizhevsky).title).toBe('Imagenet classification with deep convolutional neural networks');
    expect(bySearch(c, krizhevsky)).toBe('verified');
  });

  // Adversarial: only a journal's usual opening abbreviation stays; a sentence in front of it still goes back.
  test.each([
    ['Models. Adv. Neural Inf. Process. Syst.'],
    ['Advances. Neural Inf. Process. Syst.'],
    ['Deep Models. Adv. Neural Inf. Process. Syst.'],
  ])('"%s" is not Verified', (journal) => {
    for (const text of [SIAM_ADV, SURNAME_ADV]) expect(bySearch(parse(text.replace('Adv. Neural Inf. Process. Syst.', journal)), krizhevsky)).not.toBe('verified');
  });
});

describe('SIAM style: journal names with lower-case joining words, a colon after a word, or a dotted acronym', () => {
  test.each([
    [
      'B. T. Doshi, Continuous time control of markov processes on an arbitrary state space: average return criterion, Stochastic Processes and their Applications, 4 (1976), pp. 55–77.',
      'Continuous time control of markov processes on an arbitrary state space: average return criterion',
      rec({ title: 'Continuous time control of markov processes on an arbitrary state space: average return criterion', authors: ['doshi'], year: 1976, venue: 'Stochastic Processes and their Applications', venues: ['Stochastic Processes and their Applications'] }),
    ],
    [
      'X. Xi, N. Ding, and Y. Wang, How required reserve ratio affects distribution and velocity of money, Physica A: Statistical Mechanics and its Applications, 357 (2005), pp. 543–555.',
      'How required reserve ratio affects distribution and velocity of money',
      rec({ title: 'How required reserve ratio affects distribution and velocity of money', authors: ['xi', 'ding', 'wang'], year: 2005, venue: 'Physica A: Statistical Mechanics and its Applications', venues: ['Physica A: Statistical Mechanics and its Applications'] }),
    ],
    [
      'W. Zhang, Ergodic SDEs on submanifolds and related numerical sampling schemes, ESAIM: Math. Model. Numer. Anal., 54 (2020), pp. 391–430.',
      'Ergodic SDEs on submanifolds and related numerical sampling schemes',
      rec({ title: 'Ergodic SDEs on submanifolds and related numerical sampling schemes', authors: ['zhang'], year: 2020, venue: 'ESAIM: Mathematical Modelling and Numerical Analysis', venues: ['ESAIM: Mathematical Modelling and Numerical Analysis'] }),
    ],
    [
      'M. Pendharkar and D. Goldhaber-Gordon, Torsional force microscopy of van der Waals moirés and atomic lattices, Proc. Natl. Acad. Sci. U.S.A., 121 (2024), p. e2314083121.',
      'Torsional force microscopy of van der Waals moirés and atomic lattices',
      rec({ title: 'Torsional force microscopy of van der Waals moirés and atomic lattices', authors: ['pendharkar', 'goldhaber gordon'], year: 2024, venue: 'Proceedings of the National Academy of Sciences', venues: ['Proceedings of the National Academy of Sciences'], shortVenues: ['Proc. Natl. Acad. Sci. U.S.A.'] }),
    ],
    [
      'G. Julia, Mémoire sur l\'itération des fonctions rationnelles, Journal de Mathématiques Pures et Appliquées, 12 (1918), pp. 47–245.',
      'Mémoire sur l\'itération des fonctions rationnelles',
      rec({ title: 'Mémoire sur l\'itération des fonctions rationnelles', authors: ['julia'], year: 1918, venue: 'Journal de Mathématiques Pures et Appliquées', venues: ['Journal de Mathématiques Pures et Appliquées'] }),
    ],
    [
      'H. Hasse, Zur Theorie der abstrakten elliptischen Funktionenkörper, Journal für die Reine und Angewandte Mathematik, 175 (1936), pp. 193–208.',
      'Zur Theorie der abstrakten elliptischen Funktionenkörper',
      rec({ title: 'Zur Theorie der abstrakten elliptischen Funktionenkörper', authors: ['hasse'], year: 1936, venue: 'Journal für die reine und angewandte Mathematik', venues: ['Journal für die reine und angewandte Mathematik'] }),
    ],
    [
      'J. Roe, Sur une classe de surfaces, Annales de l\'Institut Fourier, 12 (1962), pp. 1–20.',
      'Sur une classe de surfaces',
      rec({ title: 'Sur une classe de surfaces', authors: ['roe'], year: 1962, venue: 'Annales de l\'Institut Fourier', venues: ['Annales de l\'Institut Fourier'] }),
    ],
  ])('%s', (text, title, record) => {
    const c = parse(text);
    expect(c.title).toBe(title);
    expect(comparedWith(c, record).title).toBe(title);
    expect(bySearch(c, record)).toBe('verified');
  });

  // Adversarial: the same words as a whole-word name that is not the record's go back to the title.
  test.each([
    ['Processes and their Dreams'],
    ['Imaginary: Math. Model. Numer. Anal.'],
    ['Journal de Rêves et Songes'],
  ])('"%s" against another journal is not Verified', (journal) => {
    const record = rec({ title: 'Continuous time control of markov processes on an arbitrary state space: average return criterion', authors: ['doshi'], year: 1976, venue: 'Stochastic Processes and their Applications', venues: ['Stochastic Processes and their Applications'] });
    const c = parse(`B. T. Doshi, Continuous time control of markov processes on an arbitrary state space: average return criterion, ${journal}, 4 (1976), pp. 55–77.`);
    expect(bySearch(c, record)).not.toBe('verified');
  });
});

describe('REVTeX arXiv style: a journal whose name opens in lower case stays out of the title', () => {
  const topological = rec({ source: 'arxiv', title: 'Topological order in twisted bilayer graphene', authors: ['smith', 'jones'], year: 2024, arxivId: '2401.01234' });
  const accepted = (journal: string, title = 'Topological order in twisted bilayer graphene'): string => `A. Smith and B. Jones, ${title}, ${journal} (2024), arXiv:2401.01234 [cond-mat.str-el] .`;

  test.each([['npj Quantum Mater.'], ['npj Comput. Mater.'], ['eLife'], ['iScience'], ['mBio'], ['eNeuro']])('%s (2024), arXiv:', (journal) => {
    const c = parse(accepted(journal));
    expect(c.title).toBe('Topological order in twisted bilayer graphene');
    expect(byId(c, topological)).toBe('verified');
  });

  test('a two-word title before " (<year>), arXiv:" is read too, and a changed word is not Verified', () => {
    const record = rec({ source: 'arxiv', title: 'Topological order', authors: ['smith', 'jones'], year: 2024, arxivId: '2401.01234' });
    const text = 'A. Smith and B. Jones, Topological order (2024), arXiv:2401.01234 [cond-mat.str-el] .';
    expect(parse(text).title).toBe('Topological order');
    expect(byId(parse(text), record)).toBe('verified');
    expect(byId(parse(text.replace('Topological order', 'Topological disorder')), record)).not.toBe('verified');
  });

  test('a lower-case word that names no journal stays in the title ("..., iPhone (2024), arXiv:")', () => {
    expect(parse(accepted('iPhone')).title).toBe('Topological order in twisted bilayer graphene, iPhone');
  });

  test('SIAM style with eLife: the journal is read against the record', () => {
    const record = rec({ title: 'Cellular and neurochemical basis of sleep stages in the thalamocortical network', authors: ['krishnan', 'bazhenov'], year: 2016, venue: 'eLife', venues: ['eLife'] });
    const c = parse('G. P. Krishnan and M. Bazhenov, Cellular and neurochemical basis of sleep stages in the thalamocortical network, eLife, 5 (2016), p. e18607.');
    expect(c.title).toBe('Cellular and neurochemical basis of sleep stages in the thalamocortical network');
    expect(bySearch(c, record)).toBe('verified');
  });
});

describe('SIAM style: a book whose publisher is named in whole words', () => {
  test.each([
    ['S. Asmussen and P. W. Glynn, Stochastic Simulation: Algorithms and Analysis, Springer Science & Business Media, 2007.', 'Stochastic Simulation: Algorithms and Analysis'],
    ['J. Bucklew, Introduction to Rare Event Simulation, Springer New York, 2004.', 'Introduction to Rare Event Simulation'],
    ['R. Y. Rubinstein and D. P. Kroese, Simulation and the Monte Carlo Method, John Wiley & Sons, 2016.', 'Simulation and the Monte Carlo Method'],
    ['J. Nocedal and S. J. Wright, Numerical Optimization, Springer, New York, 2nd ed., 2006.', 'Numerical Optimization'],
    ['G. H. Golub and C. F. Van Loan, Matrix Computations, Johns Hopkins University Press, Baltimore, 4th ed., 2013.', 'Matrix Computations'],
  ])('%s', (text, title) => {
    const c = parse(text);
    expect(c.title).toBe(title);
    expect(c.authors.length).toBeGreaterThan(0);
  });

  test('a title that merely holds a publisher\'s name keeps it ("..., Springer and the rise of open access, ...")', () => {
    expect(parse('J. Roe, Publishing in physics, Springer and the rise of open access, Phys. Rev. D 12, 345 (2020).').title).toBe('Publishing in physics, Springer and the rise of open access');
  });
});

// --- A BibTeX note after the title --------------------------------------------------------------------------------------

// 2610.27576 [23] [25]: arXiv's page gives the names, the title and the note as separate blocks.
const LEE: RawReference = {
  index: 23,
  label: 'Lee et al. (2026)',
  text: 'K. Lee, G. Han, S. Lee, and J. Ko When the strike zone becomes algorithmic: umpire judgment and player challenge decisions under AI review. Note: arXiv preprint 2609.25525',
  blocks: ['K. Lee, G. Han, S. Lee, and J. Ko', 'When the strike zone becomes algorithmic: umpire judgment and player challenge decisions under AI review.', 'Note: arXiv preprint 2609.25525'],
};
const LEE_KO: RawReference = {
  index: 25,
  label: 'Lee and Ko (2026)',
  text: 'K. Lee and J. Ko Auditing contextual bias in human ball-strike calls using KBO’s automated umpiring transition. Note: arXiv preprint 2609.03786',
  blocks: ['K. Lee and J. Ko', 'Auditing contextual bias in human ball-strike calls using KBO’s automated umpiring transition.', 'Note: arXiv preprint 2609.03786'],
};
const leeRecord = rec({ source: 'arxiv', title: 'When the Strike Zone Becomes Algorithmic: Umpire Judgment and Player Challenge Decisions under AI Review', authors: ['lee', 'han', 'lee', 'ko'], year: 2026, arxivId: '2609.25525' });
const leeKoRecord = rec({ source: 'arxiv', title: "Auditing Contextual Bias in Human Ball-Strike Calls Using KBO's Automated Umpiring Transition", authors: ['lee', 'ko'], year: 2026, arxivId: '2609.03786' });

describe('a "Note:" field after the title is a note, never more of the title', () => {
  test.each([
    [LEE, leeRecord],
    [LEE_KO, leeKoRecord],
  ])('the title differs from the record only in case, so it is Verified: %#', (ref, record) => {
    const c = parseCitation(ref);
    expect(comparedWith(c, record).title).toBe(c.title);
    expect(bySearch(c, record)).toBe('verified');
  });

  // The field in any case, and its plural.
  test.each([['note:'], ['Notes:'], ['NOTE:'], ['notes:']])('"%s" is a note too', (note) => {
    const c = parse(`K. Lee and J. Ko. Auditing contextual bias in human ball-strike calls. ${note} arXiv preprint 2609.03786`);
    const record = rec({ source: 'arxiv', title: 'Auditing Contextual Bias in Human Ball-Strike Calls', authors: ['lee', 'ko'], year: 2026, arxivId: '2609.03786' });
    expect(comparedWith(c, record).title).toBe('Auditing contextual bias in human ball-strike calls');
    expect(bySearch(c, record)).toBe('verified');
  });

  test('"Notes" without its colon may still be a sentence added to the title ("Title. Notes on the method. In NeurIPS")', () => {
    const record = rec({ title: 'Attention is all you need', authors: ['vaswani'], year: 2017 });
    const c = parse('A. Vaswani. Attention is all you need. Notes on the method. In NeurIPS, 2017.');
    expect(comparedWith(c, record).title).toBe('Attention is all you need. Notes on the method');
    expect(bySearch(c, record)).toBe('details_differ');
  });

  test('an invented paper with a note is still Not found', () => {
    const c = parseCitation({ ...LEE, text: LEE.text.replace('strike zone', 'invented zone'), blocks: [LEE.blocks?.[0] ?? '', 'When the invented zone becomes imaginary: dreamt judgment under AI review.', 'Note: arXiv preprint 2609.99999'] });
    expect(nothingFound(c)).not.toBe('verified');
  });

  test('a clause of the title before a venue is still read with it ("Title. A survey of graph applications. In NeurIPS")', () => {
    const record = rec({ title: 'Attention is all you need', authors: ['vaswani'], year: 2017 });
    const c = parse('A. Vaswani. Attention is all you need. A survey of graph applications. In NeurIPS, 2017.');
    expect(comparedWith(c, record).title).not.toBe('Attention is all you need');
  });

  test('"Note" without its colon may still be a sentence added to the title ("Title. Note on the method. In NeurIPS")', () => {
    const record = rec({ title: 'Attention is all you need', authors: ['vaswani'], year: 2017 });
    const c = parse('A. Vaswani. Attention is all you need. Note on the method. In NeurIPS, 2017.');
    expect(comparedWith(c, record).title).toBe('Attention is all you need. Note on the method');
    expect(bySearch(c, record)).toBe('details_differ');
  });
});
