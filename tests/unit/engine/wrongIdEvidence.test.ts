import { describe, expect, test, vi } from 'vitest';

vi.mock('wxt/browser', async () => ({ browser: (await import('wxt/testing/fake-browser')).fakeBrowser }));
import type { WorkRecord } from '../../../src/core/types';
import { cacheKey } from '../../../src/engine/cache';
import { checkReference } from '../../../src/engine/checker';
import { effectiveCitation } from '../../../src/core/classify';
import { parseCitation } from '../../../src/core/parseCitation';
import { makeDeps, mockSources, record, ref } from '../helpers/engine';
import { SourceError } from '../../../src/sources/http';

// Wrong ID needs positive evidence, i.e. an author zone that names someone (a Latin-script
// surname-like word) and names none of the record's authors. An empty, unreadable or non-Latin zone is no
// evidence, so a far-off title there is Details differ. Leading labels ("1 ", "23 ", "1J.", "S1.", "A12.", "¹")
// are not part of the zone.

const controller = (): AbortSignal => new AbortController().signal;
const withRecord = (rec: WorkRecord, retracted = false) =>
  makeDeps(mockSources({ crossref: { lookupById: () => Promise.resolve(rec) } }), {
    retraction: { check: vi.fn(() => Promise.resolve(retracted ? { retracted: true, version: 'cited' as const } : { retracted: false })) },
  });
const status = async (text: string, rec: WorkRecord, retracted = false): Promise<string> => (await checkReference(ref(1, text), withRecord(rec, retracted), controller())).status;

const RISK = 'Risk factors for severe disease in hospitalised patients: cohort study';
const BMJ_DOI = '10.1136/bmj.m1';
const bmj = record({ title: RISK, authors: ['smith', 'jones', 'patel'], year: 2020, doi: BMJ_DOI });
const ID = '10.1000/abc';
const D = `doi:${ID}`;
const ketones = (authors = ['roe', 'smith']) => record({ title: 'Catalytic asymmetric hydrogenation of ketones', authors, year: 2020, doi: ID });
const zinc = (authors = ['kumar', 'singh'], year = 2020) => record({ title: 'Effects of dietary zinc on broiler chicken growth', authors, year, doi: ID });

describe('bare-number label styles (BMJ, Lancet, RSC) with the correct DOI', () => {
  test.each([
    `1 Smith J, Jones K, Patel A, et al. ${RISK}. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
    `23 Smith J, Jones K, Patel A, et al. ${RISK}. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
    `1 Smith J, Jones K, Patel A, et al. ${RISK}. Lancet 2020; 395: 1–10. https://doi.org/${BMJ_DOI}`,
    `1 Smith J, et al. ${RISK}. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
  ])('%s is Verified, and Retracted when the record is', async (text) => {
    expect(await status(text, bmj)).toBe('verified');
    expect(await status(text, bmj, true)).toBe('retracted');
  });

  test.each([
    `1 Smith J, Jones K, Patel A. Facteurs de risque de maladie grave chez les patients hospitalises. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
    `1 Smith J, Jones K, Patel A. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
    `7 Smith J, Jones K, Patel A. Correction: risk factors. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
    `¹ Smith J, Jones K, Patel A. Facteurs de risque de maladie grave chez les patients hospitalises. BMJ 2020;368:m1. doi:${BMJ_DOI}`,
  ])('%s is never Wrong ID', async (text) => {
    for (const retracted of [false, true]) expect(await status(text, bmj, retracted)).not.toBe('wrong_id');
  });

  test.each([`1 J. Roe and J. Smith, J. Am. Chem. Soc., 2020, 142, 1234. ${D}`, `12 J. Roe and J. Smith, Chem. Commun., 2020, 56, 1234. ${D}`, `1 Roe, J.; Smith, J. J. Am. Chem. Soc. 2020, 142, 1234. ${D}`])(
    '%s is never Wrong ID',
    async (text) => {
      for (const retracted of [false, true]) expect(await status(text, ketones(), retracted)).not.toBe('wrong_id');
    },
  );
});

