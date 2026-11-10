// Datasets, book chapters and working papers: real citations that no database lists the usual way, and invented ones
// dressed the same way that must keep their status.
import { describe, expect, test } from 'vitest';
import { classify } from '../../../src/core/classify';
import { parseCitation } from '../../../src/core/parseCitation';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, RawReference, WorkRecord } from '../../../src/core/types';

const ALL = [...REQUIRED_SOURCES];
const parse = (text: string, blocks?: string[]): ParsedCitation => parseCitation({ index: 1, label: '[1]', text, ...(blocks !== undefined && { blocks }) } satisfies RawReference);

describe('a DOI whose record is a dataset under another name (2610.27412#39)', () => {
  const NIMS = 'M. NIMS, Superconducting material database (supercon), 10.48505/nims.3739 (2022).';
  const dataset: WorkRecord = { source: 'openalex', title: 'MDR SuperCon Datasheet', authors: ['group'], year: 2022, venue: 'Materials Data Repository', doi: '10.48505/nims.3739', isRetracted: false, notes: [], nonPaper: true };

  test('is Can\'t check with a plain reason, never Wrong ID', () => {
    const v = classify({ citation: parse(NIMS), idResolvedTo: dataset, matchedVia: 'id', searched: ['crossref', 'openalex'], failed: [] });
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/dataset/i);
    expect(v.reason).not.toMatch(/different paper|fake|invented/i);
    expect(v.diffs).toEqual([]);
  });

  test('the same record as an article is still Wrong ID', () => {
    const article: WorkRecord = { ...dataset };
    delete article.nonPaper;
    expect(classify({ citation: parse(NIMS), idResolvedTo: article, matchedVia: 'id', searched: ['crossref', 'openalex'], failed: [] }).status).toBe('wrong_id');
  });

  // Adversarial: an invented journal paper on an article's DOI stays Wrong ID; on a dataset's DOI it is not accused of a
  // wrong identifier, but it is never Verified or Details differ either.
  const INVENTED = 'J. Smith and K. Jones, Deep learning predicts superconducting transition temperatures, Phys. Rev. B 99, 104512 (2019), doi:10.48505/nims.3739.';
  test('an invented journal paper on an article\'s DOI is Wrong ID', () => {
    const other: WorkRecord = { source: 'crossref', title: 'Magnetic order in layered cobalt oxides', authors: ['tanaka', 'sato'], year: 2019, doi: '10.48505/nims.3739', isRetracted: false, notes: [] };
    expect(classify({ citation: parse(INVENTED), idResolvedTo: other, matchedVia: 'id', searched: ALL, failed: [] }).status).toBe('wrong_id');
  });
  // The engine passes a dataset record as what the identifier resolved to only once the title search
  // found nothing. With a full journal locator and every source answered, that is Not found; otherwise Can't check.
  test('an invented journal paper on a dataset\'s DOI that nothing else matched is Not found, never Wrong ID', () => {
    const v = classify({ citation: parse(INVENTED), idResolvedTo: dataset, matchedVia: 'id', searched: ALL, failed: [] });
    expect(v.status).toBe('not_found');
  });
  test('the same with a source that could not answer is Can\'t check, with the dataset reason', () => {
    const v = classify({ citation: parse(INVENTED), idResolvedTo: dataset, matchedVia: 'id', searched: ALL, failed: ['arxiv'] });
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/dataset/i);
  });
  test('an invented paper on a dataset\'s DOI with no journal locator is Can\'t check', () => {
    const v = classify({ citation: parse('J. Smith and K. Jones, Deep learning predicts superconducting transition temperatures, 2019, doi:10.48505/nims.3739.'), idResolvedTo: dataset, matchedVia: 'id', searched: ALL, failed: [] });
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/dataset/i);
  });

  test('a dataset record whose title matches the citation is Verified', () => {
    const named: WorkRecord = { ...dataset, title: 'Superconducting material database (SuperCon)', authors: ['nims'] };
    expect(classify({ citation: parse(NIMS), match: named, matchedVia: 'id', searched: ['crossref', 'openalex'], failed: [] }).status).toBe('verified');
  });
});

