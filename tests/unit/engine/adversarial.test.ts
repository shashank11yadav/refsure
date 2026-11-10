// Attacks on the engine. Each case runs with fake sources that hold the real records (see helpers/adversarialWorld). Invented or corrupted citations must never come out
// Verified; real ones must never come out Not found, Wrong ID or Retracted (unless the work is retracted).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));

import { RATE } from '../../../src/config';
import type { CheckResult, PaperInfo } from '../../../src/core/types';
import { checkReference, runCheck } from '../../../src/engine/checker';
import { arxiv } from '../../../src/sources/arxiv';
import { crossref } from '../../../src/sources/crossref';
import type { Status, WorkRecord } from '../../../src/core/types';
import { makeDeps, mockSources, paperRef, ref } from '../helpers/engine';
import { fetchJson, resetNetworkStateForTests, SourceError } from '../../../src/sources/http';
import { R, WAKEFIELD_DOI, WORLD, worldDeps } from '../helpers/adversarialWorld';

const signal = new AbortController().signal;
// http.ts keeps its limiters and blocks per source for the life of the module: each test that runs on the real http.ts
// starts from fresh ones, on the same fake clock, so no pause or block a previous test left behind can reach it.
const freshNetwork = (): void => {
  resetNetworkStateForTests();
  vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 28)) });
};
const NOT_VERIFIED: Status[] = ['details_differ', 'not_found', 'cant_check', 'wrong_id'];
/** An invented citation: anything but Verified, and no other work's retraction. */
const INVENTED: Status[] = ['details_differ', 'not_found', 'cant_check'];
/** A real citation: anything but an accusation. */
const REAL: Status[] = ['verified', 'details_differ', 'cant_check'];

async function statusOf(text: string, openalexAll: boolean): Promise<Status> {
  const { deps } = worldDeps({ openalexAll });
  return (await checkReference(ref(1, text), deps, signal)).status;
}

async function reasonOf(text: string): Promise<string> {
  const { deps } = worldDeps();
  return (await checkReference(ref(1, text), deps, signal)).reason;
}