describe('title-first and leading-title styles with the correct DOI and a reworded title', () => {
  const roe = record({ title: 'A theory of everything at small scales', authors: ['roe'], year: 2020, doi: ID });
  const he = record({ title: 'Deep residual learning for image recognition', authors: ['he', 'zhang', 'ren', 'sun'], year: 2016, doi: ID });
  const cjk = record({ title: 'Protein structure prediction with deep learning', authors: ['wang', 'li'], givenNames: ['xiaoming', 'hua'], year: 2020, doi: ID });
  test.each([
    [`"Une théorie générale aux petites échelles." Roe, J. Nature 2020. ${D}`, roe],
    [`Une théorie générale aux petites échelles. J. Roe. Nature 2020. ${D}`, roe],
    [`Roe J Une théorie générale aux petites échelles. Nature 2020. ${D}`, roe],
    [`ROE J Une théorie générale aux petites échelles. Nature 2020. ${D}`, roe],
    [`WANG X M, LI H. Prédiction de structure par apprentissage profond. 2020. ${D}`, cjk],
    [`He, Zhang, Ren and Sun: Apprentissage résiduel profond pour la reconnaissance visuelle. CVPR 2016. ${D}`, he],
    [`He and Zhang deep residual frameworks revisited for vision. CVPR 2016. ${D}`, he],
  ] as [string, WorkRecord][])('%s is Details differ', async (text, rec) => {
    expect(await status(text, rec)).toBe('details_differ');
  });
});

describe('corporate authors with the correct DOI', () => {
  test.each([
    [`IEEE Computer Society. Norme pour arithmétique flottante binaire. 2019. ${D}`, record({ title: 'IEEE standard for floating-point arithmetic', authors: ['ieee'], year: 2019, doi: ID })],
    [`Nature Publishing Group. Rapport du forum scientifique annuel. 2020. ${D}`, record({ title: 'Science forum report', authors: ['nature publishing group'], year: 2020, doi: ID })],
  ] as [string, WorkRecord][])('%s is never Wrong ID', async (text, rec) => {
    expect(await status(text, rec)).not.toBe('wrong_id');
  });
});

describe('native-script names with the correct DOI', () => {
  const cjk = record({ title: 'Protein structure prediction with deep learning', authors: ['wang', 'li'], givenNames: ['xiaoming', 'hua'], year: 2020, doi: ID });
  const kor = record({ title: 'Protein structure prediction with deep learning', authors: ['kim', 'lee'], givenNames: ['chulsoo', 'younghee'], year: 2020, doi: ID });
  test.each([
    [`王小明，李华。基于深度学习的蛋白质结构预测[J]. 计算机学报, 2020. ${D}`, cjk],
    [`김철수, 이영희. 딥러닝을 이용한 단백질 구조 예측 연구. 한국정보과학회논문지, 2020. ${D}`, kor],
    [`김철수, 이영희 (2020). 딥러닝을 이용한 단백질 구조 예측 연구. ${D}`, kor],
  ] as [string, WorkRecord][])('%s is Details differ', async (text, rec) => {
    expect(await status(text, rec)).toBe('details_differ');
  });
});