// 2610.28357#9: D. V. Cross, "On judgments of magnitude", a chapter in Wegener (ed.), Social Attitudes and Psychophysical
// Measurement (1982). Crossref has the book, not the chapter. Cited "Title. In <Book>, pp. 73–88." with nothing else.
// Pages alone are no sign of a book (natbib cites PMLR and other proceedings the same way), so the rule needs editors
// or a publisher too, and the real reference, which has neither, is Not found.
describe('a chapter cited "Title. In <Book>, pp. 73–88." that nothing matched', () => {
  const TITLE = 'On judgments of magnitude';
  const chapter = (inPart: string, tail = 'pp. 73–88.'): ParsedCitation => {
    const blocks = ['D. V. Cross', `${TITLE}.`, inPart, ...(tail === '' ? [] : [tail])];
    const c = parse(blocks.join(' '), blocks);
    expect(c.title).toBe(TITLE);
    return c;
  };
  const verdict = (c: ParsedCitation) => classify({ citation: c, searched: ALL, failed: [] });

  test('the real reference, with pages and neither editors nor a publisher, is Not found', () => {
    expect(verdict(chapter('In Social Attitudes and Psychophysical Measurement,')).status).toBe('not_found');
  });

  test.each([
    ['editors "(Ed.)"', 'In R. D. Wegener (Ed.), Social Attitudes and Psychophysical Measurement,', 'pp. 73–88.'],
    ['editors "(eds.)"', 'In R. D. Wegener and J. Smith (eds.), Social Attitudes and Psychophysical Measurement,', 'pp. 73–88.'],
    ['editors "Eds."', 'In R. D. Wegener, Eds., Social Attitudes and Psychophysical Measurement,', 'pp. 73–88.'],
    ['"edited by"', 'In Social Attitudes and Psychophysical Measurement, edited by R. D. Wegener,', 'pp. 73–88.'],
    ['"ed. by"', 'In Social Attitudes and Psychophysical Measurement, ed. by R. D. Wegener,', 'pp. 73–88.'],
    ['a "Handbook" and a publisher', 'In Handbook of Social Attitudes and Psychophysical Measurement,', 'pp. 73–88. Hillsdale, NJ: Erlbaum, 1982.'],
    ['a "Companion" and a "Press"', 'In The Oxford Companion to Psychophysical Measurement,', 'pp. 73–88. Oxford University Press, 1982.'],
    ['an "Encyclopedia" and a "Verlag"', 'In Encyclopedia of Psychophysical Measurement,', 'pp. 73–88. Springer-Verlag, 1982.'],
    ['an "Encyclopaedia" and "Publishers"', 'In Encyclopaedia of Psychophysical Measurement,', 'pp. 73–88. Kluwer Academic Publishers, 1982.'],
    ['editors and a page', 'In R. D. Wegener (Ed.), Social Attitudes and Psychophysical Measurement,', 'p. 73.'],
  ])('the same chapter with %s is Can\'t check, as a chapter', (_what, inPart, tail) => {
    const v = verdict(chapter(inPart, tail));
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/chapter/);
  });

  test('a source that could not answer still says so', () => {
    expect(classify({ citation: chapter('In R. D. Wegener (Ed.), Social Attitudes and Psychophysical Measurement,'), searched: ALL, failed: ['openalex'] }).reason).toMatch(/OpenAlex/);
  });

  // Adversarial: an invented journal or proceedings paper does not escape Not found by adding "In".
  test.each([
    ['a journal word', 'In Journal of Experimental Psychology,'],
    ['a proceedings volume', 'In Proceedings of the Annual Meeting of the Psychonomic Society,'],
    ['a meeting', 'In Annual Meeting of the Psychonomic Society,'],
    ['a journal and volume', 'In Psychological Science 12,'],
    ['a journal from the list', 'In Neural Computation,'],
    ['a dotted journal abbreviation', 'In J. Exp. Psychol.,'],
    ['a conference acronym', 'In NeurIPS,'],
    ['"Advances in"', 'In Advances in Neural Information Processing Systems,'],
    ['a review', 'In Annual Review of Psychology,'],
    ['a book series', 'In Lecture Notes in Computer Science,'],
    ['a volume number', 'In Social Attitudes and Psychophysical Measurement, vol. 3,'],
  ])('a reference with %s after "In" stays Not found', (_what, inPart) => {
    expect(verdict(chapter(inPart)).status).toBe('not_found');
  });

  test.each([
    ['a journal word', 'In R. D. Wegener (Ed.), Journal of Experimental Psychology,'],
    ['a proceedings volume', 'In R. D. Wegener (Ed.), Proceedings of the Annual Meeting of the Psychonomic Society,'],
    ['a conference acronym', 'In R. D. Wegener (Ed.), NeurIPS,'],
    ['a book series', 'In R. D. Wegener (Ed.), Lecture Notes in Computer Science,'],
    ['a volume number', 'In R. D. Wegener (Ed.), Social Attitudes and Psychophysical Measurement, vol. 3,'],
  ])('so does one with editors and %s', (_what, inPart) => {
    expect(verdict(chapter(inPart)).status).toBe('not_found');
  });

  test('"In <Book>" with neither pages nor editors stays Not found', () => {
    expect(verdict(chapter('In Social Attitudes and Psychophysical Measurement.', '')).status).toBe('not_found');
  });

  test('a page alone stays Not found', () => {
    expect(verdict(chapter('In Social Attitudes and Psychophysical Measurement,', 'p. 73.')).status).toBe('not_found');
  });

  // A publisher alone is how proceedings volumes published as books are cited too.
  test.each([
    ['a publisher\'s name', 'pp. 73–88. Hillsdale, NJ: Erlbaum, 1982.'],
    ['a "Press"', 'pp. 73–88. Academic Press, 1982.'],
    ['a "Verlag"', 'pp. 73–88. Springer-Verlag, 1982.'],
    ['"Publishers"', 'pp. 73–88. Kluwer Academic Publishers, 1982.'],
    ['"Publishing"', 'pp. 73–88. Springer International Publishing, 1982.'],
    ['another publisher\'s name', 'pp. 73–88. Routledge, 1982.'],
  ])('pages and %s, with no editors and no book word, stay Not found', (_what, tail) => {
    expect(verdict(chapter('In Social Attitudes and Psychophysical Measurement,', tail)).status).toBe('not_found');
  });

  test('a publisher with no pages and no editors stays Not found', () => {
    expect(verdict(chapter('In Social Attitudes and Psychophysical Measurement.', 'Erlbaum, 1982.')).status).toBe('not_found');
  });

  test('pages after a name with no "In" stay Not found', () => {
    expect(verdict(chapter('Social Attitudes and Psychophysical Measurement,')).status).toBe('not_found');
  });

  // Invented proceedings papers in natbib's "In <Meeting>, pp. N–M." shape, which names no venue word.
  test.each([
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Artificial Intelligence and Statistics, pp. 1273–1282. PMLR, 2017.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Uncertainty in Artificial Intelligence, pp. 367–377. PMLR, 2020.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Algorithmic Learning Theory, pp. 1–20. PMLR, 2019.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Learning for Dynamics and Control, pp. 1–12. PMLR, 2021.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Medical Imaging with Deep Learning, pp. 1–12, 2021.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Findings of the Association for Computational Linguistics, pp. 100–110, 2021.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In A. Singh and J. Zhu (eds.), Artificial Intelligence and Statistics, pp. 1273–1282. PMLR, 2017.',
    'J. Smith. Adaptive variational bounds for sparse Gaussian processes. In Machine Learning, pp. 1–20, 2019.',
    'J. Smith. Adaptive variational bounds for sparse Gaussian processes. In Operations Research, pp. 1–20, 2019.',
    'J. Smith. Adaptive variational bounds for sparse Gaussian processes. In Psychometrika, pp. 1–20, 2019.',
    'J. Smith. Adaptive variational bounds for sparse Gaussian processes. In Mathematics of Operations Research, pp. 1–20, 2019.',
    'J. Smith. Adaptive variational bounds for sparse Gaussian processes. In Mathematical Programming, pp. 1–20, 2019.',
    // Proceedings published as books, cited with their publisher or their editors.
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Algorithmic Learning Theory, pp. 1–20. Springer, 2010.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Learning Theory, pp. 1–20. Springer, 2006.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Computational Learning Theory, pp. 23–37. Springer-Verlag, 1995.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Uncertainty in Artificial Intelligence, pp. 367–377. AUAI Press, 2020.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Uncertainty in Artificial Intelligence, pp. 1–10. Morgan Kaufmann Publishers, 1999.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Medical Image Computing and Computer Assisted Intervention, pp. 234–241. Springer, 2015.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Machine Learning and Knowledge Discovery in Databases, pp. 1–16. Springer, 2019.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Theory of Cryptography, pp. 1–20. Springer, 2019.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Computer Aided Verification, pp. 1–20. Springer, 2019.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In Artificial Intelligence and Statistics (eds. A. Singh and J. Zhu), pp. 1273–1282, 2017.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In A. Singh (Ed.), Uncertainty in Artificial Intelligence, pp. 1–10, 2017.',
    'J. Smith and K. Jones. Adaptive variational bounds for sparse Gaussian processes. In J. Roe (Ed.), Findings of the Association for Computational Linguistics, pp. 1–10, 2021.',
  ])('an invented proceedings or journal paper stays Not found: %s', (text) => {
    expect(verdict(parse(text)).status).toBe('not_found');
  });
});