// [id, text, allowed statuses]
const CASES: [string, string, Status[]][] = [
  ['I01', 'LeCun, Y., Bengio, Y., Hinton, G. (2015). Sparse deep learning. Nature, 521, 436–444.', INVENTED],
  ['I02', 'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need for graph transformers. In NeurIPS.', INVENTED],
  ['I03', 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, a review, Nucl. Phys. B 474 (1996) 122.', INVENTED],
  ['I04', 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, revisited, Nucl. Phys. B 474 (1996) 122.', INVENTED],
  ['I05', 'A. Vaswani, N. Shazeer, and N. Parmar, Attention is all you need. Part II, Nucl. Phys. B 3, 1 (2017).', INVENTED],
  ['I06', 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings. II, Nucl. Phys. B 474 (1996) 122.', INVENTED],
  ['I07', 'He, K., Zhang, X., Ren, S., Sun, J. (2016). Learning deep residual for recognition of images. In CVPR.', INVENTED],
  ['I08', 'He, K., Zhang, X., Ren, S., Sun, J. (2016). Deep residual learning for video recognition. In CVPR, pp. 770–778.', INVENTED],
  ['I09', 'Ho, J., Jain, A., Abbeel, P. (2020). Denoising diffusion implicit models. In NeurIPS.', INVENTED],
  ['I10', 'Kipf, T. N., Welling, M. (2017). Semi-supervised classification with graph attention networks. In ICLR.', INVENTED],
  ['I11', 'Kingma, D. P., Welling, M. (2013). Variational auto-encoding of Bayes. In ICLR.', INVENTED],
  ['I12', 'Kingma, D. P., Ba, J. (2014). Adaptive moment methods for sparse gradients. arXiv:1412.6980.', INVENTED],
  ['I13', 'Kingma, D. P., Ba, J. Adam: a method for stochastic optimization in deep networks. arXiv:1412.6980 (2014).', INVENTED],
  ['I14', 'He K, Zhang X, Ren S, Sun J. Deep residual learning for image segmentation. CVPR 2016. doi:10.1109/cvpr.2016.90', INVENTED],
  ['I15', 'A. Vaswani, N. Shazeer, N. Parmar, Attention is all you need, revisited, arXiv:1706.03762.', INVENTED],
  ['I16', 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, at finite temperature, arXiv:hep-th/9602120.', INVENTED],
  ['I17', 'C. M. Bishop. Pattern Recognition and Machine Learning Theory. Springer, 2006.', ['cant_check']],
  ['I18', 'Sutton, R. S., Barto, A. G. (2018). Reinforcement Learning: An Introduction to Multi-Agent Systems. MIT Press.', ['cant_check']],
  ['I19', 'Hastie, T., Tibshirani, R., Friedman, J. (2009). The Elements of Statistical Learning: Data Mining, Inference, and Prediction for Graphs. Springer.', ['cant_check']],
  ['I20', 'Goodfellow, I., Bengio, Y., Courville, A. (2016). Deep Learning with Python. MIT Press.', ['cant_check']],
  ['I21', 'Susskind, L. (2016). Addendum to computational complexity and black hole horizons. Fortschritte der Physik 64, 44.', INVENTED],
  ['I22', 'LeCun, Y., Bengio, Y., Hinton, G. (2017). Deep learning. Nature 521, 436–444. arXiv:1505.99999.', INVENTED],
  ['I22b', 'LeCun, Y., Bengio, Y., Hinton, G. (2013). Deep learning. Nature 521, 436–444. arXiv:1102.99999.', INVENTED],
  ['I22c', 'LeCun, Y., Bengio, Y., Hinton, G. (2017). Deep learning. Nature 521, 436–444. arXiv:1709.99999.', INVENTED],
  ['I23', 'LeCun, Y., Bengio, Y., Hinton, G. (2017). Deep learning. Nature 521, 436–444.', INVENTED],
  ['I24', 'Vaswani, A., et al. (2017). Attention is all you need. A survey of graph applications. In NeurIPS.', INVENTED],
  ['I25', 'Kingma, D. P., Welling, M. (2014). Auto-encoding variational Bayes, revisited. In ICLR.', INVENTED],
  ['I26', 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, with fluxes, Nucl. Phys. B 474 (1996) 122.', INVENTED],
  ['I27', 'A. Vaswani, N. Shazeer, Attention is all you need, for vision, Phys. Rev. D 96, 1 (2017).', INVENTED],
  ['I28', 'Ganor O.J., Hanany A., Small E(8) instantons and tensionless noncritical strings, two loops, Nucl. Phys. B 474 (1996) 122.', INVENTED],
  ['I29', 'Kipf, T. N., Welling, M. (2016). Graph auto-encoders variational. In NIPS Workshop on Bayesian Deep Learning.', INVENTED],
  // A subtitle added to a retracted work: never Verified (its retraction may be shown, it is the work it names).
  ['I30', 'Wakefield AJ, Murch SH, Anthony A, et al. Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children: a follow-up. Lancet 1998; 351: 637–41.', ['details_differ', 'retracted']],
  ['K01', 'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. In NeurIPS.', ['verified']],
  ['K02', 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings, Nucl. Phys. B 474 (1996) 122.', ['verified']],
  ['K03', 'He, K., Zhang, X., Ren, S., Sun, J. (2016). Deep residual learning for image recognition. In CVPR.', ['verified']],
  ['K04', 'Kingma, D. P., Ba, J. (2016). Adam: A method for stochastic optimization. In ICLR.', ['verified']],
  ['K05', 'C. M. Bishop. Pattern Recognition and Machine Learning. Springer, 2006.', ['verified']],
  ['K06', 'Wakefield AJ, Murch SH, Anthony A, et al. Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet 1998; 351: 637–41.', ['retracted']],
  ['K07', 'Hastie, T., Tibshirani, R., Friedman, J. (2009). The Elements of Statistical Learning: Data Mining, Inference, and Prediction. Springer.', ['verified']],
  ['K08', 'Susskind, L. (2016). Computational complexity and black hole horizons. Fortschritte der Physik 64, 24.', ['verified']],
  ['K09', 'A. Vaswani, N. Shazeer, and N. Parmar, Attention is all you need, arXiv:1706.03762 (2017).', ['verified']],
];

const FABRICATED = 'Sparse mixture routing for long-context retrieval in multilingual corpora';
// Invented authors and title; only the venue changes. Nothing matches them.
const NO_VENUE: [string, string][] = [
  ['H01', `A. Whitfield and R. Okonkwo. ${FABRICATED}. 2021.`],
  ['H16', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Technical report, Google Research.`],
  ['H24', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. OpenAI.`],
];
const NAMES_A_VENUE: [string, string][] = [
  ['H02', `A. Whitfield and R. Okonkwo. ${FABRICATED}. arXiv preprint, 2021.`],
  ['H03', `A. Whitfield and R. Okonkwo. ${FABRICATED}. Nature Machine Intelligence, 2021.`],
  ['H04', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Neural Computation.`],
  ['H05', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. ICLR.`],
  ['H06', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. ICLR 2021.`],
  ['H07', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. CVPR.`],
  ['H08', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Machine Learning.`],
  ['H09', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Science.`],
  ['H10', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. PNAS.`],
  ['H11', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. The Lancet.`],
  ['H12', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Physical Review Letters.`],
  ['H13', `Whitfield, A., Okonkwo, R. (2023). ${FABRICATED}. TMLR.`],
  ['H14', `Whitfield, A., Okonkwo, R. (2023). ${FABRICATED}. Transactions on Machine Learning Research.`],
  ['H15', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. ACL 2021.`],
  ['H17', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. NeurIPS.`],
  ['H18', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Bioinformatics.`],
  ['H19', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. IEEE Transactions on Neural Networks and Learning Systems.`],
  ['H20', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Artificial Intelligence.`],
  ['H21', `Whitfield, A., Okonkwo, R. (2021). ${FABRICATED}. Communications of the ACM.`],
  ['H22', `A. Whitfield, R. Okonkwo, ${FABRICATED}, Phys. Rev. Lett. (2021).`],
  ['H23', `Whitfield A, Okonkwo R. ${FABRICATED}. Nat Mach Intell. 2021.`],
];

describe('adversarial: invented, corrupted and real citations against real records', () => {
  for (const openalexAll of [false, true]) {
    describe(openalexAll ? 'OpenAlex returns every record' : 'OpenAlex returns nothing', () => {
      test.each(CASES)('%s: %s', async (_id, text, allowed) => {
        expect(allowed).toContain(await statusOf(text, openalexAll));
      });
    });
  }
});

describe('adversarial: fabrications that name a venue are Not found, the others Can\'t check', () => {
  test.each(NAMES_A_VENUE)('%s names a venue: %s', async (_id, text) => {
    expect(await statusOf(text, false)).toBe('not_found');
  });
  test.each(NO_VENUE)('%s names none: %s', async (_id, text) => {
    expect(await statusOf(text, false)).toBe('cant_check');
    expect(await reasonOf(text)).toMatch(/^Not in Crossref, arXiv, OpenReview or OpenAlex/);
  });
});

describe('adversarial: a real book whose publisher is "U. Press" is never Not found', () => {
  const nothing = (): ReturnType<typeof makeDeps> => makeDeps(mockSources());
  test.each([
    'S. Weinberg, The quantum theory of fields: modern applications, Vol. 2 (Cambridge U. Press, 1996).',
    'J. Doe, Statistical mechanics of disordered elastic systems (Princeton U. Press, Princeton, 1999).',
    'J. Doe, Statistical mechanics of disordered elastic systems (Princeton U. Press, Princeton, 1999), p. 123.',
    'Doe, J. (1999). Statistical mechanics of disordered elastic systems. Princeton U. Press.',
    'R. Feynman, Quantum electrodynamics and path integrals in physics, Oxford U. Press, 1985.',
    'R. Feynman, Quantum electrodynamics and path integrals in physics, 2nd ed. (Oxford U. Press, 1985).',
    'S. Weinberg, The Quantum Theory of Fields and its many applications (Cambridge U. P. Press, 1995).',
    'J. Doe, Statistical mechanics of disordered elastic systems (Harvard U. Press, Cambridge, MA, 1999).',
    'J. Doe, Statistical mechanics of disordered elastic systems (Oxford Univ. Press, 1999).',
    'J. Doe, Statistical mechanics of disordered elastic systems (Princeton Univ. Press, 1999), Vol. 2.',
    'J. Doe, Statistical mechanics of disordered elastic systems (Cambridge University Press, 1999).',
    'J. Doe, Statistical mechanics of disordered elastic systems (MIT Press, Cambridge, MA, 1999).',
    'R. Feynman and A. Hibbs, Quantum mechanics and path integrals (McGraw-Hill, New York, 1965), chap. 7.',
    'Doe, J. (2001). Statistical mechanics of disordered elastic systems. Springer Science and Business Media.',
  ])('%s', async (text) => {
    const r = await checkReference(ref(1, text), nothing(), signal);
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/book or thesis/);
  });
});

describe('adversarial: the re-read keeps invented words in the title', () => {
  const ganor = R({ title: 'Small E(8) instantons and tensionless noncritical strings', authors: ['ganor', 'hanany'], year: 1996, doi: '10.1016/0550-3213(96)00243-x' });
  const kitaev = R({ title: 'Fault-tolerant quantum computation by anyons', authors: ['kitaev'], year: 2003, doi: '10.1016/s0003-4916(02)00018-0' });
  const witten = R({ title: 'String theory dynamics in various dimensions', authors: ['witten'], year: 1995, doi: '10.1016/0550-3213(95)00158-o' });
  const gkp = R({ title: 'Gauge theory correlators from non-critical string theory', authors: ['gubser', 'klebanov', 'polyakov'], year: 1998, doi: '10.1016/s0370-2693(98)00377-3' });
  const world = [ganor, kitaev, witten, gkp];
  const run = async (text: string): Promise<Status> => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve(world) }, openalex: { search: () => Promise.resolve([]) } });
    return (await checkReference(ref(1, text), makeDeps(sources), signal)).status;
  };
  const G = 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings';
  const GKP = 'S.S. Gubser, I.R. Klebanov and A.M. Polyakov, Gauge theory correlators from non-critical string theory';
  test.each([
    [`${G}, Nucl. Phys. B 474 (1996) 122.`, ['verified']],
    [`${G}, a review, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}, revisited, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}, at finite temperature, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}, with fluxes, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}. Part II, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}. Two loop corrections. Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}, Part II, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    [`${G}, Erratum, Nucl. Phys. B 474 (1996) 122.`, INVENTED],
    ['O.J. Ganor and A. Hanany, Small E(8) instantons, Nucl. Phys. B 474 (1996) 122.', INVENTED],
    ['O.J. Ganor and A. Hanany, Large E(8) instantons and tensionless noncritical strings, Nucl. Phys. B 474 (1996) 122.', INVENTED],
    ['O.J. Ganor and A. Hanany, Small E(8) instantons and tensionful noncritical strings, Nucl. Phys. B 474 (1996) 122.', INVENTED],
    ['O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless critical strings, Nucl. Phys. B 474 (1996) 122.', INVENTED],
    [`${G}, Nucl. Phys. B 474 (1996) 122, hep-th/9602120.`, ['verified']],
    ['O.J. Ganor and E.J. Witten, Small E(8) instantons and tensionless noncritical strings, Nucl. Phys. B 474 (1996) 122.', NOT_VERIFIED],
    ['A.Yu. Kitaev, Fault-tolerant quantum computation by anyons, Ann. Phys. 303 (2003) 2.', REAL],
    ['A.Yu. Kitaev, Fault-tolerant quantum computation by anyons, revisited, Ann. Phys. 303 (2003) 2.', INVENTED],
    ['A.Yu. Kitaev, Fault-tolerant quantum computation by anyons, in two dimensions, Ann. Phys. 303 (2003) 2.', INVENTED],
    ['E. Witten, String theory dynamics in various dimensions, Nucl. Phys. B 443 (1995) 85.', ['verified']],
    ['E. Witten, String theory dynamics in various dimensions, and beyond, Nucl. Phys. B 443 (1995) 85.', INVENTED],
    [`${GKP}, Phys. Lett. B 428 (1998) 105.`, ['verified']],
    [`${GKP}, at large N, Phys. Lett. B 428 (1998) 105.`, INVENTED],
    [`${GKP}, Part II, Phys. Lett. B 428 (1998) 105.`, INVENTED],
    ['S.S. Gubser, I.R. Klebanov, Gauge theory correlators from non-critical string theory, Phys. Lett. B 428 (1998) 105.', ['verified']],
    ['Gubser S.S., Klebanov I.R., Polyakov A.M., Gauge theory correlators from non-critical string theory, three loops, Phys. Lett. B 428 (1998) 105.', INVENTED],
    ['Gubser S.S., Klebanov I.R., Polyakov A.M., Gauge theory correlators from non-critical string theory, Phys. Lett. B 428 (1998) 105.', REAL],
    ['A. Vaswani, N. Shazeer, and N. Parmar, Attention is all you need. Part II, Nucl. Phys. B 3, 1 (2017).', INVENTED],
  ] as [string, Status[]][])('%s', async (text, allowed) => {
    expect(allowed).toContain(await run(text));
  });

  const wakefield = R({ title: 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children', authors: ['wakefield', 'murch', 'anthony'], year: 1998, doi: WAKEFIELD_DOI });
  const W = 'A.J. Wakefield, S.H. Murch and A. Anthony, Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children';
  const wakefieldRun = async (text: string): Promise<Status> => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([wakefield]) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.resolve({ retracted: true, version: 'cited' as const, noticeDoi: '10.1016/s0140-6736(10)60175-4' })) } });
    return (await checkReference(ref(1, text), deps, signal)).status;
  };
  test('an erratum cited is not the retracted article', async () => {
    expect(INVENTED).toContain(await wakefieldRun(`${W}. Erratum, Lancet 351 (1998) 637.`));
    expect(INVENTED).toContain(await wakefieldRun(`${W}, Erratum, Lancet 351 (1998) 637.`));
    expect(INVENTED).toContain(await wakefieldRun(`${W}, a follow-up, Lancet 351 (1999) 637.`));
  });
  test('the article itself is Retracted', async () => {
    expect(await wakefieldRun(`${W}, Lancet 351 (1998) 637.`)).toBe('retracted');
  });
});

describe('adversarial: the verified-only book lookup needs the record\'s people', () => {
  const run = async (text: string, records: WorkRecord[]): Promise<Status> => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve(records) } });
    return (await checkReference(ref(1, text), makeDeps(sources), signal)).status;
  };
  const handbook = R({ title: 'Handbook of Graph Neural Networks and Applications', authors: [], year: 2019, doi: '10.1007/x' });
  const prml = R({ title: 'Pattern Recognition and Machine Learning', authors: ['bishop'], year: 2006 });
  const murphy = R({ title: 'Machine learning: a probabilistic perspective', authors: ['murphy'], year: 2012 });
  test.each([
    ['Smith, J., Doe, A. (2019). Handbook of Graph Neural Networks and Applications. Springer.', [handbook], 'cant_check'],
    ['J. Smith. Handbook of Graph Neural Networks and Applications. Springer, 2019.', [handbook], 'cant_check'],
    ['Handbook of Graph Neural Networks and Applications. Springer, 2019.', [handbook], 'cant_check'],
    ['Smith, J. (2006). Pattern Recognition and Machine Learning. Springer.', [prml], 'cant_check'],
    ['Bishop, C. M. (2011). Pattern Recognition and Machine Learning. Springer.', [prml], 'cant_check'],
    ['Bishop, C. M. (2006). Pattern Recognition and Machine Learning. Springer.', [{ ...prml, isRetracted: true }], 'cant_check'],
    ['Bishop, C. M. (2006). Pattern Recognition and Machine Learning. Springer.', [R({ title: 'Pattern Recognition and Machine Learning', authors: ['nasrabadi'], year: 2007 })], 'cant_check'],
    ['Goodfellow, I., Bengio, Y. (2016). Deep Learning. MIT Press.', [R({ title: 'Deep learning', authors: ['lecun', 'bengio', 'hinton'], year: 2015 })], 'cant_check'],
    ['Murphy, K. P. (2012). Machine Learning: A Bayesian Perspective. MIT Press.', [murphy], 'cant_check'],
    ['Murphy, K. P. (2012). Machine Learning: A Probabilistic Perspective, Volume 2. MIT Press.', [murphy], 'cant_check'],
    ['Murphy, K. P. (2012). Machine Learning: A Probabilistic Perspective. MIT Press.', [murphy], 'verified'],
    ['Bishop, C. M. (2006). Pattern Recognition and Machine Learning. Springer.', [prml], 'verified'],
    // A reference that names nobody (only initials) is judged by its title, against a record that lists people.
    ['A. R. et al. (2020) Secure email - a usability study. In Financial Cryptography and Data Security, Lecture Notes in Computer Science, Cham, pp. 36–46 (en). ISBN 978-3-030-54455-3', [R({ title: 'Secure Email - A Usability Study', authors: ['reuter', 'abdelrazek', 'koenig'], year: 2020 })], 'verified'],
    ['A. R. et al. (2020) Secure email - a usability study. In Financial Cryptography and Data Security, Lecture Notes in Computer Science, Cham, pp. 36–46 (en). ISBN 978-3-030-54455-3', [R({ title: 'Secure Email - A Usability Study', authors: [], year: 2020 })], 'cant_check'],
  ] as [string, WorkRecord[], Status][])('%s', async (text, records, expected) => {
    expect(await run(text, records)).toBe(expected);
  });
});

describe('adversarial: an arXiv id the reference cites says nothing about the year unless it resolves to the work', () => {
  test.each([
    'LeCun, Y., Bengio, Y., Hinton, G. (2017). Deep learning. Nature 521, 436–444. arXiv:1505.99999.',
    'LeCun, Y., Bengio, Y., Hinton, G. (2013). Deep learning. Nature 521, 436–444. arXiv:1102.99999.',
    'LeCun, Y., Bengio, Y., Hinton, G. (2017). Deep learning. Nature 521, 436–444. arXiv:1709.99999.',
  ])('%s is not Verified', async (text) => {
    expect(await statusOf(text, false)).toBe('details_differ');
  });
  test('an id that resolves to the work still widens the year', async () => {
    expect(await statusOf('A. Vaswani, N. Shazeer, and N. Parmar, Attention is all you need, arXiv:1706.03762 (2019).', false)).toBe('verified');
  });
});

describe('adversarial: two references run together are not checked by the second one\'s identifier', () => {
  test('a long author list, a work in preparation and another paper with a DOI', async () => {
    const names = Array.from({ length: 80 }, (_, i) => `A. Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(', ');
    const merged = `${names}, Collaboration overview of detector physics and calibration methods for the experiment, in preparation. B. Other and C. Person, A completely different paper about protein folding networks, Phys. Rev. Lett. 120, 1 (2018), doi:10.1103/physrevlett.120.000001.`;
    const other = R({ title: 'A completely different paper about protein folding networks', authors: ['other', 'person'], year: 2018, doi: '10.1103/physrevlett.120.000001' });
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(other), search: () => Promise.resolve([other]) } });
    const r = await checkReference(ref(1, merged), makeDeps(sources), signal);
    expect(r.status).toBe('cant_check');
  });
  test('one work with a long author list is still looked up', async () => {
    const names = Array.from({ length: 80 }, (_, i) => `A. Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(', ');
    const one = `${names}, Observation of a new particle in the search for the standard model boson, Phys. Lett. B 716, 1 (2012), doi:10.1016/j.physletb.2012.08.020.`;
    const record = R({ title: 'Observation of a new particle in the search for the standard model boson', authors: ['nameaa', 'nameba', 'nameca'], year: 2012, doi: '10.1016/j.physletb.2012.08.020' });
    const sources = mockSources({ crossref: { lookupById: () => Promise.resolve(record), search: () => Promise.resolve([record]) } });
    const r = await checkReference(ref(1, one), makeDeps(sources), signal);
    expect(r.status).toBe('verified');
  });
});

async function checkAgainst(text: string, world: WorkRecord[], retracted = false): Promise<Status> {
  const sources = mockSources({ crossref: { search: () => Promise.resolve(world) }, arxiv: { search: () => Promise.resolve([]) }, openalex: { search: () => Promise.resolve([]) } });
  const deps = makeDeps(sources, { retraction: { check: vi.fn((m: WorkRecord) => Promise.resolve(m.isRetracted || retracted ? { retracted: true, version: 'cited' as const } : { retracted: false })) } });
  return (await checkReference(ref(1, text), deps, signal)).status;
}

describe('adversarial: a company, agency or series name after a title is no journal', () => {
  test.each([
    'Cisco Visual Networking Index: Forecast and Trends. Cisco Systems, 2019.',
    'Cisco. Cisco annual internet report. Cisco Systems, 2020.',
    'Juniper Research. Cybercrime and the internet of threats. Juniper Networks, 2017.',
    'Unit 42. Ransomware threat landscape of the year. Palo Alto Networks, 2022.',
    'Verizon. 2023 Data breach investigations report. Verizon Communications.',
    'Occupational employment and wages of software developers. Bureau of Labor Statistics, 2023.',
    'Population estimates for the UK, England and Wales. Office for National Statistics, 2021.',
    "Michelangelo: Uber's machine learning platform. Uber Engineering, 2017.",
    'Getting started with quantum annealing on the Advantage system. D-Wave Systems, 2020.',
    "APT1: Exposing one of China's cyber espionage units. Mandiant Threat Intelligence, 2013.",
    'Smith, J. (2020). Understanding transformers step by step. Towards Data Science.',
    'Jones, A. (2021). How we scaled our recommender. Netflix Technology Blog.',
    'Doe, J. (2019). The rise of foundation models. MIT Technology Review.',
    'Doe, J. (2019). Why AI needs regulation. Harvard Business Review.',
    'Doe, J. (2019). New battery chemistry promises longer life. Science Daily.',
    'Doe, J. (2019). The state of AI in 2019. The Economist.',
    'Annual report of the research council for the year. Research Council Annual Report, 2018.',
    'Hooke, R. Journal of a voyage to the South Seas. 1770.',
    'Doe, J. (2022). Lessons from deploying robots in warehouses. Agility Robotics.',
    'Doe, J. (2022). Laser alignment guide for beginners. Edmund Optics.',
    'Doe, J. (2020). Patient pathways after stroke. Johns Hopkins Medicine.',
    'Doe, J. (2020). The economic impact of open source. Oxford Economics.',
    'Doe, J. (2020). Quantum cloud services overview. Rigetti Computing.',
    'Doe, J. (2021). Trends in AI hardware. Stanford Human-Centered Artificial Intelligence.',
    'Doe, J. (2021). Our approach to alignment research. Allen Institute for Artificial Intelligence.',
    'Doe, J. (2021). Reproducibility and replicability in science. National Academies of Sciences, Engineering, and Medicine.',
    'Doe, J. (2021). Pretraining at scale. Hugging Face.',
    'Reinforcement learning: an introduction. Adaptive Computation and Machine Learning.',
  ])('%s', async (text) => {
    expect(await checkAgainst(text, [])).toBe('cant_check');
  });
});

describe('adversarial: a subtitle the record lacks is no match', () => {
  const att = R({ title: 'Attention is all you need', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017 });
  const he = R({ title: 'Deep residual learning for image recognition', authors: ['he', 'zhang', 'ren', 'sun'], year: 2016 });
  test.each([
    ['Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need: Part II. In NeurIPS.', att],
    ['Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need: a survey of graph applications. In NeurIPS.', att],
    ['He, K., Zhang, X., Ren, S., Sun, J. (2016). Deep residual learning for image recognition: revisited. In CVPR.', he],
    ['He, K., Zhang, X., Ren, S., Sun, J. (2016). Deep residual learning for image recognition: an erratum. In CVPR.', he],
  ] as [string, WorkRecord][])('%s', async (text, record) => {
    expect(await checkAgainst(text, [record])).toBe('details_differ');
  });

  const x = 'Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children';
  const original = R({ title: x, authors: ['wakefield', 'murch', 'anthony'], year: 1998, isRetracted: true });
  const followUp = R({ title: `${x}: a follow-up`, authors: ['wakefield', 'murch', 'anthony'], year: 1999, doi: '10.1/fu' });
  const cited = `Wakefield AJ, Murch SH, Anthony A. ${x}: a follow-up. Lancet 1999; 353: 100.`;
  test('a follow-up is not its retracted original', async () => {
    expect(await checkAgainst(cited, [original])).toBe('details_differ');
  });
  test('the follow-up itself still verifies, whichever record comes first', async () => {
    expect(await checkAgainst(cited, [original, followUp])).toBe('verified');
    expect(await checkAgainst(cited, [followUp, original])).toBe('verified');
  });
  test('a subtitle the citation drops still matches', async () => {
    expect(await checkAgainst('Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need. In NeurIPS.', [{ ...att, title: 'Attention is all you need: transformers for translation' }])).toBe('verified');
  });
});

describe('adversarial: one invented word before the venue, and notes after a title', () => {
  const ganor = R({ title: 'Small E(8) instantons and tensionless noncritical strings', authors: ['ganor', 'hanany'], year: 1996 });
  const G = 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings';
  test.each([`${G}, QCD, Nucl. Phys. B 474 (1996) 122.`, `${G}, in QCD, Nucl. Phys. B 474 (1996) 122.`, `${G}, AdS. Nucl. Phys. B 474 (1996) 122.`, `${G}, Physics, Nucl. Phys. B 474 (1996) 122.`, `${G}, Revis. Nucl. Phys. B 474 (1996) 122.`, `${G}, Nature, Nucl. Phys. B 474 (1996) 122.`])('%s', async (text) => {
    expect(INVENTED).toContain(await checkAgainst(text, [ganor]));
  });
  test('the real venue fragment still reads as one', async () => {
    expect(await checkAgainst(`${G}, Nucl. Phys. B 474 (1996) 122.`, [ganor])).toBe('verified');
  });
  test('an invented acronym before a journal', async () => {
    const graphs = R({ title: 'Deep learning methods for graphs', authors: ['smith', 'jones'], year: 2020 });
    expect(INVENTED).toContain(await checkAgainst('J. Smith and A. Jones, Deep learning methods for graphs, GNN. J. Mach. Learn. Res. 3, 1 (2020).', [graphs]));
    expect(INVENTED).toContain(await checkAgainst('J. Smith and A. Jones, Deep learning methods for graphs, ACM, J. Mach. Learn. Res. 3, 1 (2020).', [graphs]));
  });

  const att = R({ title: 'Attention is all you need', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017 });
  const V = 'Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need.';
  test.each([`${V} Revisited. In NeurIPS.`, `${V} The sequel. In NeurIPS.`, `${V} A survey. Nature 3, 1 (2017).`])('a sequel or survey is not the work: %s', async (text) => {
    expect(INVENTED).toContain(await checkAgainst(text, [att]));
  });
  test.each([
    `${V} Best paper award. In NeurIPS.`,
    `${V} Code and models released. In NeurIPS.`,
    `${V} Accepted. In NeurIPS.`,
    `${V} Preprint. arXiv:1706.03762.`,
    `${V} Long Beach, CA, USA. In NeurIPS.`,
    `${V} pages 5998-6008. In NeurIPS.`,
    `${V} Curran Associates, Inc. In NeurIPS.`,
  ])('a note after the title changes nothing: %s', async (text) => {
    expect(await checkAgainst(text, [att])).toBe('verified');
  });
});

describe('adversarial: a one- or two-word main title cited without its subtitle', () => {
  const mapReduce = R({ title: 'MapReduce: simplified data processing on large clusters', authors: ['dean', 'ghemawat'], year: 2008, doi: '10.1145/1327452.1327492' });
  const encyclopedia = R({ source: 'openreview', title: 'MapReduce', authors: ['wu'], year: 2018 });
  const run = async (text: string, crossref: WorkRecord[]): Promise<Status> => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve(crossref) }, openreview: { search: () => Promise.resolve([encyclopedia]) } });
    return (await checkReference(ref(1, text), makeDeps(sources), signal)).status;
  };
  test('the control verifies against the record that carries the subtitle', async () => {
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2008;51:107-113.', [mapReduce])).toBe('verified');
  });
  test('invented authors do not verify', async () => {
    expect(await run('Smith J, Doe A. MapReduce. Communications of the ACM. 2008;51:107-113.', [mapReduce])).not.toBe('verified');
  });
  test('the right authors with a year out of range do not verify', async () => {
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2015;51:107-113.', [mapReduce])).not.toBe('verified');
  });
  test('a one-word title against another paper with that main title by other authors does not verify', async () => {
    const other = R({ title: 'Transformers: a survey of attention models for vision', authors: ['lin', 'wang', 'liu'], year: 2020 });
    expect(await run('Roe J, Moe K. Transformers. Nature Machine Intelligence. 2020;2:1-10.', [other])).not.toBe('verified');
  });
});

// The short main title allowance is no strong match, and an invented clause after it blocks it.
describe('adversarial: the short main title allowance', () => {
  const mr = R({ title: 'MapReduce: simplified data processing on large clusters', authors: ['dean', 'ghemawat'], year: 2008 });
  const mr2 = R({ title: 'MapReduce: a flexible data processing tool', authors: ['dean', 'ghemawat'], year: 2010 });
  const gem = R({ title: 'Gemini: a family of highly capable multimodal models', authors: ['anil', 'borgeaud', 'wu'], year: 2023 });
  const gemR = R({ title: 'Gemini: retracted sibling study', authors: ['anil', 'borgeaud', 'wu'], year: 2023, isRetracted: true });
  const run = async (text: string, world: WorkRecord[], retractAll = false): Promise<Status> => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve(world) } });
    const deps = makeDeps(sources, { retraction: { check: vi.fn((m: WorkRecord) => Promise.resolve(m.isRetracted || retractAll ? { retracted: true, version: 'cited' as const } : { retracted: false })) } });
    return (await checkReference(ref(1, text), deps, signal)).status;
  };
  test('the control and its 2010 sibling verify', async () => {
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2008;51:107–113.', [mr, mr2])).toBe('verified');
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2010;53:72–77.', [mr, mr2])).toBe('verified');
  });
  test.each([
    'Dean, J., Ghemawat, S. (2008). MapReduce. Fault-tolerant scheduling for heterogeneous clusters. Communications of the ACM 51, 107.',
    'Dean, J., Ghemawat, S. (2008). MapReduce. Fault-tolerant scheduling for heterogeneous clusters. In OSDI.',
    'Smith, J., Doe, A. (2008). MapReduce. Communications of the ACM 51, 107.',
    'Dean J, Ghemawat S. Map reduce. Communications of the ACM. 2008.',
    'Dean J, Ghemawat S. MapReduce: fault tolerance at scale. Communications of the ACM. 2008.',
  ])('not Verified: %s', async (text) => {
    expect(INVENTED).toContain(await run(text, [mr]));
  });
  test('a clause that is the record\'s subtitle still allows it', async () => {
    expect(await run('Dean, J., Ghemawat, S. (2008). MapReduce. Simplified data processing on large clusters. Communications of the ACM 51, 107.', [mr])).toBe('verified');
  });
  test('a short title never carries a retraction on title, authors and year alone', async () => {
    expect(await run('Anil R, Borgeaud S, Wu Y. Gemini. arXiv preprint 2023.', [gem, gemR])).not.toBe('retracted');
    expect(await run('Anil R, Borgeaud S, Wu Y. Gemini. arXiv preprint 2023.', [gemR])).not.toBe('retracted');
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2008.', [mr], true)).toBe('verified');
  });
  test('with the volume and first page agreeing too, it is a strong match', async () => {
    const located = { ...mr, volume: '51', pages: ['107'] };
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2008;51:107–113.', [located], true)).toBe('retracted');
    expect(await run('Dean J, Ghemawat S. MapReduce. Communications of the ACM. 2008;52:107–113.', [located], true)).toBe('verified');
  });
  test('a two-word title: Verified, and Retracted only with the volume and first page', async () => {
    const deep = R({ title: 'Deep learning: an overview of methods', authors: ['lecun', 'bengio', 'hinton'], year: 2015 });
    const text = 'LeCun, Y., Bengio, Y., Hinton, G. (2015). Deep learning. Nature 521, 436–444.';
    expect(await run(text, [deep])).toBe('verified');
    expect(await run(text, [deep], true)).toBe('verified');
    expect(await run(text, [{ ...deep, volume: '521', pages: ['436'] }], true)).toBe('retracted');
  });
});

// A record marked retracted is never shown Verified unless it is a strong match (then Retracted).
describe('adversarial: a retracted record that is only a close match', () => {
  const run = async (text: string, per: Partial<Record<'crossref' | 'arxiv' | 'openreview' | 'openalex', WorkRecord[]>>) => {
    const over: Partial<Record<'crossref' | 'arxiv' | 'openreview' | 'openalex', { search: () => Promise<WorkRecord[]> }>> = {};
    for (const [s, w] of Object.entries(per)) over[s as keyof typeof over] = { search: () => Promise.resolve(w) };
    const deps = makeDeps(mockSources(over), { retraction: { check: vi.fn((m: WorkRecord) => Promise.resolve(m.isRetracted ? { retracted: true, version: 'cited' as const } : { retracted: false })) } });
    return checkReference(ref(1, text), deps, signal);
  };
  const T = 'Smith, J., Jones, A., Lee, K. (2020). Invariant risk minimization for deep networks. In NeurIPS.';
  test('S1: a close retracted record and an exact copy by others: Details differ, with a note', async () => {
    const r1 = R({ title: 'Invariant risk minimisation for deep networks', authors: ['smith', 'jones', 'lee'], year: 2020, isRetracted: true, doi: '10.1/r' });
    const o1 = R({ source: 'openalex', title: 'Invariant risk minimization for deep networks', authors: ['smyth'], year: 2020 });
    const r = await run(T, { crossref: [r1], openalex: [o1] });
    expect(r.status).toBe('details_differ');
    if (r.match?.isRetracted === true) expect(r.notes.join(' ')).toMatch(/retracted/);
  });
  test('the close retracted record alone: Details differ with a note, never Verified', async () => {
    const r1 = R({ title: 'Invariant risk minimisation for deep networks', authors: ['smith', 'jones', 'lee'], year: 2020, isRetracted: true, doi: '10.1/r' });
    const r = await run(T, { crossref: [r1] });
    expect(r.status).toBe('details_differ');
    expect(r.notes.join(' ')).toMatch(/retracted/);
  });
  test('S2: a confident arXiv copy beats a retracted record with the year off', async () => {
    const r2 = R({ title: 'Invariant risk minimization for deep networks', authors: ['smith', 'jones', 'lee'], year: 2022, isRetracted: true });
    const a2 = R({ source: 'arxiv', title: 'Invariant risk minimization for deep networks', authors: ['smith', 'jones', 'lee'], year: 2019, arxivId: '1907.00001' });
    expect((await run(T, { crossref: [r2], arxiv: [a2] })).status).toBe('verified');
  });
  test('S3, S4: Verified-level records by the cited authors, no accusation', async () => {
    const right = R({ title: 'Invariant risk minimization for deep networks', authors: ['consortium'], year: 2020 });
    const sib = R({ source: 'openreview', title: 'Invariant risk minimisation for deep networks', authors: ['smith', 'jones', 'lee'], year: 2020 });
    expect(REAL).toContain((await run(T, { crossref: [right], openreview: [sib] })).status);
    const real = R({ title: 'Deep residual learning for image recognition', authors: ['he', 'zhang', 'ren'], year: 2016 });
    const decoy = R({ source: 'openalex', title: 'Deep residual learning for image recognitions', authors: ['cortes', 'vapnik'], year: 2016 });
    expect(REAL).toContain((await run('Cortes, C., Vapnik, V. (2016). Deep residual learning for image recognition. In CVPR.', { crossref: [real], openalex: [decoy] })).status);
  });
  test('S5: a strong retracted record is Retracted', async () => {
    const r5 = R({ title: 'Invariant risk minimization for deep networks', authors: ['smith', 'jones', 'lee'], year: 2020, isRetracted: true });
    const o5 = R({ source: 'openalex', title: 'Invariant risk minimization for deep networks', authors: ['smith', 'jones', 'lee'], year: 2020 });
    expect((await run(T, { crossref: [r5], openalex: [o5] })).status).toBe('retracted');
  });
  test('S6, S7: nothing confident, nothing at all', async () => {
    expect((await run(T, { crossref: [R({ title: 'Invariant risk minimization', authors: ['x'], year: 2020 })] })).status).not.toBe('verified');
    expect((await run(T, {})).status).toBe('not_found');
  });
  test('Gemini with only the retracted sibling: not Verified, not Retracted', async () => {
    const gemR = R({ title: 'Gemini: retracted sibling study', authors: ['anil', 'borgeaud', 'wu'], year: 2023, isRetracted: true });
    const r = await run('Anil R, Borgeaud S, Wu Y. Gemini. arXiv preprint 2023.', { crossref: [gemR] });
    expect(['details_differ', 'cant_check']).toContain(r.status);
  });
});

// A lower-case author name before a bracketed year. The real reference is read and matched;
// an invented title after the same names is still not Verified.
describe('adversarial: a lower-case author name before a bracketed year', () => {
  const lora = R({ source: 'arxiv', title: 'LoRA: Low-Rank Adaptation of Large Language Models', authors: ['hu', 'shen', 'wallis', 'allen zhu', 'li', 'wang', 'wang', 'chen'], year: 2021, arxivId: '2106.09685' });
  const statusIn = async (text: string, openalexAll = false): Promise<Status> => {
    const { deps } = worldDeps({ openalexAll, world: [...WORLD, lora] });
    return (await checkReference(ref(20, text), deps, signal)).status;
  };
  const NAMES = 'E. J. Hu, yelong shen, P. Wallis, Z. Allen-Zhu, Y. Li, S. Wang, L. Wang, and W. Chen (2022)';

  test('the real reference (arxiv-html:2609.00505#20) is Verified', async () => {
    expect(await statusIn(`${NAMES} LoRA: low-rank adaptation of large language models. In International Conference on Learning Representations,`)).toBe('verified');
  });

  test.each([
    `${NAMES} LoRA: low-rank adaptation of large vision transformers. In International Conference on Learning Representations,`,
    `${NAMES} Sparse mixture routing for long-context retrieval in multilingual corpora. In ICLR.`,
    `${NAMES} LoRA: low-rank adaptation of large language models, revisited. In ICLR.`,
    'E. J. Hu, yelong shen, P. Wallis (2022) Low-rank adaptation of large language models for graph transformers. In ICLR.',
  ])('an invented title after the same names is not Verified: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain(await statusIn(text, openalexAll));
  });
});

// A TeX macro in a title is folded to its argument, in the query and in the comparison. The
// real reference is matched; an invented title in the same TeX, or the real one with a word changed, is not Verified.
describe('adversarial: a title that opens with a TeX macro', () => {
  const mao = R({ source: 'arxiv', title: '$\\widetilde{O}(T^{-1})$ Convergence to (Coarse) Correlated Equilibria in Full-Information General-Sum Markov Games', authors: ['mao', 'qiu', 'wang', 'franke', 'kalbarczyk', 'basar'], year: 2024, arxivId: '2403.07890' });
  const statusIn = async (text: string, openalexAll = false): Promise<Status> => {
    const { deps } = worldDeps({ openalexAll, world: [...WORLD, mao] });
    return (await checkReference(ref(16, text), deps, signal)).status;
  };
  const NAMES = 'Weichao Mao, Haoran Qiu, Chen Wang, Hubertus Franke, Zbigniew Kalbarczyk, and Tamer Başar.';
  const VENUE = 'In Proceedings of the 6th Annual Learning for Dynamics and Control Conference (L4DC), 2024.';

  test('the real reference (arxiv-html:2609.00504#16) is Verified', async () => {
    expect(await statusIn(`${NAMES} \\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria in full-information general-sum Markov games. ${VENUE}`)).toBe('verified');
  });

  test.each([
    `${NAMES} \\widetilde{O}(\\sqrt{T}) regret for adversarial bandits in general-sum Markov games. ${VENUE}`,
    `${NAMES} \\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria in zero-sum stochastic games. ${VENUE}`,
    `${NAMES} \\mathcal{O}(T^{-1}) convergence to correlated equilibria in full-information general-sum Markov games with \\widetilde{\\mathrm{noise}}. ${VENUE}`,
    `${NAMES} \\widetilde{\\mathcal{X}}: sparse mixture routing for long-context retrieval. ${VENUE}`,
  ])('an invented title in TeX is not Verified: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain(await statusIn(text, openalexAll));
  });
});

// A talk is Can't check whatever meeting it names, never Not found. A fabricated proceedings
// paper still is Not found, and one whose title mentions a talk is still not Verified.
describe('adversarial: talks and keynotes', () => {
  test('the real reference (arxiv-pdf:1801.00631#4) is Can\'t check', async () => {
    expect(await statusOf('Bottou, L. (2015). Two big challenges in machine learning. Proceedings from 32nd International Conference on Machine Learning.', false)).toBe('cant_check');
  });
  test.each([
    'Bottou, L. (2015). Two big challenges in machine learning. Invited talk, 32nd International Conference on Machine Learning.',
    'L. Bottou. Two big challenges in machine learning. Keynote, ICML 2015, Lille.',
  ])('a talk: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(await statusOf(text, openalexAll)).toBe('cant_check');
  });
  test.each([
    'Whitfield, A., Okonkwo, R. (2015). Two big challenges in sparse mixture routing. In Proceedings of the 32nd International Conference on Machine Learning, 2015.',
    'A. Whitfield, R. Okonkwo, and L. Haverford. Sparse Mixture Routing for Long-Context Retrieval in Multilingual Corpora. Proceedings of the 38th International Conference on Machine Learning (2021).',
    'Vaswani, A., Shazeer, N., Parmar, N. (2017). Talk is all you need. In Proceedings of the 34th International Conference on Machine Learning, 2017.',
  ])('a fabricated proceedings paper is Not found: %s', async (text) => {
    expect(await statusOf(text, false)).toBe('not_found');
    expect(INVENTED).toContain(await statusOf(text, true));
  });
  test('an invented talk is not Verified by a paper of a similar title', async () => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain(await statusOf('Vaswani, A. (2017). Attention is all you need for talks. Invited talk, NeurIPS 2017.', openalexAll));
  });
  test.each([
    'Bottou, L. Invited talk: Two big challenges in machine learning. ICML 2015.',
    'Bottou, L. (2015). Two big challenges in machine learning. Keynote talk. In Proceedings of the 32nd International Conference on Machine Learning, 2015.',
    'Miles Macklin. Warp: A high-performance Python framework for GPU simulation and graphics. NVIDIA GPU Technology Conference (GTC), https://github.com/NVIDIA/warp, 2022.',
  ])('a talk named before its title, with its proceedings, or about software is Can\'t check: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(await statusOf(text, openalexAll)).toBe('cant_check');
  });
  test.each([
    'Whitfield, A., Okonkwo, R. (2017). Keynote talk: Sparse mixture routing for long-context retrieval in multilingual corpora. In Proceedings of the 34th International Conference on Machine Learning, pages 1-9, 2017.',
    'A. Whitfield. Sparse mixture routing for long-context retrieval in multilingual corpora. In Proceedings of the GPU Technology Conference, https://github.com/whitfield/routing, 2022.',
  ])('a fabricated paper with pages or proceedings stays Not found: %s', async (text) => {
    expect(await statusOf(text, false)).toBe('not_found');
  });
  test('a real paper cited with its oral presentation is still Verified', async () => {
    expect(await statusOf('Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. In NeurIPS. Oral presentation.', false)).toBe('verified');
  });
});

// When an arXiv id cannot be looked up, the reference falls back on its title. An invented
// id never makes a reference Verified, Not found or Wrong ID by itself: the title search decides exactly as it would
// with no id cited, except that arXiv's silence is never read as absence.
describe('adversarial: an arXiv id whose lookup fails', () => {
  const failingId = (openalexAll: boolean) => {
    const { sources, deps } = worldDeps({ openalexAll });
    sources.arxiv.lookupById.mockImplementation(() => Promise.reject(new SourceError('timeout', 'arxiv', 'Request timed out after 15000 ms')));
    return deps;
  };
  const statusWith = async (text: string, openalexAll: boolean): Promise<Status> => (await checkReference(ref(1, text), failingId(openalexAll), signal)).status;
  const BASE: [string, string][] = [
    ['real title, invented id', 'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. In NeurIPS.'],
    ['invented title', 'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need for graph transformers. In NeurIPS.'],
    ['invented title and authors', 'Whitfield, A., Okonkwo, R. (2021). Sparse mixture routing for long-context retrieval in multilingual corpora. In ICML.'],
    ['real title, wrong year', 'He, K., Zhang, X., Ren, S., Sun, J. (2009). Deep residual learning for image recognition. In CVPR.'],
  ];

  test.each(BASE)('%s: the failed id lookup changes nothing but Not found', async (_name, text) => {
    for (const openalexAll of [false, true]) {
      const withId = await statusWith(`${text} arXiv:2203.98765.`, openalexAll);
      const alone = await statusOf(text, openalexAll);
      expect(['not_found', 'wrong_id', 'retracted']).not.toContain(withId);
      if (withId === 'verified') expect(alone).toBe('verified');
      if (alone !== 'not_found') expect(withId).toBe(alone);
      else expect(withId).toBe('cant_check');
    }
  });

  test('an id-only reference whose lookup fails is Can\'t check, try again later', async () => {
    const r = await checkReference(ref(1, 'DeepSeek-AI, Aixin Liu, Bei Feng. arXiv:2412.19437, 2024.'), failingId(false), signal);
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/Try again later/);
  });
});

// The arXiv batch retry through the real adapter, http.ts and the arXiv limiter (fetch stubbed, fake timers), its cost
// while arXiv is down, and the arXiv id rules end to end. Each test states the safe outcome.
describe('adversarial: the arXiv batch retry', () => {
  const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
  const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `2101.${String(10_000 + i)}`);
  // ---------------------------------------------------------------------------------------------------------------------
  // The retry against the real adapter, http.ts and the arXiv limiter.
  describe('arXiv retry through http.ts and the limiter', () => {
    const MIN_GAP_MS = 1000 / RATE.arxiv.ratePerSec;
    let calls: { at: number; ids: string[] }[];

    const entry = (id: string) => `<entry><id>http://arxiv.org/abs/${id}v1</id><title>Graph neural networks for protein folding at scale</title><published>2019-01-01T00:00:00Z</published><author><name>Jane Roe</name></author><author><name>John Smith</name></author><author><name>Wei Chen</name></author></entry>`;
    const feed = (ids: string[]) => `<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults>${ids.length}</opensearch:totalResults>${ids.map(entry).join('')}</feed>`;
    const respond = (url: string, status: number, body: string, headers: Record<string, string> = {}): Response => {
      const r = new Response(status === 200 ? body : null, { status, headers: { 'content-type': 'application/atom+xml', ...headers } });
      Object.defineProperty(r, 'url', { value: url });
      return r;
    };
    const stubFetch = (answer: (ids: string[], url: string) => Response) => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => {
          const url = String(input);
          const ids = (new URL(url).searchParams.get('id_list') ?? '').split(',').filter((s) => s !== '');
          calls.push({ at: Date.now(), ids });
          return Promise.resolve(answer(ids, url));
        }),
      );
    };
    const run = async (n: number) => {
      const sources = mockSources();
      const deps = makeDeps({ ...sources, arxiv: arxiv as unknown as typeof sources.arxiv });
      const got: CheckResult[] = [];
      const p = runCheck({ paper: PAPER, refs: idsOf(n).map((id, i) => paperRef(i + 1, { arxivId: id })), onResult: (r) => got.push(r), signal: new AbortController().signal }, deps);
      let settled = false;
      void p.finally(() => (settled = true)).catch(() => undefined);
      for (let i = 0; i < 2000 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
      await p;
      return got;
    };

    beforeEach(() => {
      freshNetwork();
      calls = [];
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    test('a 503 on the big batch: the smaller batches go out one at a time, at least 3 s apart, to export.arxiv.org only', async () => {
      stubFetch((ids, url) => (ids.length > 10 ? respond(url, 503, '') : respond(url, 200, feed(ids))));
      const got = await run(25);
      for (let i = 1; i < calls.length; i++) expect((calls[i]?.at ?? 0) - (calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(MIN_GAP_MS);
      expect(calls.map((c) => c.ids.length)).toEqual([25, 25, 25, 25, 10, 10, 5]);
      const fetched = (vi.mocked(fetch).mock.calls as unknown as [string][]).map((c) => new URL(c[0]).origin);
      expect(new Set(fetched)).toEqual(new Set(['https://export.arxiv.org']));
      expect(got.every((r) => r.status === 'verified')).toBe(true);
    });

    // http.ts gives up at once on a 503 whose Retry-After exceeds MAX_RETRY_WAIT_MS and surfaces a 'network' error
    // carrying retryAfterMs, without pausing the limiter (only a 429 pauses it). The retry must not read that as worth
    // asking again and walk back into a server that asked for an hour's rest.
    test('a 503 with Retry-After of an hour is not asked again within the hour', async () => {
      stubFetch((_ids, url) => respond(url, 503, '', { 'retry-after': '3600' }));
      const got = await run(25);
      const first = calls[0]?.at ?? 0;
      // Id lookups only: the per-reference arXiv title searches that follow are not part of the retry.
      const early = calls.filter((c) => c.ids.length > 0 && c.at > first && c.at < first + 3_600_000);
      expect(early).toEqual([]);
      expect(got.every((r) => r.status !== 'not_found' && r.status !== 'wrong_id')).toBe(true);
    });

    test('a 429 on the big batch is not asked again', async () => {
      stubFetch((_ids, url) => respond(url, 429, '', { 'retry-after': '3600' }));
      await run(25);
      expect(calls.filter((c) => c.ids.length > 0)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // The retry on mocked sources: how much it can add while arXiv is down.
  describe('arXiv retry: cost while arXiv is down', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const timeout = () => new SourceError('timeout', 'arxiv', 'Request timed out after 15000 ms');

    // prefetchArxiv is awaited before any reference is checked. Sending every retry batch while each one times out would
    // leave a paper with 95 ids showing nothing for 1 + 10 timeouts (about 165 s) instead of one (15 s), so the retry
    // stops after the first small batch fails the same way.
    test('a timeout on every batch stops the retry after the first small batch fails too', async () => {
      const sources = mockSources({}, () => Promise.reject(timeout()));
      await runCheck({ paper: PAPER, refs: idsOf(95).map((id, i) => paperRef(i + 1, { arxivId: id })), onResult: () => undefined, signal: new AbortController().signal }, makeDeps(sources));
      expect(sources.arxiv.lookupMany.mock.calls.length).toBeLessThanOrEqual(2);
    });

    // A refusal is not asked again; an offline browser is not either.
    test.each(['rate_limited', 'budget_exhausted', 'forbidden', 'not_found_http', 'offline'] as const)('%s is not asked again', async (kind) => {
      const sources = mockSources({}, () => Promise.reject(new SourceError(kind, 'arxiv', 'x')));
      await runCheck({ paper: PAPER, refs: idsOf(25).map((id, i) => paperRef(i + 1, { arxivId: id })), onResult: () => undefined, signal: new AbortController().signal }, makeDeps(sources)).catch(() => undefined);
      expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(1);
    });

    // An HTML answer where XML was expected (a bot challenge or a maintenance page:
    // 'unavailable') is a refusal, not asked again.
    test('an HTML challenge page is not asked again', async () => {
      const sources = mockSources({}, () => Promise.reject(new SourceError('unavailable', 'arxiv', 'Expected xml but the service sent text/html')));
      await runCheck({ paper: PAPER, refs: idsOf(25).map((id, i) => paperRef(i + 1, { arxivId: id })), onResult: () => undefined, signal: new AbortController().signal }, makeDeps(sources));
      expect(sources.arxiv.lookupMany).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // A wrong arXiv id with a real title, when the id lookup fails: the title search Verifies it. The retry makes this
  // rarer, not impossible.
  describe('a real title with another paper\'s arXiv id, id lookup failed (known limit)', () => {
    test('the title search alone decides', async () => {
      const { sources, deps } = worldDeps();
      sources.arxiv.lookupById.mockImplementation(() => Promise.reject(new SourceError('timeout', 'arxiv', 't')));
      const r = await checkReference(ref(1, 'He, K., Zhang, X., Ren, S., Sun, J. (2016). Deep residual learning for image recognition. In CVPR. arXiv:1706.03762.'), deps, signal);
      expect(r.status).toBe('verified');
      expect(r.sourcesFailed).toContain('arxiv');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // End to end: the arXiv id rules on the adversarial world.
  describe('end to end on the adversarial world', () => {
    const np = R({ source: 'arxiv', title: 'NP-Hardness of Learning Sparse Mixture Routers', authors: ['whitfield', 'okonkwo'], year: 2020, arxivId: '2003.01234' });
    const statusIn = async (text: string, world: WorkRecord[], openalexAll = false): Promise<Status> => {
      const { deps } = worldDeps({ openalexAll, world });
      return (await checkReference(ref(1, text), deps, signal)).status;
    };

    // Dropping the custom macro \PSPACE would make the corrupted title score 0.93 against the NP record.
    test.each([
      'A. Whitfield and R. Okonkwo. \\PSPACE-hardness of learning sparse mixture routers. In Proceedings of ICML, pages 1-9, 2020.',
    ])('a corrupted complexity class is not Verified: %s', async (text) => {
      for (const openalexAll of [false, true]) expect(INVENTED).toContain(await statusIn(text, [...WORLD, np], openalexAll));
    });

    // A fabricated survey in IEEE Communications Surveys & Tutorials, whose name holds a talk word.
    test('a fabricated COMST survey is Not found', async () => {
      expect(await statusIn('A. Whitfield, R. Okonkwo, Sparse mixture routing for long-context retrieval in multilingual corpora: a survey, IEEE Communications Surveys & Tutorials 22 (3) (2020) 1646-1685.', WORLD)).toBe('not_found');
    });

    // Controls: real citations reach no accusation through these rules.
    test.each([
      'A. Vaswani, noam shazeer, N. Parmar (2017) Attention is all you need. In NeurIPS.',
      'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. In NeurIPS. Invited talk.',
      'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). \\textsc{Attention} is all you need. In NeurIPS.',
    ])('real: %s', async (text) => {
      for (const openalexAll of [false, true]) expect(['verified', 'details_differ', 'cant_check']).toContain(await statusIn(text, WORLD, openalexAll));
    });
  });
});

// A source that answers every request with a 503 and a long Retry-After, through the real Crossref adapter, http.ts and
// its limiter.
describe('adversarial: a hostile Retry-After', () => {
  describe('Retry-After pause on a 5xx: how long a paper takes', () => {
    const PAPER: PaperInfo = { key: 'arxiv:2101.00001', title: 'A paper', url: 'https://arxiv.org/abs/2101.00001', origin: 'arxiv-abs', viaPdf: false };
    let starts: number[];
    beforeEach(() => {
      freshNetwork();
      starts = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => {
          starts.push(Date.now());
          const r = new Response(null, { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '3600' } });
          Object.defineProperty(r, 'url', { value: String(input) });
          return Promise.resolve(r);
        }),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    test('Crossref in maintenance (503, Retry-After 1 h): 12 references are not held back for minutes', async () => {
      const sources = mockSources();
      const deps = makeDeps({ ...sources, crossref: crossref as unknown as typeof sources.crossref });
      const refs = Array.from({ length: 12 }, (_, i) => paperRef(i + 1, { title: `Graph neural networks for protein folding at scale, part ${String(i + 1)}` }));
      const got: CheckResult[] = [];
      const t0 = Date.now();
      const p = runCheck({ paper: PAPER, refs, onResult: (r) => got.push(r), signal: new AbortController().signal }, deps);
      let done = false;
      void p.finally(() => (done = true)).catch(() => undefined);
      for (let i = 0; i < 4000 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
      await p;
      const elapsed = Date.now() - t0;
      expect(got).toHaveLength(12);
      expect(got.every((r) => r.status === 'cant_check')).toBe(true);
      expect(elapsed).toBeLessThan(60_000);
      // Crossref is asked once; the other references are not sent until the stated time.
      expect(starts).toHaveLength(1);
      expect(got.every((r) => /Try again later/.test(r.reason))).toBe(true);
    });

    // The request after a long Retry-After is not held back for 30 s, it fails at once without being
    // sent, with the time left to wait.
    test('a hostile Retry-After never holds a request back: the next one fails at once, unsent', async () => {
      await expect(fetchJson('https://api.crossref.org/works?query=x', { source: 'crossref' })).rejects.toBeInstanceOf(SourceError);
      const p = fetchJson('https://api.crossref.org/works?query=y', { source: 'crossref' }).catch((e: unknown) => e);
      // It fails before it even takes a turn in the limiter, certainly not after 30 s.
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toMatchObject({ name: 'SourceError', retryAfterMs: expect.any(Number) as number });
      expect(starts).toHaveLength(1);
    });
  });
});

// A note field or a publisher is no venue; legislation, a dataset or an agency's document that
// nothing matched is Can't check. An invented journal paper dressed the same way stays Not found, on the engine too.
describe('adversarial: notes, publishers and documents', () => {
  const blocksStatus = async (blocks: string[], openalexAll: boolean): Promise<Status> => {
    const { deps } = worldDeps({ openalexAll });
    return (await checkReference({ index: 16, label: '[16]', text: blocks.join(' '), blocks }, deps, signal)).status;
  };

  test.each([
    [['European Union', 'Directive (EU) 2023/959 amending Directive 2003/87/EC establishing a system for greenhouse gas emission allowance trading within the Union.', 'Note: Official Journal of the European Union, L 130, 16 May 2023, pp. 134–202']],
    [['E.U. Copernicus Marine Service Information', 'Global ocean waves reanalysis.', 'Copernicus Marine Service.', 'Note: Product ID: GLOBAL_MULTIYEAR_WAV_001_032; DATASET_ID: cmems_mod_glo_wav_my_0.2deg_PT3H-i']],
    [['OECD', 'Maritime transport CO {}_{2} emissions: methodology update.', 'Note: Methodological note for the 2025-Q1 release of the OECD maritime transport CO {}_{2} emissions database']],
  ])('the real document is Can\'t check: %j', async (blocks) => {
    for (const openalexAll of [false, true]) expect(await blocksStatus(blocks, openalexAll)).toBe('cant_check');
  });

  test.each([
    [['A. Whitfield and R. Okonkwo', 'Sparse mixture routing for ship emissions.', 'Journal of Maritime Economics 12 (3), pp. 45–67.', 'Note: Data: Harvard Dataverse']],
    [['OECD', 'Carbon pricing in sparse mixture shipping.', 'Journal of Maritime Economics 12, pp. 45–67.']],
    [['European Union', 'Directive 2003/87/EC and carbon leakage in sparse mixture shipping.', 'Energy Policy 39, pp. 1234–1240.']],
  ])('an invented journal paper dressed as one stays Not found: %j', async (blocks) => {
    for (const openalexAll of [false, true]) expect(await blocksStatus(blocks, openalexAll)).toBe('not_found');
  });
});

// "Surname, I., Title. J. Stat. Phys. 113, 389–410 (2003)." is read with its title. The real
// reference is Verified; an invented or altered title in the same style is not, and an invented one nothing matches is
// Not found (it names its journal).
describe('adversarial: "Surname, I., Title. Journal vol, pages (year)"', () => {
  const zrp = R({ title: 'Condensation in the Zero Range Process: Stationary and Dynamical Properties', authors: ['grosskinsky', 'schutz', 'spohn'], year: 2003, doi: '10.1023/a:1025703819894', venue: 'Journal of Statistical Physics', volume: '113', pages: ['389'] });
  const statusIn = async (text: string, openalexAll = false): Promise<Status> => {
    const { deps } = worldDeps({ openalexAll, world: [...WORLD, zrp] });
    return (await checkReference({ index: 9, label: '(9)', text, blocks: [text] }, deps, signal)).status;
  };
  const NAMES = 'Grosskinsky, S., Schütz, G.M. and Spohn, H.,';

  test('the real reference (2610.00901#9) is Verified', async () => {
    for (const openalexAll of [false, true]) expect(await statusIn(`${NAMES} Condensation in the zero range process: stationary and dynamical properties. J. Stat. Phys. 113, 389–410 (2003).`, openalexAll)).toBe('verified');
  });

  test.each([
    `${NAMES} Condensation in the zero range process: a review. J. Stat. Phys. 113, 389–410 (2003).`,
    `${NAMES} Condensation in the inclusion process: stationary and dynamical properties. J. Stat. Phys. 113, 389–410 (2003).`,
    `${NAMES} Condensation in the zero range process: stationary and dynamical properties, Part II. J. Stat. Phys. 113, 389–410 (2003).`,
    `${NAMES} Sparse mixture routing on connected graphs. J. Stat. Phys. 113, 389–410 (2003).`,
    // (The real title without its subtitle, as a book, is Verified by design: a citation may drop a subtitle.)
    `${NAMES} Condensation in sparse mixture processes. Springer-Verlag, Berlin (2003).`,
    'Whitfield, A. and Okonkwo, R., Condensation in the zero range process: stationary and dynamical properties. J. Stat. Phys. 113, 389–410 (2019).',
  ])('an invented or altered citation in the same style is not Verified: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain(await statusIn(text, openalexAll));
  });

  test('an invented journal paper in this style that nothing matches is Not found', async () => {
    expect(await statusIn('Whitfield, A. and Okonkwo, R., Sparse mixture routing on connected graphs. J. Stat. Phys. 113, 389–410 (2003).')).toBe('not_found');
  });
});

// A DOI in a "Note: Data: ..." clause is not the reference's own. The real reference is matched
// by its title, not compared with the dataset record; a citation cannot borrow a real DOI through such a clause either.
describe('adversarial: a data DOI in a note', () => {
  const paper = R({ title: 'Precise visuomotor transformations underlying collective behavior in larval zebrafish', authors: ['harpaz', 'nguyen', 'bahl', 'engert'], year: 2021, doi: '10.1038/s41467-021-26748-0', venue: 'Nature Communications', volume: '12' });
  const data = R({ source: 'openalex', title: 'Data for Precise visuomotor transformations underlying collective behavior in larval zebrafish', authors: ['harpaz'], year: 2021, doi: '10.7910/dvn/povjys', venue: 'Harvard Dataverse' });
  const run = async (text: string, openalexAll = false): Promise<CheckResult> => {
    const { deps } = worldDeps({ openalexAll, world: [...WORLD, paper, data] });
    return checkReference(ref(6, text), deps, signal);
  };
  const NAMES = 'R. Harpaz, M. N. Nguyen, A. Bahl, and F. Engert (2021)';
  const NOTE = 'Note: Data: Harvard Dataverse, https://doi.org/10.7910/DVN/POVJYS, CC0';

  test('the real reference (2610.00990#6) is Verified against the paper, not the dataset', async () => {
    for (const openalexAll of [false, true]) {
      const r = await run(`${NAMES} Precise visuomotor transformations underlying collective behavior in larval zebrafish. Nature Communications 12, pp. 6578. ${NOTE}`, openalexAll);
      expect(r.status).toBe('verified');
      expect(r.match?.doi).toBe('10.1038/s41467-021-26748-0');
    }
  });

  test.each([
    `${NAMES} Sparse mixture routing in larval zebrafish. Nature Communications 12, pp. 6578. ${NOTE}`,
    'R. Harpaz, M. N. Nguyen, A. Bahl, and F. Engert (2012) Precise visuomotor transformations underlying collective behavior in larval zebrafish. Nature Communications 3, pp. 6578. Note: Data: Harvard Dataverse, https://doi.org/10.7910/DVN/POVJYS, CC0',
    'A. Whitfield and R. Okonkwo (2021) Precise visuomotor transformations underlying collective behavior in larval zebrafish. Nature Communications 12, pp. 6578. Note: Data: https://doi.org/10.1038/s41467-021-26748-0',
  ])('an invented or altered citation with a data clause is not Verified: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain((await run(text, openalexAll)).status);
  });
});

// "287 (1937)" is an issue when the reference gives another year. The real reference is
// Verified; one whose own year is wrong is still not, whatever its issue number.
describe('adversarial: a bracketed issue number', () => {
  const mckee = R({ title: 'The sensory basis of schooling by intermittent swimming in the rummy-nose tetra (Hemigrammus rhodostomus)', authors: ['mckee', 'soto', 'chen', 'mchenry'], year: 2020, doi: '10.1098/rspb.2020.0568', venue: 'Proceedings of the Royal Society B: Biological Sciences', volume: '287', pages: ['20200568'] });
  const statusIn = async (text: string, openalexAll = false): Promise<Status> => {
    const { deps } = worldDeps({ openalexAll, world: [...WORLD, mckee] });
    return (await checkReference(ref(9, text), deps, signal)).status;
  };
  const NAMES = 'A. McKee, A. P. Soto, P. Chen, and M. J. McHenry';
  const TITLE = 'The sensory basis of schooling by intermittent swimming in the rummy-nose tetra (Hemigrammus rhodostomus)';

  test('the real reference (2610.00990#9) is Verified', async () => {
    for (const openalexAll of [false, true]) expect(await statusIn(`${NAMES} (2020) ${TITLE}. Proceedings of the Royal Society B: Biological Sciences 287 (1937), pp. 20200568.`, openalexAll)).toBe('verified');
  });

  test.each([
    `${NAMES} (2015) ${TITLE}. Proceedings of the Royal Society B: Biological Sciences 287 (2020), pp. 20200568.`,
    `${NAMES} (2015) ${TITLE}. Proceedings of the Royal Society B: Biological Sciences 287 (1937), pp. 20200568.`,
    `${NAMES} (2020) The sensory basis of schooling by intermittent swimming in zebrafish. Proceedings of the Royal Society B: Biological Sciences 287 (1937), pp. 20200568.`,
  ])('a citation with a wrong year or title is not Verified: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain(await statusIn(text, openalexAll));
  });
});

// The arXiv record of a paper cited by its journal year two or more years after the posting differs only in its year.
// The journal version, found by the title, is the one cited: Verified. Nothing else changes: a wrong year, title or author stays as it was.
describe('adversarial: an arXiv record against a journal year', () => {
  const arxivRec = R({ source: 'arxiv', title: 'Supersymmetric Flux Compactifications and Calabi-Yau Modularity', authors: ['kachru', 'nally', 'yang'], year: 2020, arxivId: '2001.06022' });
  const journal = R({ title: 'Supersymmetric flux compactifications and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/cntp.2024.v18.n3.a2', venue: 'Communications in Number Theory and Physics', volume: '18', pages: ['653'] });
  const run = async (text: string, world: WorkRecord[] = [...WORLD, arxivRec, journal], openalexAll = false): Promise<CheckResult> => {
    const { deps } = worldDeps({ openalexAll, world });
    return checkReference(ref(7, text), deps, signal);
  };
  const NAMES = 'S. Kachru, R. Nally and W. Yang';
  const cite = (title: string, year: number, id = '2001.06022') => `${NAMES}, ${title}, Commun. Num. Theor. Phys. 18 (${year}) 653 [${id}].`;
  const TITLE = 'Supersymmetric flux compactifications and Calabi-Yau modularity';

  test('the real reference is Verified against the journal version', async () => {
    for (const openalexAll of [false, true]) {
      const r = await run(cite(TITLE, 2024), undefined, openalexAll);
      expect(r.status).toBe('verified');
      expect(r.match?.doi).toBe('10.4310/cntp.2024.v18.n3.a2');
    }
  });

  test('with no journal version to find, the arXiv record\'s year still differs', async () => {
    const r = await run(cite(TITLE, 2024), [...WORLD, arxivRec]);
    expect(r.status).toBe('details_differ');
    expect(r.reason).toMatch(/Year differs/);
  });

  test.each([
    ['a year matching neither version', cite(TITLE, 2016)],
    ['a year before the posting', cite(TITLE, 2015)],
    ['an altered title', cite('Supersymmetric flux compactifications and Calabi-Yau modularity, revisited', 2024)],
    ['an invented title', cite('Sparse mixture routing in Calabi-Yau flux compactifications', 2024)],
    ['other authors', `A. Whitfield and R. Okonkwo, ${TITLE}, Commun. Num. Theor. Phys. 18 (2024) 653 [2001.06022].`],
  ])('%s is not Verified', async (_name, text) => {
    for (const openalexAll of [false, true]) expect(NOT_VERIFIED).toContain((await run(text, undefined, openalexAll)).status);
  });

  // A retracted journal version found on this path goes through the retraction path.
  test('a retracted journal version that is a strong match is Retracted', async () => {
    const r = await run(cite(TITLE, 2024), [...WORLD, arxivRec, { ...journal, isRetracted: true }]);
    expect(r.status).toBe('retracted');
  });
});

// A record with the cited title by other people, years later, does not win over the cited
// authors' own record; a record whose author list is implausible ("1") is weak evidence, on the engine too.
describe('adversarial: same title, other work; implausible author lists', () => {
  const chapter = R({ title: 'Generative Adversarial Nets', authors: ['labaca castro'], year: 2023, doi: '10.1007/978-3-658-40442-0_9', venue: 'Machine Learning under Malware Attack' });
  const junk = R({ title: 'CUSTOMER CHURN PREDICTION IN TELECOM INDUSTRY', authors: ['1'], year: 2026 });
  const junkGan = R({ title: 'Generative adversarial nets', authors: ['1'], year: 2014, isRetracted: true });
  const run = async (text: string, world: WorkRecord[], openalexAll = false): Promise<CheckResult> => {
    const { deps } = worldDeps({ openalexAll, world });
    return checkReference(ref(8, text), deps, signal);
  };
  const GAN = 'Goodfellow, I., Pouget-Abadie, J., Mirza, M., Xu, B., Warde-Farley, D., Ozair, S., Courville, A., Bengio, Y.: Generative adversarial nets. Advances in neural information processing systems 27 (2014)';

  test('the real GAN reference (2503.00266#8) is Verified against the cited authors\' record, not the 2023 chapter', async () => {
    for (const openalexAll of [false, true]) {
      const r = await run(GAN, [chapter, ...WORLD], openalexAll);
      expect(r.status).toBe('verified');
      expect(r.match?.authors[0]).toBe('goodfellow');
    }
  });

  test.each([
    'Whitfield, A., Okonkwo, R.: Generative adversarial nets. Advances in neural information processing systems 27 (2014)',
    'Goodfellow, I., Pouget-Abadie, J., Mirza, M.: Generative adversarial nets for graph transformers. Advances in neural information processing systems 27 (2014)',
    'Goodfellow, I., Pouget-Abadie, J., Mirza, M.: Generative adversarial nets. Advances in neural information processing systems 27 (2023)',
  ])('an invented or altered GAN citation is not Verified: %s', async (text) => {
    for (const openalexAll of [false, true]) expect(INVENTED).toContain((await run(text, [chapter, ...WORLD], openalexAll)).status);
  });

  test('the real survey (1904.00690#6) against a record whose only author is "1" is Can\'t check, not Details differ or Not found', async () => {
    const r = await run('Umayaparvathi V, Iyakutti K. A survey on customer churn prediction in telecom industry: datasets, methods and metric. Int Res J Eng Technol. 2016;3(4):1065–70.', [...WORLD, junk]);
    expect(r.status).toBe('cant_check');
  });

  test('a record whose only author is "1" never makes a citation Verified or Retracted', async () => {
    for (const text of ['Whitfield, A., Okonkwo, R.: Generative adversarial nets. Advances in neural information processing systems 27 (2014)', GAN]) {
      const world = [junkGan, ...WORLD.filter((r) => !/generative adversarial/i.test(r.title))];
      for (const openalexAll of [false, true]) expect(INVENTED).toContain((await run(text, world, openalexAll)).status);
    }
  });
});

// A chapter cited without its own title is not compared with the volume's record as if it
// were the paper. A chapter cited with its title still is matched the ordinary way.
describe('adversarial: a chapter cited without its own title', () => {
  const volume = R({ title: 'Solid State Physics', authors: ['kubo', 'nagamiya', 'price'], year: 1971, doi: '10.1063/1.3022632', venue: 'Physics Today', volume: '24', pages: ['59'] });
  const chapter = R({ title: 'Helical Spin Ordering—1 Theory of Helical Spin Configurations', authors: ['nagamiya'], year: 1968, doi: '10.1016/s0081-1947(08)60740-0', venue: 'Solid State Physics', volume: '20', pages: ['305'] });
  const run = async (text: string, openalexAll = false): Promise<CheckResult> => {
    const { deps } = worldDeps({ openalexAll, world: [...WORLD, volume, chapter] });
    return checkReference(ref(31, text), deps, signal);
  };

  test.each([
    'T. Nagamiya, in Solid State Physics, Vol. 20 (Elsevier, 1968) pp. 305–411.',
    'A. Whitfield, in Solid State Physics, Vol. 20 (Elsevier, 1968) pp. 305–411.',
    'T. Nagamiya, in Solid State Physics, Vol. 99 (Elsevier, 2019) pp. 1–20.',
  ])('the title-less chapter is Can\'t check, never matched to the volume: %s', async (text) => {
    for (const openalexAll of [false, true]) {
      const r = await run(text, openalexAll);
      expect(r.status).toBe('cant_check');
      expect(r.match).toBeUndefined();
    }
  });

  test('the chapter cited with its own title is Verified against the chapter', async () => {
    const r = await run('T. Nagamiya, Helical spin ordering—1 theory of helical spin configurations, in Solid State Physics, Vol. 20 (Elsevier, 1968) pp. 305–411.');
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1016/s0081-1947(08)60740-0');
  });
});

// Each case below states the safe outcome.
const run = async (text: string, world: WorkRecord[], openalexAll = false): Promise<CheckResult> => {
  const { deps } = worldDeps({ openalexAll, world });
  return checkReference(ref(1, text), deps, signal);
};

// The "Surname, I., Title. J. Abbrev. vol, pages (year)" reading must not move a sentence added after the title into the
// journal (or the publisher), where an altered citation would be compared on the real title alone and Verified.
describe('adversarial: an added sentence is not swallowed into the venue', () => {
  const zrp = R({ title: 'Condensation in the Zero Range Process: Stationary and Dynamical Properties', authors: ['grosskinsky', 'schutz', 'spohn'], year: 2003, doi: '10.1023/a:1025703819894', venue: 'Journal of Statistical Physics', volume: '113', pages: ['389'] });
  const N = 'Grosskinsky, S., Schütz, G.M. and Spohn, H.,';
  const T = 'Condensation in the zero range process: stationary and dynamical properties';
  test.each([
    `${N} ${T}. A Review. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. A Survey. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. Review. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. Reply. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. New Results. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. Extended Version. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. On Random Graphs. J. Stat. Phys. 113, 389–410 (2003).`,
    `${N} ${T}. A New Approach. Physica A 113, 389–410 (2003).`,
  ])('not Verified: %s', async (text) => {
    for (const oa of [false, true]) expect(INVENTED).toContain((await run(text, [...WORLD, zrp], oa)).status);
  });

  test('a Title Case title is not cut at its comma (an invented continuation is not dropped)', async () => {
    const short = R({ title: 'Exact results for random walks', authors: ['grosskinsky', 'schutz'], year: 2008, doi: '10.1007/x3', venue: 'Journal of Statistical Physics', volume: '133', pages: ['100'] });
    const text = 'Grosskinsky, S. and Schütz, G.M., Exact Results for Random Walks, Exclusion and Zero Range Models. J. Stat. Phys. 133, 100–120 (2008).';
    for (const oa of [false, true]) expect(INVENTED).toContain((await run(text, [...WORLD, short], oa)).status);
  });

  test.each([
    'Kipnis, C. and Landim, C., Scaling Limits of Interacting Particle Systems. A Survey. Cambridge University Press, Cambridge (1999).',
    'Kipnis, C. and Landim, C., Scaling Limits of Interacting Particle Systems. Second Volume. Cambridge University Press, Cambridge (1999).',
    'Kipnis, C. and Landim, C., Scaling Limits of Interacting Particle Systems. Lecture Notes. Oxford University Press, Oxford (1999).',
  ])('a book with an added sentence before the publisher is not Verified: %s', async (text) => {
    const book = R({ title: 'Scaling Limits of Interacting Particle Systems', authors: ['kipnis', 'landim'], year: 1999, doi: '10.1007/978-3-662-03752-2' });
    for (const oa of [false, true]) expect(INVENTED).toContain((await run(text, [...WORLD, book], oa)).status);
  });
});

// A Crossref record whose family names are Han characters ("王") is no implausible author list. Read as one,
// isStrongMatch would refuse it for identifier lookups too (DESIGN says "on a search"): a retracted work cited by its DOI
// would not be Retracted, and a bare DOI to such a record would not be Verified.
describe('adversarial: records with CJK author names keep their retractions', () => {
  const han = R({ title: 'Deep sparse mixture routing for traffic flow forecasting', authors: ['王', '李', '张'], year: 2019, doi: '10.11999/jeit190001', venue: 'Journal of Electronics & Information Technology', isRetracted: true });
  test('a bare DOI to a retracted record is Retracted', async () => {
    for (const oa of [false, true]) expect((await run('doi:10.11999/jeit190001', [...WORLD, han], oa)).status).toBe('retracted');
  });
  test('a bare DOI to a sound record is Verified', async () => {
    for (const oa of [false, true]) expect((await run('doi:10.11999/jeit190002', [...WORLD, { ...han, isRetracted: false, doi: '10.11999/jeit190002' }], oa)).status).toBe('verified');
  });
  test('a title-first citation with the DOI is Retracted', async () => {
    const text = 'Deep sparse mixture routing for traffic flow forecasting. Journal of Electronics & Information Technology, 2019, 41(3): 1-10. doi:10.11999/jeit190001';
    for (const oa of [false, true]) expect((await run(text, [...WORLD, han], oa)).status).toBe('retracted');
  });
  test('the same citation without the DOI, found by search, is Retracted', async () => {
    const text = 'Deep sparse mixture routing for traffic flow forecasting. Journal of Electronics & Information Technology, 2019, 41(3): 1-10.';
    for (const oa of [false, true]) expect((await run(text, [...WORLD, han], oa)).status).toBe('retracted');
  });
});


describe('adversarial: the weak-record rule is for search results only', () => {
  test('a bare DOI to a retracted record whose only author is "1" is still Retracted', async () => {
    const junk = R({ title: 'Deep sparse mixture routing for traffic flow forecasting', authors: ['1'], year: 2019, doi: '10.11999/jeit190003', isRetracted: true });
    for (const oa of [false, true]) expect((await run('doi:10.11999/jeit190003', [...WORLD, junk], oa)).status).toBe('retracted');
  });
});

// The journal-version search must not clear evidence.ambiguous and take a confident-but-not-strong record from an earlier
// source when a later source held two strong copies, one retracted, that the ordinary path refuses to choose between.
describe('adversarial: the journal-version search keeps an ambiguous retracted copy ambiguous', () => {
  test('not Verified while a strong copy of the cited work is retracted and cannot be told apart', async () => {
    const arxivRec = R({ source: 'arxiv', title: 'Supersymmetric Flux Compactifications and Calabi-Yau Modularity', authors: ['kachru', 'nally', 'yang'], year: 2020, arxivId: '2001.06022' });
    const close = R({ title: 'Supersymmetric flux compactification and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/close', venue: 'Communications in Number Theory and Physics' });
    const copyA = R({ source: 'openalex', title: 'Supersymmetric flux compactifications and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/a', venue: 'Communications in Number Theory and Physics', isRetracted: true });
    const copyB = { ...copyA, doi: '10.4310/b', isRetracted: false };
    const { deps, sources } = worldDeps({ world: [...WORLD, arxivRec, close] });
    sources.openalex.search.mockImplementation(() => Promise.resolve([copyA, copyB]));
    const text = 'S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity, Commun. Num. Theor. Phys. 18 (2024) 653 [2001.06022].';
    const r = await checkReference(ref(1, text), deps, signal);
    expect(r.status).not.toBe('verified');
  });
});

// Control: the ordinary path (no arXiv id) on the same world is Can't check (two copies, one retracted).
describe('adversarial: an ambiguous retracted copy on the ordinary path (control)', () => {
  test('without the arXiv id the same citation is not Verified', async () => {
    const close = R({ title: 'Supersymmetric flux compactification and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/close', venue: 'Communications in Number Theory and Physics' });
    const copyA = R({ source: 'openalex', title: 'Supersymmetric flux compactifications and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/a', venue: 'Communications in Number Theory and Physics', isRetracted: true });
    const copyB = { ...copyA, doi: '10.4310/b', isRetracted: false };
    const { deps, sources } = worldDeps({ world: [...WORLD, close] });
    sources.openalex.search.mockImplementation(() => Promise.resolve([copyA, copyB]));
    const r = await checkReference(ref(1, 'S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity, Commun. Num. Theor. Phys. 18 (2024) 653.'), deps, signal);
    expect(r.status).not.toBe('verified');
  });
});

// Step 3b searches Crossref only (no metered OpenAlex search), keeps two copies it cannot
// tell apart as the ordinary path does, takes a journal version only as a strong match, and shows a retracted close one
// with the calm note.
describe('adversarial: the journal-version search', () => {
  const arxivRec = R({ source: 'arxiv', title: 'Supersymmetric Flux Compactifications and Calabi-Yau Modularity', authors: ['kachru', 'nally', 'yang'], year: 2020, arxivId: '2001.06022' });
  const exact = R({ title: 'Supersymmetric flux compactifications and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/a', venue: 'Communications in Number Theory and Physics' });
  const TEXT = 'S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity, Commun. Num. Theor. Phys. 18 (2024) 653 [2001.06022].';

  test('two strong copies in Crossref, one retracted, are Can\'t check, as on the ordinary path', async () => {
    const { deps, sources } = worldDeps({ world: [...WORLD, arxivRec] });
    sources.crossref.search.mockImplementation(() => Promise.resolve([{ ...exact, isRetracted: true }, { ...exact, doi: '10.4310/b' }]));
    const r = await checkReference(ref(1, TEXT), deps, signal);
    expect(r.status).toBe('cant_check');
  });

  test('no OpenAlex search is spent on this path', async () => {
    const { deps, sources } = worldDeps({ openalexAll: true, world: [...WORLD, arxivRec] });
    const r = await checkReference(ref(1, TEXT), deps, signal);
    expect(r.status).toBe('details_differ');
    expect(sources.openalex.search).not.toHaveBeenCalled();
  });

  test('a retracted journal version that is only close is Details differ with the note', async () => {
    const close = R({ title: 'Supersymmetric flux compactification and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/close', isRetracted: true });
    const r = await run(TEXT, [...WORLD, arxivRec, close]);
    expect(r.status).toBe('details_differ');
    expect(r.notes.join(' ')).toMatch(/closest record found has been retracted/);
  });

  test('a journal version that is only close leaves the arXiv record as the match', async () => {
    const close = R({ title: 'Supersymmetric flux compactification and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/close' });
    const r = await run(TEXT, [...WORLD, arxivRec, close]);
    expect(r.status).toBe('details_differ');
    expect(r.match?.source).toBe('arxiv');
  });
});

describe('adversarial: added sentences that look like a journal\'s start', () => {
  // A Title Case sentence that opens with a JOURNAL_FIRST_WORD, or one that opens with an abbreviation, must not be read
  // into the journal, where the altered citation would be Verified.

  const zrp = R({ title: 'Condensation in the Zero Range Process: Stationary and Dynamical Properties', authors: ['grosskinsky', 'schutz', 'spohn'], year: 2003, doi: '10.1023/a:1025703819894', venue: 'Journal of Statistical Physics', volume: '113', pages: ['389'] });
  const crit = R({ title: 'Zero-range condensation at criticality', authors: ['armendariz', 'grosskinsky', 'loulakis'], year: 2013, doi: '10.1016/j.spa.2013.04.021', venue: 'Stochastic Processes and their Applications', volume: '123', pages: ['3466'] });
  const N = 'Grosskinsky, S., Schütz, G.M. and Spohn, H.,';
  const T = 'Condensation in the zero range process: stationary and dynamical properties';
  const A = 'Armendáriz, I., Grosskinsky, S. and Loulakis, M.,';
  const status = async (text: string, oa: boolean) => {
    const { deps } = worldDeps({ openalexAll: oa, world: [...WORLD, zrp, crit] });
    return (await checkReference(ref(1, text), deps, signal)).status;
  };

  describe('a journal first word opens an added sentence', () => {
    test.each(['Advances and Open Problems', 'Probability Bounds', 'Physical Origins', 'Chaos and Order', 'Theory and Models', 'Entropy Bounds'])('"%s." is not swallowed', async (s) => {
      for (const oa of [false, true]) expect(INVENTED).toContain(await status(`${N} ${T}. ${s}. J. Stat. Phys. 113, 389–410 (2003).`, oa));
    });
  });

  describe('an abbreviation opens an added sentence, after a full stop or a comma', () => {
    test.each([
      `${N} ${T}. Suppl. Material. J. Stat. Phys. 113, 389–410 (2003).`,
      `${N} ${T}. Corr. J. Stat. Phys. 113, 389–410 (2003).`,
      `${N} ${T}. Pt. Two. J. Stat. Phys. 113, 389–410 (2003).`,
      `${A} Zero-range condensation at criticality, Pt. Two. Stoch. Process. Appl. 123, 3466–3496 (2013).`,
      `${A} Zero-range condensation at criticality, Gen. Case. Stoch. Process. Appl. 123, 3466–3496 (2013).`,
    ])('not Verified: %s', async (text) => {
      for (const oa of [false, true]) expect(INVENTED).toContain(await status(text, oa));
    });

    test('control: the real comma form (2610.00901#1) is Verified', async () => {
      expect(await status(`${A} Zero-range condensation at criticality, Stoch. Process. Appl. 123, 3466–3496 (2013).`, false)).toBe('verified');
    });
  });
});

describe('adversarial: rank order and step 3b', () => {
  // The key order of pickBest, and step 3b's Crossref-only search.

  const run = async (text: string, world: WorkRecord[], openalexAll = false) => {
    const { deps } = worldDeps({ openalexAll, world });
    return checkReference(ref(1, text), deps, signal);
  };

  describe('key order: a corrupted citation is never Verified through the author rank', () => {
    const sibling = R({ title: 'Generative adversarial nets for sequence data', authors: ['goodfellow', 'pouget-abadie', 'mirza'], year: 2016 });
    const chapter = R({ title: 'Generative Adversarial Nets', authors: ['labaca castro'], year: 2023, venue: 'Machine Learning under Malware Attack' });
    test.each([
      // wrong year
      'Goodfellow, I., Pouget-Abadie, J., Mirza, M.: Generative adversarial nets. Advances in neural information processing systems 27 (2019)',
      // swapped title (another work's title, the cited authors)
      'Goodfellow, I., Pouget-Abadie, J., Mirza, M.: Deep residual learning for image recognition. In CVPR (2016)',
      // swapped authors (the title of a real paper, other authors' names)
      'He, K., Zhang, X., Ren, S.: Generative adversarial nets. Advances in neural information processing systems 27 (2014)',
      // a sibling's title, slightly altered
      'Goodfellow, I., Pouget-Abadie, J., Mirza, M.: Generative adversarial nets for sequences. Advances in neural information processing systems 29 (2016)',
    ])('not Verified: %s', async (text) => {
      for (const oa of [false, true]) expect(INVENTED).toContain((await run(text, [chapter, sibling, ...WORLD], oa)).status);
    });

    test('a correct citation keeps the exact record without authors over a sibling by the cited authors', async () => {
      const noAuthors = R({ source: 'openalex', title: 'Sparse mixture routing for long-context retrieval in multilingual corpora', authors: [], year: 2019, doi: '10.9999/smr' });
      const sib = R({ title: 'Sparse mixture routing for long-context retrieval', authors: ['whitfield', 'okonkwo'], year: 2019, doi: '10.9999/sib' });
      const text = 'Whitfield, A., Okonkwo, R. (2019). Sparse mixture routing for long-context retrieval in multilingual corpora. In Proceedings of ICML, pages 1-9.';
      const r = await run(text, [...WORLD, noAuthors, sib], true);
      expect(r.status).not.toBe('not_found');
      expect(r.match?.doi).toBe('10.9999/smr');
    });
  });

  describe('copies only in OpenAlex', () => {
    test('two OpenAlex copies, one retracted, beside the arXiv record: not Verified, not an accusation', async () => {
      const arxivRec = R({ source: 'arxiv', title: 'Supersymmetric Flux Compactifications and Calabi-Yau Modularity', authors: ['kachru', 'nally', 'yang'], year: 2020, arxivId: '2001.06022' });
      const copyA = R({ source: 'openalex', title: 'Supersymmetric flux compactifications and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/a', venue: 'Communications in Number Theory and Physics', isRetracted: true });
      const { deps, sources } = worldDeps({ world: [...WORLD, arxivRec] });
      sources.openalex.search.mockImplementation(() => Promise.resolve([copyA, { ...copyA, doi: '10.4310/b', isRetracted: false }]));
      const r = await checkReference(ref(1, 'S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity, Commun. Num. Theor. Phys. 18 (2024) 653 [2001.06022].'), deps, signal);
      expect(['details_differ', 'cant_check']).toContain(r.status);
    });
    test('two Crossref copies, one retracted: Can\'t check', async () => {
      const arxivRec = R({ source: 'arxiv', title: 'Supersymmetric Flux Compactifications and Calabi-Yau Modularity', authors: ['kachru', 'nally', 'yang'], year: 2020, arxivId: '2001.06022' });
      const copyA = R({ title: 'Supersymmetric flux compactifications and Calabi-Yau modularity', authors: ['kachru', 'nally', 'yang'], year: 2024, doi: '10.4310/a', venue: 'Communications in Number Theory and Physics', isRetracted: true });
      const r = await run('S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity, Commun. Num. Theor. Phys. 18 (2024) 653 [2001.06022].', [...WORLD, arxivRec, copyA, { ...copyA, doi: '10.4310/b', isRetracted: false }]);
      expect(r.status).toBe('cant_check');
    });
  });
});

describe('adversarial: rank order among strong matches', () => {
  // Among strong matches, the key order puts the cited authors' record first even when a
  // copy without authors has the exact title and is retracted.
  test('a retracted exact-title copy without authors is not passed over for a near copy by the cited authors', async () => {
    const near = R({ title: 'Sparse mixture routing for long-context retrieval in multilingual text corpora', authors: ['whitfield', 'okonkwo'], year: 2019, doi: '10.9999/near' });
    const exact = R({ title: 'Sparse mixture routing for long-context retrieval in multilingual corpora', authors: [], year: 2019, doi: '10.9999/exact', isRetracted: true });
    const { deps } = worldDeps({ world: [...WORLD, near, exact] });
    const r = await checkReference(ref(1, 'Whitfield, A., Okonkwo, R. (2019). Sparse mixture routing for long-context retrieval in multilingual corpora. In Proceedings of ICML, pages 1-9.'), deps, signal);
    expect(r.status).not.toBe('verified');
  });
});

// Step 3b and the retraction lookup under failures.
describe('adversarial: step 3b with the outage watch', () => {
  // Where step 3b meets the outage watch, no-retry mode and early stop.

  const arxivRec = (i: number): WorkRecord => R({ source: 'arxiv', title: `Supersymmetric flux compactifications and Calabi-Yau modularity number ${i}`, authors: ['kachru', 'nally', 'yang'], year: 2020, arxivId: `2001.0602${i}` });
  const journal = (i: number, o: Partial<WorkRecord> = {}): WorkRecord => R({ title: `Supersymmetric flux compactifications and Calabi-Yau modularity number ${i}`, authors: ['kachru', 'nally', 'yang'], year: 2024, doi: `10.4310/j${i}`, ...o });
  const text = (i: number) => `S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity number ${i}, Commun. Num. Theor. Phys. 18 (2024) 653 [2001.0602${i}].`;
  const ACCUSE = ['not_found', 'wrong_id', 'retracted'];

  describe('step 3b under failures', () => {
    test('Crossref failing in step 3b: the arXiv record stays, no accusation, and nothing is cached', async () => {
      const sources = mockSources({ crossref: { search: () => Promise.reject(new SourceError('network', 'crossref', 'down')), lookupById: () => Promise.resolve(null) }, arxiv: { lookupById: () => Promise.resolve(arxivRec(1)) } });
      const deps = makeDeps(sources);
      const r = await checkReference(ref(1, text(1)), deps, signal);
      expect(ACCUSE).not.toContain(r.status);
      expect(r.status).toBe('details_differ');
      // A passing Crossref fault decided this row; a cached Details differ would outlive it.
      expect(deps.cache.sets.length).toBe(0);
    });

    test('a strong retracted journal version whose retraction lookup fails is not Verified', async () => {
      const sources = mockSources({ crossref: { search: () => Promise.resolve([journal(1, { isRetracted: true })]) }, arxiv: { lookupById: () => Promise.resolve(arxivRec(1)) } });
      const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.reject(new SourceError('network', 'crossref', 'down'))) } });
      const r = await checkReference(ref(1, text(1)), deps, signal);
      expect(r.status).not.toBe('verified');
    });

    test('a run where every source fails except the arXiv batch: no accusation, early stop honoured', async () => {
      const fail = () => Promise.reject(new SourceError('network', 'crossref', 'down'));
      const sources = mockSources(
        { crossref: { search: fail, lookupById: fail }, openalex: { search: fail, lookupById: fail }, openreview: { search: fail, lookupById: fail }, dblp: { search: fail, lookupById: fail }, arxiv: { search: fail, lookupById: fail } },
        (ids) => Promise.resolve(new Map(ids.map((id) => [id, arxivRec(Number(id.slice(-1)))]))),
      );
      const deps = makeDeps(sources);
      const results: CheckResult[] = [];
      const refs = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ref(i, text(i)));
      await runCheck({ paper: { title: 'p', url: 'https://arxiv.org/abs/2610.00001' } as never, refs, onResult: (x) => results.push(x), signal }, deps).catch(() => undefined);
      for (const x of results) expect(ACCUSE).not.toContain(x.status);
    });
  });

  describe('control: the same state reached by step 4', () => {
    test('a strong search match marked retracted, retraction lookup failing, no arXiv id: not Verified', async () => {
      const sources = mockSources({ crossref: { search: () => Promise.resolve([journal(1, { isRetracted: true })]) } });
      const deps = makeDeps(sources, { retraction: { check: vi.fn(() => Promise.reject(new SourceError('network', 'crossref', 'down'))) } });
      const r = await checkReference(ref(1, 'S. Kachru, R. Nally and W. Yang, Supersymmetric flux compactifications and Calabi-Yau modularity number 1, Commun. Num. Theor. Phys. 18 (2024) 653.'), deps, signal);
      expect(r.status).not.toBe('verified');
    });
  });
});

// A correct citation stays Verified when the record's venue is missing, a repository or in
// another language: a journal head ("Physica A", "Theory Probab.") is never moved into the title.
describe('adversarial: correct citations against records whose venue does not read as the cited one', () => {
  const xi = { title: 'How required reserve ratio affects distribution and velocity of money', authors: ['xi', 'ding', 'wang'], year: 2005 };
  const mk = { title: 'Local limit theorems for lattice random variables', authors: ['mukhin'], year: 1991 };
  const XI = 'Xi, N., Ding, N and Wang, Y., How required reserve ratio affects distribution and velocity of money. Physica A 357, 543–555 (2005).';
  const MK = 'Mukhin, A. B., Local limit theorems for lattice random variables. Theory Probab. Appl. 36, 698–713 (1991).';
  test.each<[string, string, WorkRecord]>([
    ['xi-crossref', XI, R({ ...xi, doi: '10.1016/x', venue: 'Physica A: Statistical Mechanics and its Applications' })],
    ['xi-arxiv', XI, R({ ...xi, source: 'arxiv', arxivId: 'physics/0507160' })],
    ['xi-openalex-repo', XI, R({ ...xi, source: 'openalex', venue: 'arXiv (Cornell University)', venues: ['arXiv (Cornell University)'] })],
    ['mk-crossref', MK, R({ ...mk, doi: '10.1137/x', venue: 'Theory of Probability and Its Applications' })],
    ['mk-novenue', MK, R({ ...mk, doi: '10.1137/x' })],
    ['mk-othervenue', MK, R({ ...mk, doi: '10.1137/x', venue: 'Teoriya Veroyatnostei i ee Primeneniya' })],
  ])('%s is Verified', async (_id, text, r) => {
    const { deps } = worldDeps({ openalexAll: r.source === 'openalex', world: [...WORLD, r] });
    expect((await checkReference(ref(1, text), deps, signal)).status).toBe('verified');
  });
});

// An added sentence before the journal is not Verified against each record venue; a tie
// between two readings of the venue goes to the later start, and joining words count as no match.
describe('adversarial: added sentences against each record venue', () => {
  const N = 'Grosskinsky, S., Schütz, G.M. and Spohn, H.,';
  const T = 'Condensation in the zero range process: stationary and dynamical properties';
  const base = { title: 'Condensation in the Zero Range Process: Stationary and Dynamical Properties', authors: ['grosskinsky', 'schutz', 'spohn'], year: 2003, volume: '113', pages: ['389'] };
  const rec3 = (venue: string | undefined): WorkRecord => R({ ...base, doi: '10.1023/x', ...(venue !== undefined && { venue, venues: [venue] }) });
  const statusIn = async (text: string, r: WorkRecord, oa: boolean): Promise<Status> => {
    const { deps } = worldDeps({ openalexAll: oa, world: [...WORLD, r] });
    return (await checkReference(ref(1, text), deps, signal)).status;
  };
  test.each<[string, string, string]>([
    ['nature-origins', `${N} ${T}. Nature Origins. Nature 113, 389–410 (2003).`, 'Nature'],
    ['science-adv', `${N} ${T}. Science Advances. Science 113, 389–410 (2003).`, 'Science'],
    ['science-adv2', `${N} ${T}. Science Policy. Science 113, 389–410 (2003).`, 'Science'],
    ['chaos-order', `${N} ${T}. Chaos Theory. Chaos 113, 389–410 (2003).`, 'Chaos: An Interdisciplinary Journal of Nonlinear Science'],
    ['entropy-b', `${N} ${T}. Entropy Bounds. Entropy 113, 389–410 (2003).`, 'Entropy'],
    ['jsp-journal-of', `${N} ${T}. Journal of Physics. J. Stat. Phys. 113, 389–410 (2003).`, 'Journal of Statistical Physics'],
    ['physA-stat', `${N} ${T}. Physica Stat. Physica A 113, 389–410 (2003).`, 'Physica A: Statistical Mechanics and its Applications'],
    ['prl-review-letters', `${N} ${T}. Review Letters on Physics. Phys. Rev. Lett. 113, 389–410 (2003).`, 'Physical Review Letters'],
    ['prl-physics-letters', `${N} ${T}. Physics Letters. Phys. Rev. Lett. 113, 389–410 (2003).`, 'Physical Review Letters'],
    ['prl-phys-origins', `${N} ${T}. Phys. Origins. Phys. Rev. Lett. 113, 389–410 (2003).`, 'Physical Review Letters'],
    ['prl-physical-review', `${N} ${T}. Physical Review. Phys. Rev. Lett. 113, 389–410 (2003).`, 'Physical Review Letters'],
    ['jsp-stat-models', `${N} ${T}. Stat. Models. J. Stat. Phys. 113, 389–410 (2003).`, 'Journal of Statistical Physics'],
    ['jsp-journal-club', `${N} ${T}. Journal Club. J. Stat. Phys. 113, 389–410 (2003).`, 'Journal of Statistical Physics'],
    ['jsp-statistical', `${N} ${T}. Statistical Physics. J. Stat. Phys. 113, 389–410 (2003).`, 'Journal of Statistical Physics'],
    ['jsp-models', `${N} ${T}. Models. J. Stat. Phys. 113, 389–410 (2003).`, 'Journal of Statistical Physics'],
  ])('%s is not Verified', async (_id, text, venue) => {
    for (const oa of [false, true]) expect(INVENTED).toContain(await statusIn(text, rec3(venue), oa));
  });
  test.each<[string, string | undefined]>([
    ['real-jsp', 'Journal of Statistical Physics'],
    ['real-novenue', undefined],
  ])('%s is Verified', async (_id, venue) => {
    for (const oa of [false, true]) expect(await statusIn(`${N} ${T}. J. Stat. Phys. 113, 389–410 (2003).`, rec3(venue), oa)).toBe('verified');
  });
  // A record with no venue (an arXiv record) has nothing to read the journal against: a one-word sentence written like an
  // abbreviation, or a journal's opening word and one, before a name that is a journal on its own is still seen.
  test.each<[string, string]>([
    ['novenue-models', `${N} ${T}. Models. J. Stat. Phys. 113, 389–410 (2003).`],
    ['novenue-bounds', `${N} ${T}. Bounds. J. Stat. Phys. 113, 389–410 (2003).`],
    ['novenue-probability-bounds', `${N} ${T}. Probability Bounds. J. Stat. Phys. 113, 389–410 (2003).`],
    ['novenue-physical-origins', `${N} ${T}. Physical Origins. Phys. Rev. Lett. 113, 389–410 (2003).`],
  ])('%s is not Verified', async (_id, text) => {
    for (const oa of [false, true]) expect(INVENTED).toContain(await statusIn(text, rec3(undefined), oa));
  });
  test.each([['Phys. Rev.'], ['Ann. Stat.'], ['Electron. J. Probab.'], ['Theory Probab. Appl.']])('a real "%s" against a record with no venue is Verified', async (journal) => {
    for (const oa of [false, true]) expect(await statusIn(`${N} ${T}. ${journal} 113, 389–410 (2003).`, rec3(undefined), oa)).toBe('verified');
  });
});

// A result shaped by a required source that failed is not stored in the lookup cache.
describe('adversarial: no caching after a failed required source', () => {
  test('a Verified search match while OpenReview failed is not cached; the same with every source answering is', async () => {
    const rec5 = R({ title: 'Attention Is All You Need', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017, doi: '10.5555/x' });
    const text = 'Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need. In NeurIPS.';
    const failing = makeDeps(mockSources({ crossref: { search: () => Promise.resolve([]) }, arxiv: { search: () => Promise.resolve([]) }, openreview: { search: () => Promise.reject(new SourceError('network', 'openreview', 'down')) }, openalex: { search: () => Promise.resolve([rec5]) } }));
    expect((await checkReference(ref(1, text), failing, signal)).status).toBe('verified');
    expect(failing.cache.sets.length).toBe(0);
    const answering = makeDeps(mockSources({ crossref: { search: () => Promise.resolve([]) }, arxiv: { search: () => Promise.resolve([]) }, openreview: { search: () => Promise.resolve([]) }, openalex: { search: () => Promise.resolve([rec5]) } }));
    expect((await checkReference(ref(1, text), answering, signal)).status).toBe('verified');
    expect(answering.cache.sets.length).toBe(1);
  });
});

// A title-less "et al." citation whose first Crossref answers miss it gets one
// more request, here the DOI APS builds from the locator. That DOI is only a candidate: a fabricated or altered citation
// whose built DOI names another article (or none) must not come out Verified, and nothing on this path accuses.
describe('adversarial: a DOI built from a title-less locator', () => {
  const work = (doi: string, family: string, volume: string, articleNumber: string, year: number) => ({ DOI: doi, title: ['An article in Physical Review D'], author: [{ family, given: 'P.' }, { family: 'Babusci', given: 'D.' }], issued: { 'date-parts': [[year]] }, 'container-title': ['Physical Review D'], 'short-container-title': ['Phys. Rev. D'], volume, 'article-number': articleNumber });
  // What Crossref holds, by DOI; the first search answers with an erratum of the same volume only.
  const BY_DOI: Record<string, unknown> = {
    '10.1103/physrevd.82.022003': work('10.1103/PhysRevD.82.022003', 'Astone', '82', '022003', 2010),
    '10.1103/physrevd.82.022004': work('10.1103/PhysRevD.82.022004', 'Doe', '82', '022004', 2010),
  };
  const ERRATUM = { DOI: '10.1103/PhysRevD.82.029901', title: ['Erratum: Another article'], author: [{ family: 'Roe', given: 'J.' }], issued: { 'date-parts': [[2010]] }, 'container-title': ['Physical Review D'], volume: '82', 'article-number': '029901' };
  let requested: URL[];

  const json = (url: string, status: number, body: unknown): Response => {
    const r = new Response(status === 200 ? JSON.stringify(body) : null, { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(r, 'url', { value: url });
    return r;
  };
  beforeEach(() => {
    freshNetwork();
    requested = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        const url = new URL(String(input));
        requested.push(url);
        if (url.pathname === '/works') return Promise.resolve(json(url.href, 200, { message: { items: [ERRATUM] } }));
        const doi = decodeURIComponent(url.pathname.replace(/^\/works\//, '')).toLowerCase();
        const found = BY_DOI[doi];
        return Promise.resolve(found === undefined ? json(url.href, 404, null) : json(url.href, 200, { message: found }));
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const statusOfLocator = async (text: string): Promise<Status> => {
    const sources = mockSources();
    const deps = makeDeps({ ...sources, crossref: crossref as unknown as typeof sources.crossref });
    const p = checkReference(ref(24, text), deps, signal);
    let settled = false;
    void p.finally(() => (settled = true)).catch(() => undefined);
    for (let i = 0; i < 100 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
    return (await p).status;
  };

  test('the real reference is Verified, with two Crossref requests and nothing else', async () => {
    expect(await statusOfLocator('P. Astone et al., Phys. Rev. D 82, 022003 (2010).')).toBe('verified');
    expect(requested.map((u) => u.pathname)).toEqual(['/works', '/works/10.1103/PhysRevD.82.022003']);
    expect(new Set(requested.map((u) => u.origin))).toEqual(new Set(['https://api.crossref.org']));
  });

  test.each([
    // another first author: the built DOI names the real article, whose authors do not include him
    'J. Smith et al., Phys. Rev. D 82, 022003 (2010).',
    // an altered year
    'P. Astone et al., Phys. Rev. D 82, 022003 (2013).',
    // an altered page: the built DOI names another article
    'P. Astone et al., Phys. Rev. D 82, 022004 (2010).',
    // an altered volume or journal: the built DOI names nothing Crossref holds
    'P. Astone et al., Phys. Rev. D 83, 022003 (2011).',
    'P. Astone et al., Phys. Rev. Lett. 82, 022003 (2010).',
  ])('a fabricated or altered citation is Can’t check, never Verified nor an accusation: %s', async (text) => {
    expect(await statusOfLocator(text)).toBe('cant_check');
  });
});

// A search result the cited title says nothing about is no match: an organisation's name read as the title against a
// record titled after it, or a short title buried in a much longer one. The search goes on through every source, and
// the reference is judged as if nothing matched it, never Details differ against another work. A record that only adds
// a subtitle is still the match.
describe('adversarial: search results the cited title says nothing about', () => {
  const blocks = (text: string, parts: string[]) => ({ ...ref(20, text), blocks: parts });
  const SEC = blocks('U.S. Securities and Exchange Commission (2026). Tidal Trust V, post-effective amendment no. 44 to Form N-1A. SEC accession no. 0001999371-26-018439.', [
    'U.S. Securities and Exchange Commission (2026).',
    'Tidal Trust V, post-effective amendment no. 44 to Form N-1A.',
    'SEC accession no. 0001999371-26-018439.',
  ]);
  const SEC_ENTRY = R({ title: 'Securities and Exchange Commission', authors: [], venue: 'SpringerReference', doi: '10.1007/springerreference_2448' });
  const LECUN = blocks('Y. LeCun A path towards autonomous machine intelligence. OpenReview [Position paper] 0.9.2.', ['Y. LeCun', 'A path towards autonomous machine intelligence.', 'OpenReview [Position paper] 0.9.2.']);
  const LONGER = R({ source: 'arxiv', title: 'Introduction to Latent Variable Energy-Based Models: A Path Towards Autonomous Machine Intelligence', authors: ['dawid', 'lecun'], year: 2023, arxivId: '2306.02572' });

  test('an agency named as the author is never Details differ against an entry named after it', async () => {
    const sources = mockSources({ crossref: { search: () => Promise.resolve([SEC_ENTRY]) }, openalex: { search: () => Promise.resolve([{ ...SEC_ENTRY, source: 'openalex' as const }]) } });
    const r = await checkReference(SEC, makeDeps(sources), signal);
    expect(r.status).toBe('cant_check');
    expect(r.match).toBeUndefined();
  });

  test('a short title inside another work\'s longer title is never Details differ against it, and every source is searched', async () => {
    const sources = mockSources({ arxiv: { search: () => Promise.resolve([LONGER]) } });
    const r = await checkReference(LECUN, makeDeps(sources), signal);
    expect(r.status).toBe('cant_check');
    expect(r.match).toBeUndefined();
    expect(r.sourcesSearched).toEqual(expect.arrayContaining(['crossref', 'arxiv', 'openreview', 'openalex']));
  });

  test('the cited work in a later source is still found past the longer one', async () => {
    const own = R({ source: 'openalex', title: 'A Path Towards Autonomous Machine Intelligence', authors: ['lecun'], year: 2022 });
    const sources = mockSources({ arxiv: { search: () => Promise.resolve([LONGER]) }, openalex: { search: () => Promise.resolve([own]) } });
    const r = await checkReference(LECUN, makeDeps(sources), signal);
    expect(r.status).toBe('verified');
    expect(r.match?.title).toBe(own.title);
  });

  // The search had only the collaboration's name: the work's own record in every answer is not matched by it, and the
  // reference is Can't check, never Not found.
  test('a collaboration named as the author is Can\'t check, even with the work\'s record in every answer', async () => {
    const own = R({ title: 'Estimating the reproducibility of psychological science', authors: ['aarts', 'anderson'], year: 2015, venue: 'Science', volume: '349', pages: ['aac4716'], doi: '10.1126/science.aac4716' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([own]) }, openalex: { search: () => Promise.resolve([{ ...own, source: 'openalex' as const }]) } });
    const r = await checkReference(ref(21, 'Open Science Collaboration (2015). Estimating the reproducibility of psychological science. Science, 349(6251), aac4716.'), makeDeps(sources), signal);
    expect(r.status).toBe('cant_check');
  });

  test('a trial\'s research group named as the author is Can\'t check, even with the work\'s record in every answer', async () => {
    const own = R({ title: 'A Randomized Trial of Intensive versus Standard Blood-Pressure Control', authors: ['wright', 'williamson'], year: 2015, venue: 'New England Journal of Medicine', volume: '373', pages: ['2103'], doi: '10.1056/nejmoa1511939' });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([own]) }, openalex: { search: () => Promise.resolve([{ ...own, source: 'openalex' as const }]) } });
    const r = await checkReference(ref(23, 'SPRINT Research Group (2015). A randomized trial of intensive versus standard blood-pressure control. N Engl J Med, 373, 2103–2116.'), makeDeps(sources), signal);
    expect(r.status).toBe('cant_check');
  });

  // A record whose title carries a notice label before the work's own title is that work: never Not found for it.
  test('a record titled "RETRACTED ARTICLE: <cited title>" is not passed over as another work', async () => {
    const notice = R({ title: 'RETRACTED ARTICLE: Graph neural networks', authors: ['smith', 'lee'], year: 2019, venue: 'Neural Computing and Applications', isRetracted: true });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([notice]) }, openalex: { search: () => Promise.resolve([{ ...notice, source: 'openalex' as const }]) } });
    const r = await checkReference(ref(22, 'Smith, J., Lee, K. (2019). Graph neural networks. Neural Computing and Applications, 31, 1–10.'), makeDeps(sources), signal);
    expect(r.status).not.toBe('not_found');
    expect(r.status).not.toBe('verified');
  });

  test('a record that only adds a subtitle is still Verified', async () => {
    const withSubtitle = R({ title: 'Attention is all you need: transformers for sequence modelling', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017 });
    const sources = mockSources({ crossref: { search: () => Promise.resolve([withSubtitle]) } });
    const r = await checkReference(ref(1, 'Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need. In NeurIPS.'), makeDeps(sources), signal);
    expect(r.status).toBe('verified');
  });
});