describe('labels before title-less identifier references behave as without the label', () => {
  const chemSci = `J. Roe and J. Smith, Chem. Sci., 2020, 11, 1234, ${D}.`;
  const green = `J. Roe, Green Chem., 2020, 22, 1, ${D}.`;
  test.each([
    ['1J. ', chemSci, ketones()],
    ['23 ', chemSci, ketones()],
    ['S1. ', chemSci, ketones()],
    ['A12. ', chemSci, ketones()],
    ['¹', chemSci, ketones()],
    ['5 ', green, ketones(['roe'])],
  ] as [string, string, WorkRecord][])('%j + %s: Verified, and Retracted when the record is', async (label, text, rec) => {
    expect(await status(`${label}${text}`, rec)).toBe('verified');
    expect(await status(`${label}${text}`, rec, true)).toBe('retracted');
  });

  test.each([
    ['1 ', `J. Roe and J. Smith, Phys. Rev. Lett. 98, 1 (2020). ${D}`],
    ['1J. ', `J. Roe and J. Smith, J. Chem. Phys. 98, 1 (2020). ${D}`],
    ['S1. ', `J. Roe and J. Smith, Nature 571, 95 (2020). ${D}`],
    ['1 ', `J. Roe and J. Smith, J. Am. Chem. Soc., 2020, 142, 1234. ${D}`],
    ['1 ', `Roe J, Smith J. Nature 2020;571:95. ${D}`],
  ])('%j + %s: the same status as without the label', async (label, text) => {
    for (const retracted of [false, true]) expect(await status(`${label}${text}`, ketones(), retracted)).toBe(await status(text, ketones(), retracted));
  });
});

describe('named authors against a record by other people stay Wrong ID', () => {
  test.each([
    `J. Roe and J. Smith. Sparse attention for video transformers at scale. Nature, 2020. ${D}`,
    `1 J. Roe and J. Smith. Sparse attention for video transformers at scale. Nature, 2020. ${D}`,
    `1 Smith J, Jones K, Patel A, et al. ${RISK}. BMJ 2020;368:m1. ${D}`,
    `23 Smith J, Jones K, Patel A. ${RISK}. BMJ 2020;368:m1. ${D}`,
    `S1. J. Roe, J. Smith. Sparse attention for video transformers at scale. Nature 2020. ${D}`,
  ])('%s', async (text) => {
    expect(await status(text, zinc())).toBe('wrong_id');
    expect(await status(text, zinc(), true)).toBe('wrong_id');
  });
});

describe('a quoted title with no names before it', () => {
  test('a quoted title with no author names before it is Details differ against an unrelated record (no evidence of a wrong identifier), never Retracted', async () => {
    const deps = withRecord(record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['kumar', 'singh'], year: 2019, doi: ID }), true);
    const r = await checkReference(ref(1, `"Graph neural networks for protein folding at scale." Nature Methods, 2019. ${D}`), deps, controller());
    expect(r.status).toBe('details_differ');
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });
});