// 2610.28357#28: R. Haenni, "Ignoring ignorance is ignorant", a working paper of a university group (2003), in no database.
describe('a working paper that nothing matched', () => {
  const TITLE = 'Ignoring ignorance is ignorant';
  const paper = (series: string): ParsedCitation => {
    const blocks = ['R. Haenni', `${TITLE}.`, series];
    const c = parse(blocks.join(' '), blocks);
    expect(c.title).toBe(TITLE);
    return c;
  };
  const verdict = (c: ParsedCitation) => classify({ citation: c, searched: ALL, failed: [] });

  test('the real reference is Can\'t check, as a report', () => {
    const v = verdict(paper('Philosophy and Probability Working Paper 6.'));
    expect(v.status).toBe('cant_check');
    expect(v.reason).toBe("Looks like a technical report, which these databases don't list reliably");
  });

  test.each([
    'Philosophy and Probability Working Paper Series, No. 6.',
    'Konstanz Working Papers in Philosophy and Probability.',
    'Research Memorandum 2003/6.',
  ])('so is %s', (series) => {
    expect(verdict(paper(series)).status).toBe('cant_check');
  });

  // These series register a DOI with Crossref for every paper, so their silence counts.
  test.each([
    'NBER Working Paper 12345.',
    'NBER Working Paper No. 28411, 2021.',
    'National Bureau of Economic Research Working Paper 28411, 2021.',
    'CEPR Discussion Paper No. 4567.',
    'Centre for Economic Policy Research Discussion Paper 4567.',
    'Federal Reserve Bank of New York Staff Report 1234, 2019.',
    'Finance and Economics Discussion Series 2019-045, Board of Governors of the Federal Reserve System, 2019.',
    'FEDS Working Paper 2019-045.',
    'Fed Working Paper 2019-045.',
    'World Bank Policy Research Working Paper 9512, 2021.',
    'IMF Working Paper WP/21/45, 2021.',
    'International Monetary Fund Working Paper 21/45, 2021.',
    'IZA Discussion Paper No. 14012, 2021.',
    'BIS Working Paper No. 912, 2021.',
    'Bank for International Settlements Working Paper 912.',
    'ECB Working Paper Series No. 2512, 2021.',
    'European Central Bank Working Paper 2512.',
    // Other spellings of the same series.
    'Policy Research Working Paper 9512, 2021.',
    'FRB International Finance Discussion Papers 1234, 2021.',
    'FRBSF Working Paper 2021-01, 2021.',
    'Finance and Economics Discussion Series Working Paper 2019-045.',
    'N.B.E.R. Working Paper 28411, 2021.',
  ])('a working paper in a series registered with Crossref stays Not found: %s', (series) => {
    expect(verdict(paper(series)).status).toBe('not_found');
  });

  test('a source that could not answer still says so', () => {
    expect(classify({ citation: paper('Philosophy and Probability Working Paper 6.'), searched: ALL, failed: ['crossref'] }).reason).toMatch(/Crossref/);
  });

  // Adversarial: an invented journal paper whose journal says "Working Papers" still names a journal and its volume and
  // pages, and stays Not found.
  test.each([
    'Journal of Philosophy Working Papers 12(3), 45–67.',
    'Philosophy and Probability Working Paper 6, 45–67.',
    'Working Papers in Philosophy 12, 45–67.',
    'Economics Letters Working Paper 6.',
    'Review of Philosophy Working Paper 6.',
    'Philosophy and Probability Working Paper 6. Phil. Stud. 12, 45–67.',
  ])('%s stays Not found', (series) => {
    expect(verdict(paper(series)).status).toBe('not_found');
  });
});