describe('id-only references: retraction needs positive agreement unless the identifier is bare', () => {
  const UNCONFIRMED = "Couldn't confirm the identifier matches this reference";
  // Parsed with low confidence, so it is checked by the identifier alone; its names are in Hanzi, which the
  // record's romanised surnames cannot be compared with: nothing confirms the identifier.
  const hanzi = `王小明, 李华. 基于深度学习的蛋白质结构预测. 计算机学报, 2020, 43(1): 1-10. ${D}`;
  test('a Hanzi author list with a typo DOI that hits a retracted record of a compatible year is Can\'t check, no lookup', async () => {
    const deps = withRecord(zinc(['kumar', 'singh'], 2020), true);
    const r = await checkReference(ref(1, hanzi), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNCONFIRMED);
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('the same with the right record is neither Verified nor Retracted', async () => {
    const cjk = record({ title: 'Protein structure prediction with deep learning', authors: ['wang', 'li'], year: 2020, doi: ID });
    for (const retracted of [false, true]) {
      const r = await checkReference(ref(1, hanzi), withRecord(cjk, retracted), controller());
      expect(r.status).toBe('cant_check');
      expect(r.reason).toBe(UNCONFIRMED);
    }
  });

  test('a bare DOI of a retracted record is Retracted', async () => {
    expect(await status(D, zinc(['kumar']), true)).toBe('retracted');
  });

  test('names that agree confirm it: Retracted', async () => {
    // "J. Roe, Science 367 (2020)." without a page parses a name-and-venue "title" (the deferred physics-style
    // parser issue), so it is not id-only and stays Details differ; with the page it is id-only.
    expect(await status(`J. Roe, Science 367, 123 (2020). ${D}`, ketones(['roe']), true)).toBe('retracted');
  });

  test('a zone naming other people still contradicts it', async () => {
    const deps = withRecord(ketones(), true);
    const r = await checkReference(ref(1, `K. Lee and S. Park, Science 367, 123 (2020), ${D}.`), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe("The identifier points to a record that doesn't match the other details");
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });
});

describe('organisational authors are no evidence of a wrong identifier', () => {
  const arxivRecord = (title: string, authors: string[]) => record({ source: 'arxiv', title, authors, year: 2023, doi: undefined, arxivId: '2303.08774' });
  const byArxiv = (rec: WorkRecord) => makeDeps(mockSources({ arxiv: { lookupById: () => Promise.resolve(rec) } }));
  const gpt4 = arxivRecord('GPT-4 technical report', ['achiam', 'adler', 'agarwal']);
  test.each([
    ['OpenAI. GPT-4 technical report. arXiv:2303.08774', gpt4],
    ['OpenAI. Rapport technique sur le grand modèle de langage. arXiv:2303.08774', gpt4],
    ['Gemini Team, Google. Gemini: a family of highly capable multimodal models. arXiv:2303.08774', arxivRecord('Gemini: a family of highly capable multimodal models', ['anil', 'borgeaud', 'wu'])],
    ['Gemini Team, Google. Une famille de modèles multimodaux très performants. arXiv:2303.08774', arxivRecord('Gemini: a family of highly capable multimodal models', ['anil', 'borgeaud', 'wu'])],
    ['LLaMA Team, Meta AI. The Llama 3 herd of models. arXiv:2303.08774', arxivRecord('The Llama 3 herd of models', ['grattafiori', 'dubey', 'jauhri'])],
    ['LLaMA Team, Meta AI. La troupe de modèles de langage ouverts. arXiv:2303.08774', arxivRecord('The Llama 3 herd of models', ['grattafiori', 'dubey', 'jauhri'])],
  ] as [string, WorkRecord][])('%s is never Wrong ID', async (text, rec) => {
    expect((await checkReference(ref(1, text), byArxiv(rec), controller())).status).not.toBe('wrong_id');
  });

  test('a person named beside an organisation follows the normal rule: J. Roe and Google DeepMind, record by others, is Wrong ID', async () => {
    const other = arxivRecord('Effects of dietary zinc on broiler chicken growth', ['kumar', 'singh']);
    const r = await checkReference(ref(1, 'J. Roe and Google DeepMind. Sparse attention for video transformers at scale. arXiv:2303.08774'), byArxiv(other), controller());
    expect(r.status).toBe('wrong_id');
  });
});

describe('cache: the fingerprint of a title-less reference covers the whole author zone', () => {
  const A = `X. Wang, Science 367, 123 (2020). ${D}`;
  const B = `Y. Wang, Science 367, 123 (2020). ${D}`;
  const key = (text: string) => cacheKey(effectiveCitation(parseCitation(ref(1, text))));

  test('"X. Wang" and "Y. Wang" of the same DOI and year get different keys', () => {
    expect(key(A)).not.toBe(key(B));
    expect(key(A)).toBe(key(A));
  });

  test('the second is classified fresh, not answered from the first one\'s cached Retracted', async () => {
    const swapped = record({ title: 'Effects of dietary zinc on broiler chicken growth', authors: ['xiaoming'], givenNames: ['wang'], year: 2020, doi: ID });
    const deps = withRecord(swapped, true);
    expect((await checkReference(ref(1, A), deps, controller())).status).toBe('retracted');
    const second = await checkReference(ref(2, B), deps, controller());
    expect(second.status).toBe('cant_check');
    expect(deps.retraction.check).toHaveBeenCalledTimes(1);
  });
});

describe('cache: titled keys carry the zone fingerprint too', () => {
  const T = 'Sparse attention for video transformers at scale';
  const first = `J. Roe. ${T}. Nature, 2020. ${D}`;
  const second = `Li Roe. ${T}. Nature, 2020. ${D}`;
  const key = (text: string) => cacheKey(effectiveCitation(parseCitation(ref(1, text))));

  test('the same DOI, title, first surname and year under other names gets another key', () => {
    expect(key(first)).not.toBe(key(second));
  });

  test('the second citation is classified fresh, not given the first one\'s cached Wrong ID', async () => {
    const deps = withRecord(zinc(['li']));
    expect((await checkReference(ref(1, first), deps, controller())).status).toBe('wrong_id');
    expect((await checkReference(ref(2, second), deps, controller())).status).toBe('details_differ');
  });
});

describe('id-only confirmation is decided by the author zone, not by word count', () => {
  const UNCONFIRMED = "Couldn't confirm the identifier matches this reference";
  const ret = (authors = ['wang', 'zhao']) => zinc(authors, 2020);
  const hanzi = `王小明, 李华. 基于深度学习的蛋白质结构预测. 计算机学报, 2020, 43(1): 1-10. ${D}`;
  test.each([`Roe J. 2020. ${D}`, `J. Roe, ${D}`, `Roe 2020, ${D}`, `OpenAI. ${D}`, hanzi, `See ref. 4, ${D}`, `Ibid., ${D}`])(
    '%s against a retracted record by Wang and Zhao is Can\'t check, no retraction lookup',
    async (text) => {
      const deps = withRecord(ret(), true);
      const r = await checkReference(ref(1, text), deps, controller());
      expect(r.status).toBe('cant_check');
      expect(deps.retraction.check).not.toHaveBeenCalled();
    },
  );

  test.each([`Roe 2020, ${D}`, `OpenAI. ${D}`, hanzi, `Ibid., ${D}`])('%s (no person named) says it could not confirm the identifier', async (text) => {
    expect((await checkReference(ref(1, text), withRecord(ret(), true), controller())).reason).toBe(UNCONFIRMED);
  });

  test('parsed authors against an author-less retracted record are Can\'t check (unconfirmed)', async () => {
    const deps = withRecord(ret([]), true);
    const r = await checkReference(ref(1, `Roe J, Lee K. Nature 2020;571:95. ${D}`), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toBe(UNCONFIRMED);
    expect(deps.retraction.check).not.toHaveBeenCalled();
  });

  test('a bare DOI is Retracted', async () => {
    expect(await status(D, ret(), true)).toBe('retracted');
  });

  test('names that agree are Retracted', async () => {
    expect(await status(`Wang Y, Zhao L. 2020. ${D}`, ret(), true)).toBe('retracted');
  });
});

describe('title-first references whose title has a digit', () => {
  test.each([
    [`Tendances des annees 1990 du tabagisme adulte. J. Roe. Lancet 2020. ${D}`, '1990s trends in adult smoking prevalence'],
    [`Carence en B12 et cognition chez les personnes agees. J. Roe. BMJ 2020. ${D}`, 'B12 deficiency and cognition in older adults'],
  ])('%s with the correct DOI is Details differ', async (text, title) => {
    expect(await status(text, record({ title, authors: ['roe'], year: 2020, doi: ID }))).toBe('details_differ');
  });

  test('an author-first reference keeps its zone: a DOI of a paper by others is still Wrong ID', async () => {
    expect(await status(`J. Roe. Tendances des annees 1990 du tabagisme adulte. Lancet 2020. ${D}`, zinc())).toBe('wrong_id');
    // With no title at all (a journal citation) the identifier is left unconfirmed, never accused.
    expect(await status(`J. Roe and J. Smith, Nature 571, 95 (2020). ${D}`, zinc())).toBe('cant_check');
  });
});

// NIMS SuperCon's DataCite DOI. Crossref does not know it; OpenAlex lists it as a
// dataset collection named "MDR SuperCon Datasheet". Another name on a dataset is no sign of a wrong identifier.
describe('a DOI that leads to a dataset under another name', () => {
  const NIMS = 'M. NIMS, Superconducting material database (supercon), 10.48505/nims.3739 (2022).';
  const supercon: WorkRecord = { source: 'openalex', title: 'MDR SuperCon Datasheet', authors: ['group'], year: 2022, venue: 'Materials Data Repository', doi: '10.48505/nims.3739', isRetracted: false, notes: [], nonPaper: true };

  test('is Can\'t check, not Wrong ID, and is not remembered', async () => {
    const deps = makeDeps(mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) } }));
    const r = await checkReference({ ...ref(39, NIMS), blocks: [NIMS] }, deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/dataset/);
    expect(r.diffs).toEqual([]);
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('the same DOI on an article with another title is still Wrong ID', async () => {
    const article: WorkRecord = { ...supercon, source: 'crossref' };
    delete article.nonPaper;
    expect(await status(NIMS, article)).toBe('wrong_id');
  });

  // A dataset's DOI does not stop the title search. The reference is judged by its own title; when
  // nothing matches it, it is Can't check, or Not found when it gives a full journal locator and every source answered.
  const PAPER = 'J. Smith and K. Jones, Deep learning predicts superconducting transition temperatures, Phys. Rev. B 99, 104512 (2019), doi:10.48505/nims.3739.';
  const paperRecord = record({ title: 'Deep learning predicts superconducting transition temperatures', authors: ['smith', 'jones'], year: 2019, venue: 'Physical Review B', volume: '99', pages: ['104512'], doi: '10.1103/physrevb.99.104512' });
  const searchCalls = (sources: ReturnType<typeof mockSources>): number => [sources.crossref, sources.arxiv, sources.openreview, sources.dblp, sources.openalex].reduce((n, s) => n + s.search.mock.calls.length, 0);

  test('the NIMS reference is searched by its title, and is Can\'t check when nothing matches it', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) } });
    const r = await checkReference({ ...ref(39, NIMS), blocks: [NIMS] }, makeDeps(sources), controller());
    expect(searchCalls(sources)).toBeGreaterThan(0);
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/dataset/);
  });

  test('a real paper cited with a dataset\'s DOI is Verified by its title', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) }, crossref: { search: () => Promise.resolve([paperRecord]) } });
    const r = await checkReference(ref(1, PAPER), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
    expect(r.match?.doi).toBe('10.1103/physrevb.99.104512');
  });

  test('an arXiv id that matches, cited with a dataset\'s DOI, still counts', async () => {
    const preprint = record({ source: 'arxiv', title: 'Deep learning predicts superconducting transition temperatures', authors: ['smith', 'jones'], year: 2019, arxivId: '1901.00001' });
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) }, arxiv: { lookupById: () => Promise.resolve(preprint) } });
    const r = await checkReference(ref(1, PAPER.replace('doi:', 'arXiv:1901.00001, doi:')), makeDeps(sources), controller());
    expect(r.status).toBe('verified');
    expect(r.match?.source).toBe('arxiv');
  });

  test('a title search match that differs is judged as usual (Details differ), never Wrong ID', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) }, crossref: { search: () => Promise.resolve([{ ...paperRecord, year: 2015 }]) } });
    const r = await checkReference(ref(1, PAPER), makeDeps(sources), controller());
    expect(r.status).toBe('details_differ');
  });

  // Adversarial: an invented paper carrying a dataset's DOI is never Verified on it, and with a full journal locator it is
  // Not found as any invented journal paper is.
  test('an invented journal paper with a dataset\'s DOI is searched by its title and is Not found', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) } });
    const r = await checkReference(ref(1, 'J. Smith and K. Jones, Quantum annealing of invented heavy fermion lattices, Phys. Rev. B 99, 104512 (2019), doi:10.48505/nims.3739.'), makeDeps(sources), controller());
    expect(searchCalls(sources)).toBeGreaterThan(0);
    expect(r.status).toBe('not_found');
  });

  test('the same with a source that could not answer is Can\'t check, with the dataset reason', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) }, arxiv: { search: () => Promise.reject(new SourceError('unavailable', 'arxiv', 'down')) } });
    const r = await checkReference(ref(1, 'J. Smith and K. Jones, Quantum annealing of invented heavy fermion lattices, Phys. Rev. B 99, 104512 (2019), doi:10.48505/nims.3739.'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/dataset/);
  });

  // A bare DOI after "<word> <n> (<year>)" is no page of a journal locator.
  test.each([
    'M. NIMS, Superconducting material database (supercon), version 2 (2022), 10.48505/nims.3739.',
    'NIMS, Superconducting material database SuperCon, Release 3 (2022) 10.48505/nims.3739',
    'M. NIMS, Superconducting material database (supercon), version 2 (2022), https://doi.org/10.48505/nims.3739.',
  ])('a dataset citation whose DOI follows "<word> <n> (<year>)" is Can\'t check: %s', async (text) => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) } });
    const r = await checkReference(ref(1, text), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/dataset/);
  });

  // When the only identifier led to a dataset, the titled locator lookup runs as with no identifier.
  function withLocator(again: WorkRecord[] | Error) {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) } });
    const searchLocatorAgain = vi.fn((): Promise<WorkRecord[]> => (again instanceof Error ? Promise.reject(again) : Promise.resolve(again)));
    Object.assign(sources.crossref, { searchLocator: vi.fn(() => Promise.resolve([])), searchLocatorAgain });
    return { sources, searchLocatorAgain, deps: makeDeps(sources) };
  }

  test('a real paper with a dataset\'s DOI that the title searches miss is Verified by its locator', async () => {
    const { searchLocatorAgain, deps } = withLocator([paperRecord]);
    const r = await checkReference(ref(1, PAPER), deps, controller());
    expect(searchLocatorAgain).toHaveBeenCalledTimes(1);
    const asked = searchLocatorAgain.mock.calls[0] as unknown as [{ raw: string; doi?: string }];
    expect(asked[0].doi).toBeUndefined();
    expect(asked[0].raw).not.toMatch(/nims/);
    expect(r.status).toBe('verified');
  });

  test('an invented title on that locator stays Not found', async () => {
    const { deps } = withLocator([paperRecord]);
    const r = await checkReference(ref(1, 'J. Smith and K. Jones, Quantum annealing of invented heavy fermion lattices, Phys. Rev. B 99, 104512 (2019), doi:10.48505/nims.3739.'), deps, controller());
    expect(r.status).toBe('not_found');
  });

  test('a failed locator request leaves it Can\'t check, with the dataset reason', async () => {
    const { deps } = withLocator(new SourceError('unavailable', 'crossref', 'down'));
    const r = await checkReference(ref(1, PAPER), deps, controller());
    expect(r.status).toBe('cant_check');
    expect(r.reason).toMatch(/dataset/);
    expect(deps.cache.sets).toHaveLength(0);
  });

  test('a DOI of an article (not a dataset) still gets no locator lookup', async () => {
    const { searchLocatorAgain, deps } = withLocator([paperRecord]);
    Object.assign(deps.sources.openalex, { lookupById: vi.fn(() => Promise.resolve(null)) });
    await checkReference(ref(1, PAPER), deps, controller());
    expect(searchLocatorAgain).not.toHaveBeenCalled();
  });

  test('an invented paper with a dataset\'s DOI and no journal locator is Can\'t check, never Wrong ID or Not found', async () => {
    const sources = mockSources({ openalex: { lookupById: () => Promise.resolve(supercon) } });
    const r = await checkReference(ref(1, 'J. Smith and K. Jones, Quantum annealing of invented heavy fermion lattices, 2019, doi:10.48505/nims.3739.'), makeDeps(sources), controller());
    expect(r.status).toBe('cant_check');
  });
});
