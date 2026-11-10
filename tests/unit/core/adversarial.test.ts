// Attacks on the matching rules (the engine-level suite is tests/unit/engine/adversarial.test.ts): what the re-read may take out of a title, which venues a reference names,
// and which titles are the same title.
import { describe, expect, test } from 'vitest';
import { classify, comparedWith, hasImplausibleAuthors, isCredibleTitle, pickBest, scoreCandidate } from '../../../src/core/classify';
import { resplitWithRecord, withTitleTail } from '../../../src/core/reread';
import { citedTitleSimilarity, dropsShortSubtitle, normalizeTitle, titleSimilarity } from '../../../src/core/normalize';
import { parseCitation } from '../../../src/core/parseCitation';
import { REQUIRED_SOURCES } from '../../../src/core/types';
import type { ParsedCitation, WorkRecord } from '../../../src/core/types';
import { VERIFIED_TITLE } from '../../../src/core/thresholds';
import { hasPreprintVersion } from '../../../src/core/years';

const parse = (text: string): ParsedCitation => parseCitation({ index: 1, label: '[1]', text });
const rec = (o: Partial<WorkRecord> & { title: string; authors: string[] }): WorkRecord => ({ source: 'crossref', isRetracted: false, notes: [], ...o });
const ganor = rec({ title: 'Small E(8) instantons and tensionless noncritical strings', authors: ['ganor', 'hanany'], year: 1996 });
const G = 'O.J. Ganor and A. Hanany, Small E(8) instantons and tensionless noncritical strings';

describe('the re-read takes a venue fragment off a title only when it reads as one', () => {
  test('"Nucl" before ". Phys. B" is a venue fragment', () => {
    const out = resplitWithRecord(parse(`${G}, Nucl. Phys. B 474 (1996) 122.`), ganor);
    expect(out.authors).toEqual(['ganor', 'hanany']);
    expect(titleSimilarity(out.title ?? '', ganor.title)).toBe(1);
  });

  test.each([
    'a review',
    'revisited',
    'with fluxes',
    'Part II',
    'II',
    'Erratum',
    'Reply',
    'Two loops',
    'three loops',
    'at large N',
  ])('"%s" before the venue stays in the title', (tail) => {
    const c = parse(`${G}, ${tail}, Nucl. Phys. B 474 (1996) 122.`);
    const out = comparedWith(c, ganor);
    expect(titleSimilarity(out.title ?? '', ganor.title)).toBeLessThan(0.9);
  });

  test.each(['Part II', 'II', 'Two loop corrections', 'Erratum'])('"%s" cut off at a full stop is kept with the title', (tail) => {
    const c = parse(`${G}. ${tail}, Nucl. Phys. B 474 (1996) 122.`);
    expect(titleSimilarity(comparedWith(c, ganor).title ?? '', ganor.title)).toBeLessThan(0.9);
  });

  test('a fragment that does not run into the venue the parser read is not taken off', () => {
    const c: ParsedCitation = { raw: `${G}, Nucl, and more. Phys. B 474 (1996) 122.`, title: `${G}, Nucl`, venue: 'Phys. B 474 (1996) 122', authors: [], year: 1996, kind: 'paper', confidence: 0.6 };
    expect(resplitWithRecord(c, ganor)).toBe(c);
  });

  test('"Part 2" after a title is not a volume', () => {
    const c: ParsedCitation = { raw: 'r', title: 'Methods of information geometry, part 2', authors: ['amari', 'nagaoka'], year: 2007, kind: 'paper', confidence: 0.9 };
    expect(resplitWithRecord(c, rec({ title: 'Methods of Information Geometry', authors: ['amari', 'nagaoka'], year: 2007 }))).toBe(c);
  });
});

describe('words cut off after a title stay with it when they read as more of it', () => {
  test.each([
    ['Vaswani, A., et al. (2017). Attention is all you need. A survey of graph applications. In NeurIPS.', 'A survey of graph applications'],
    ['A. Vaswani, N. Shazeer, and N. Parmar. Attention is all you need. Part II. Nucl. Phys. B 3, 1 (2017).', 'Part II'],
    ['A.J. Wakefield, S.H. Murch and A. Anthony. Ileal-lymphoid-nodular hyperplasia. Erratum, Lancet 351 (1998) 637.', 'Erratum'],
  ])('%s', (text, tail) => {
    expect(withTitleTail(parse(text)).title).toMatch(new RegExp(`${tail}$`));
  });

  test.each([
    'Silver, D., et al. (2017). Mastering the game of go without human knowledge. nature, 550(7676):354–359.',
    'Hochreiter, S., Schmidhuber, J. (1997). Long short-term memory. Neural computation, 9(8):1735–1780.',
    'Radford, A., et al. (2019). Language models are unsupervised multitask learners. OpenAI blog, 1(8):9.',
    'Kingma, D. P., Ba, J. (2015). Adam: A method for stochastic optimization. Published as a conference paper at ICLR 2015.',
    'Marcus, G. (2018). Deep learning. A critical appraisal. arXiv preprint arXiv:1801.00631.',
    'Roe, J. (2010). A study of things. Erratum in: Lancet 2011;377:1.',
    'Roe, J. (2010). A study of things. Erratum: Phys. Rev. D 51, 2 (1995).',
    'Roe, J. (2010). A study of things. Technical report, University of Toronto.',
    'Roe, J. (2010). A study of things. PhD thesis, Stanford University.',
    'Roe, J. (2010). A study of things. The annals of statistics, 29(5).',
    'Roe, J. (2010). A study of things. Journal of Machine Learning Research, 5.',
    'Roe, J. (2010). A study of things. In Proceedings of the Annual Meeting.',
    'Roe, J. (2010). A study of things. MIT press, 2016.',
    // real subtitles a journal's record may drop, and a book's title after a chapter's (from the eval corpus)
    'Wannier, G. H. Antiferromagnetism. The triangular Ising net. Phys. Rev. 79, 357- 364 (1950).',
    'G. Galloway, P. Miao, and R. Schoen, Initial data and the Einstein constraint equations. General relativity and gravitation, Cambridge Univ. Press, Cambridge, 2015, pp. 412–448.',
    'Ian Langmore, Michael Dikovsky. Hamiltonian Monte Carlo in inverse problems. Ill-Conditioning and multimodality. International Journal for Uncertainty Quantification, 13(1), 2023.',
  ])('a venue or a note is not part of the title: %s', (text) => {
    const c = parse(text);
    const tail = withTitleTail(c).title;
    // only a real subtitle the record also has may be kept ("A critical appraisal"); nothing else is added
    if (tail !== c.title) expect(tail).toMatch(/A critical appraisal$/);
  });

  test('a subtitle the record has still matches', () => {
    const c = parse('Marcus, G. (2018). Deep learning. A critical appraisal. arXiv preprint arXiv:1801.00631.');
    const r = rec({ source: 'arxiv', title: 'Deep Learning: A Critical Appraisal', authors: ['marcus'], year: 2018, arxivId: '1801.00631' });
    expect(classify({ citation: c, match: r, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [] }).status).toBe('verified');
  });
});

describe('a candidate is scored on the reference as the record reads it', () => {
  const nonCritical = rec({ source: 'arxiv', title: 'Small E(8) Instantons and Tensionless Non-critical Strings', authors: ['ganor', 'hanany'], year: 1996 });
  test('names in the title do not hide the record', () => {
    expect(scoreCandidate(parse(`${G}, Nucl. Phys. B 474 (1996) 122.`), nonCritical).title).toBe(1);
  });
  test('invented words do not reach the record', () => {
    expect(scoreCandidate(parse(`${G}, a review, Nucl. Phys. B 474 (1996) 122.`), nonCritical).title).toBeLessThan(0.9);
  });
  test.each(['O.J. Ganor and A. Hanany, Small E(8) instantons', 'A.Yu. Kitaev, Fault-tolerant quantum computation by anyons', 'A.M. Polyakov, Gauge fields and strings in two dimensions'])('initials run together make no credible title: %s', (title) => {
    expect(isCredibleTitle(title)).toBe(false);
  });
});

describe('a word and its negation are not the same title', () => {
  test.each([
    ['Small E(8) instantons and tensionless critical strings', 'Small E(8) instantons and tensionless noncritical strings'],
    ['Supervised learning of visual features', 'Unsupervised learning of visual features'],
    ['Convex optimization for sparse signals', 'Nonconvex optimization for sparse signals'],
  ])('%s', (a, b) => {
    expect(titleSimilarity(a, b)).toBeLessThan(0.9);
    expect(titleSimilarity(b, a)).toBeLessThan(0.9);
  });
  test('a hyphen or space after "non" is the same word', () => {
    expect(titleSimilarity('Small E8 instantons and tensionless non-critical strings', 'Small E(8) instantons and tensionless noncritical strings')).toBe(1);
    expect(titleSimilarity('Non linear dynamics of coupled oscillators', 'Nonlinear dynamics of coupled oscillators')).toBe(1);
  });
});

describe('an arXiv version is the record\'s, not the reference\'s', () => {
  test('a cited id alone does not show one', () => {
    expect(hasPreprintVersion(rec({ title: 't', authors: [] }))).toBe(false);
    expect(hasPreprintVersion(rec({ title: 't', authors: [], otherVersion: { arxivId: '1505.00001' } }))).toBe(true);
    expect(hasPreprintVersion(rec({ source: 'arxiv', title: 't', authors: [] }))).toBe(true);
  });
});

describe('the venue a reference names, when nothing matched it', () => {
  const nothing = (text: string): string => classify({ citation: parse(text), searched: [...REQUIRED_SOURCES], failed: [] }).status;
  const T = 'Whitfield, A., Okonkwo, R. (2021). Sparse mixture routing for long-context retrieval in multilingual corpora.';
  test.each([
    'ICCV, 2003.',
    'ICLR, 2024.',
    'In NeurIPS.',
    'Neural networks.',
    'Neuron, 2020.',
    'Empirical Software Engineering (EMSE).',
    'Qualitative Research in Psychology.',
    'J. Mach. Learn. Res.',
    'Nat Commun. 2021.',
  ])('%s is a venue', (venue) => {
    expect(nothing(`${T} ${venue}`)).toBe('not_found');
  });
  test('a meeting\'s abstracts are not a journal', () => {
    expect(nothing('Shailee Jain, Amanda LeBel, and Alexander Huth. Improving language encoding of fMRI responses with transformers. Annual Meeting of the Society for Neuroscience., 2019.')).toBe('cant_check');
  });
  test.each([
    'Google Research.',
    'OpenAI Blog.',
    'Microsoft Research Blog, 2021.',
    'The New York Times.',
    'DeepMind.',
    'White paper, Example Corp.',
    'Company announcement.',
    'U.S. Department of Energy.',
  ])('%s is not', (venue) => {
    expect(nothing(`${T} ${venue}`)).toBe('cant_check');
  });
  test('the acronym must come after the title, not inside the names or the title', () => {
    expect(nothing('A. Whitfield and R. Okonkwo. Sparse mixture routing for ICLR-style retrieval in multilingual corpora. 2021.')).toBe('cant_check');
  });
});

describe('a subtitle the citation adds is no match; one it drops still is', () => {
  test.each([': Part II', ': a follow-up', ': revisited', ': an erratum', ': a survey of graph applications', ' - a replication'])('"X%s" against "X" stays below Verified', (sub) => {
    expect(citedTitleSimilarity(`Attention is all you need${sub}`, 'Attention is all you need')).toBeLessThan(0.9);
  });
  test('the record\'s subtitle dropped by the citation scores as the plain title comparison does', () => {
    expect(citedTitleSimilarity('Attention is all you need', 'Attention is all you need: transformers for translation')).toBe(titleSimilarity('Attention is all you need', 'Attention is all you need: transformers for translation'));
    expect(citedTitleSimilarity('Attention is all you need', 'Attention is all you need: transformers for translation')).toBeGreaterThanOrEqual(0.9);
  });
  test('both with subtitles, or the record written with a full stop, are compared as plain titles', () => {
    expect(citedTitleSimilarity('Deep learning: a critical appraisal', 'Deep Learning: A Critical Appraisal')).toBe(1);
    expect(citedTitleSimilarity('Hamiltonian Monte Carlo in inverse problems: Ill-conditioning and multimodality', 'Hamiltonian Monte Carlo in inverse problems. Ill-Conditioning and multimodality')).toBeGreaterThanOrEqual(0.9);
  });
});

describe('a single invented word is not a venue fragment, and a sequel or survey is no subtitle to drop', () => {
  test.each(['QCD,', 'AdS.', 'Physics,', 'Revis.', 'Nature,'])('"%s" before "Nucl. Phys." stays in the title', (word) => {
    const c = parse(`${G}, ${word} Nucl. Phys. B 474 (1996) 122.`);
    expect(titleSimilarity(comparedWith(c, ganor).title ?? '', ganor.title)).toBeLessThan(0.9);
  });
  test('an acronym that names no venue before a journal stays with the title', () => {
    expect(withTitleTail(parse('J. Smith and A. Jones, Deep learning methods for graphs, GNN. J. Mach. Learn. Res. 3, 1 (2020).')).title).toMatch(/GNN$/);
    expect(withTitleTail(parse('J. Smith and A. Jones, Deep learning methods for graphs, IEEE Trans. Neural Netw. 3, 1 (2020).')).title).toBe('Deep learning methods for graphs');
  });
  // The American Chemical Society and the Royal Society of Chemistry open their journals' names ("ACS Appl. Mater.
  // Interfaces", "RSC Adv."), as IEEE does, and some PDFs print them with a full stop.
  test.each(['ACS. Appl. Mater. Inter.', 'RSC. Adv.'])('a publisher\'s acronym before a journal ("%s") is the journal\'s', (journal) => {
    expect(withTitleTail(parse(`J. Smith and A. Jones, Deep learning methods for graphs, ${journal} 3, 1 (2020).`)).title).toBe('Deep learning methods for graphs');
  });
  test.each([['Revisited.', 'Revisited'], ['A survey.', 'A survey']])('"%s" before a venue stays with the title', (words, tail) => {
    expect(withTitleTail(parse(`Vaswani, A., Shazeer, N. (2017). Attention is all you need. ${words} Nature 3, 1 (2017).`)).title).toMatch(new RegExp(`${tail}$`));
  });
  test.each(['Best paper award.', 'Code and models released.', 'Accepted.'])('a note "%s" is not', (note) => {
    const c = parse(`Vaswani, A., Shazeer, N. (2017). Attention is all you need. ${note} In NeurIPS.`);
    expect(withTitleTail(c).title).toBe(c.title);
  });
});

describe('a short main title cited without the record\'s subtitle', () => {
  test('is recognised for one or two words only', () => {
    expect(dropsShortSubtitle('MapReduce', 'MapReduce: simplified data processing on large clusters')).toBe(true);
    expect(dropsShortSubtitle('Deep Speech', 'Deep Speech: scaling up end-to-end speech recognition')).toBe(true);
    expect(dropsShortSubtitle('Attention is all you need', 'Attention is all you need: transformers')).toBe(false);
    expect(dropsShortSubtitle('MapReduce: a survey', 'MapReduce: simplified data processing on large clusters')).toBe(false);
    expect(dropsShortSubtitle('MapReduce', 'MapReduce')).toBe(false);
  });
  test('counts only with agreeing authors and year', () => {
    const r = rec({ title: 'MapReduce: simplified data processing on large clusters', authors: ['dean', 'ghemawat'], year: 2008 });
    const c = (o: Partial<ParsedCitation>): ParsedCitation => ({ raw: 'r', title: 'MapReduce', authors: ['dean', 'ghemawat'], year: 2008, kind: 'paper', confidence: 0.9, ...o });
    // 0.94: enough for Verified, not a strong match, unless volume and first page agree.
    expect(scoreCandidate(c({}), r).title).toBe(0.94);
    expect(scoreCandidate(c({ raw: 'Dean J, Ghemawat S. MapReduce. Commun ACM. 2008;51:107.' }), { ...r, volume: '51', pages: ['107'] }).title).toBe(0.95);
    expect(scoreCandidate(c({ authors: ['smith', 'doe'] }), r).title).toBeLessThan(0.9);
    expect(scoreCandidate(c({ year: 2015 }), r).title).toBeLessThan(0.9);
    expect(scoreCandidate(c({ year: undefined }), r).title).toBeLessThan(0.9);
  });
});

describe('dropped long subtitles and dotted given names', () => {
  // Dropped subtitles of three words or more still match; a dotted given name reads only where a name ends.
  test.each([
    ['The Matthew effect in science', 'The Matthew Effect in Science: The reward and communication systems of science are considered'],
    ['Form and content', 'Form and Content: Dissociating Syntax and Semantics in Sentence Comprehension'],
    ['The persona effect', 'The persona effect: affective impact of animated pedagogical agents'],
    ['Attention is all you need', 'Attention is all you need: a study'],
    ['Deep residual learning for image recognition', 'Deep Residual Learning for Image Recognition: Supplementary material'],
    ['Essential elements of communication in medical encounters', 'Essential Elements of Communication in Medical Encounters: The Kalamazoo Consensus Statement'],
    ['Mastering the game of Go', 'Mastering the game of Go: deep neural networks and tree search'],
  ])('"%s" against its record with a subtitle', (cited, record) => {
    expect(citedTitleSimilarity(cited, record)).toBeGreaterThanOrEqual(0.9);
  });
  test('a one-word main title is not the same title by similarity alone', () => {
    expect(citedTitleSimilarity('GloVe', 'GloVe: Global Vectors for Word Representation')).toBeLessThan(0.9);
  });
  test.each([
    ['Leonid. Chekhov and Nicolas Orantin, “Free energy topological expansion for the 2-matrix model,” JHEP 12 (2006) 053.', 'Free energy topological expansion for the 2-matrix model'],
    ['Maria. Garcia and John. Lee, “Graph neural networks for chemistry,” Nature 3 (2020) 1.', 'Graph neural networks for chemistry'],
    ['Victor. Rodriguez, “Lectures on gauge theory,” Phys. Rep. 3 (2020) 1.', 'Lectures on gauge theory'],
    ['Smith. Deep learning methods for graphs. Journal of Things 3 (2020) 1.', 'Deep learning methods for graphs'],
  ])('%s', (text, title) => {
    expect(parse(text).title).toBe(title);
  });
});

// Bottou's ICML 2015 keynote, cited as "Proceedings from 32nd International Conference on Machine Learning", is no
// paper to call Not found. A reference that says it is a talk, a keynote, a
// tutorial, slides or a presentation is Can't check whatever meeting it names; so is one that names only the
// "proceedings from" a meeting, with no page, volume or identifier. Proceedings papers keep their venue.
describe('a talk is not listed, whatever meeting it names', () => {
  const nothing = (text: string) => classify({ citation: parse(text), searched: [...REQUIRED_SOURCES], failed: [] });
  const T = 'Whitfield, A., Okonkwo, R. (2015). Two big challenges in sparse mixture routing.';

  test('the real reference (Bottou, ICML 2015 keynote) is Can\'t check', () => {
    const v = nothing('Bottou, L. (2015). Two big challenges in machine learning. Proceedings from 32nd International Conference on Machine Learning.');
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/^Not in Crossref, arXiv, OpenReview or OpenAlex, and it reads as a talk/);
  });

  test.each([
    'Invited talk, International Conference on Machine Learning (ICML), 2015.',
    'Keynote at the 32nd International Conference on Machine Learning, Lille, 2015.',
    'Talk at the Conference on Neural Information Processing Systems, 2015.',
    'NeurIPS 2015 tutorial.',
    'Slides from the 32nd International Conference on Machine Learning, 2015.',
    'Presentation at the Annual Meeting of the Association for Computational Linguistics, 2015.',
    'ICML 2015 keynote. https://leon.bottou.org/talks/2challenges',
  ])('%s', (tail) => {
    expect(nothing(`${T} ${tail}`).status).toBe('cant_check');
  });

  // A talk word that stands on its own names a talk even when the meeting's proceedings follow: a keynote or tutorial is
  // often cited with them. An invented paper cited exactly so, with no pages, is Can't check (accepted).
  test('a tutorial cited with the proceedings of its meeting, with no pages, is Can\'t check', () => {
    expect(nothing(`${T} Tutorial, In Proceedings of the 32nd International Conference on Machine Learning, 2015.`).status).toBe('cant_check');
  });

  test.each([
    'In Proceedings of the 32nd International Conference on Machine Learning, 2015.',
    // With pages, a "Proceedings of" volume after the title makes it a paper, whatever talk word is before it.
    'Tutorial, In Proceedings of the 32nd International Conference on Machine Learning, pages 1-9, 2015.',
    'In Proceedings of the 32nd ICML, pages 1-9, 2015.',
    'Proceedings of the 32nd International Conference on Machine Learning (2015).',
    'Proceedings from the 32nd International Conference on Machine Learning, pages 448-456, 2015.',
    'Proceedings from the 32nd International Conference on Machine Learning, PMLR 37, 2015.',
    'In ICML 2015. Oral presentation.',
    'In NeurIPS 2015 (spotlight presentation).',
  ])('a proceedings paper keeps its venue: %s', (tail) => {
    expect(nothing(`${T} ${tail}`).status).toBe('not_found');
  });

  test.each([
    'Whitfield, A., Okonkwo, R. (2015). Talk is cheap: sparse mixture routing for long-context retrieval. In Proceedings of the 32nd International Conference on Machine Learning, 2015.',
    'Whitfield, A., Okonkwo, R. (2015). A tutorial on sparse mixture routing for long-context retrieval. In ICML 2015.',
    'O. E. Olarte, J. Andilla, E. J. Gualda and P. Loza-Alvarez, Light-sheet microscopy: a tutorial, Advances in Optics and Photonics 10 (Mar, 2018) 111–179.',
    'Whitfield, A., Okonkwo, R. (2015). Keynote speakers and talk shows: presentation effects in sparse mixture routing. Proceedings of the 32nd International Conference on Machine Learning (2015).',
  ])('a talk word inside the title says nothing: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });
});

// The talk rule reads only the text after the title, behind the page and volume gate; an unknown macro without an
// argument keeps its name; controls for the lower-case name reading. Each test states the safe outcome.
describe('the talk rule, TeX macros and lower-case names', () => {
  /** Every required source searched, nothing matched. */
  const nothing = (text: string) => classify({ citation: parse(text), searched: [...REQUIRED_SOURCES], failed: [] });
  const FAB = 'Sparse mixture routing for long-context retrieval in multilingual corpora';
  // ---------------------------------------------------------------------------------------------------------------------
  // A talk word in a venue's name does not make the reference a talk: a fabricated paper in these venues stays Not found.
  describe('a journal or proceedings whose name holds a talk word is still a venue', () => {
    test.each([
      // IEEE Communications Surveys & Tutorials: a major journal (IF ~35), very often cited in networking/wireless papers.
      `A. Whitfield, R. Okonkwo, ${FAB}, IEEE Communications Surveys & Tutorials 22 (3) (2020) 1646-1685.`,
      `Whitfield A, Okonkwo R. ${FAB}. IEEE Communications Surveys and Tutorials. 2020;22(3):1646-85.`,
      `A. Whitfield and R. Okonkwo, "${FAB}," IEEE Commun. Surveys Tutorials, vol. 22, no. 3, pp. 1646-1685, 2020.`,
      // ACL/NAACL/EMNLP "Tutorial Abstracts" volumes are in the ACL Anthology and Crossref, with DOIs and pages.
      `Whitfield, A., Okonkwo, R. (2020). ${FAB}. In Proceedings of the 58th Annual Meeting of the Association for Computational Linguistics: Tutorial Abstracts, pages 1-7.`,
      // SIGGRAPH Talks: an ACM proceedings volume with DOIs.
      `Whitfield, A., Okonkwo, R. (2019). ${FAB}. In ACM SIGGRAPH 2019 Talks, pages 1-2.`,
    ])('fabricated paper, nothing matched, is Not found: %s', (text) => {
      expect(nothing(text).status).toBe('not_found');
    });
  });

  // The parsed title may not be a verbatim substring of the raw text (double space, a line break, a hyphen split across
  // lines, a title cut at a full stop); a talk word in the title is still not outside it. These fabricated proceedings
  // and journal papers stay Not found.
  describe('a talk word inside the title is not "outside" it just because the raw text is spaced differently', () => {
    test.each([
      ['double space', 'A. Whitfield and R. Okonkwo. A tutorial on sparse mixture routing  for long-context retrieval. In Proceedings of ICML, pages 1-9, 2021.'],
      ['line break', 'A. Whitfield and R. Okonkwo. A tutorial on sparse mixture routing for long-context retrieval\nin multilingual corpora. In Proceedings of ICML, pages 1-9, 2021.'],
      ['hyphen across a line', 'A. Whitfield and R. Okonkwo. A tutorial on sparse mixture routing for long-con-\ntext retrieval. In Proceedings of ICML, pages 1-9, 2021.'],
      ['subtitle cut at a full stop', 'Whitfield, A., Okonkwo, R. (2021). Sparse mixture routing for long-context retrieval. A tutorial review. Journal of Machine Learning Research 22, 1-40.'],
      ['an author called Talk', `P. Talk and R. Okonkwo. ${FAB}. In Proceedings of ICML, pages 1-9, 2021.`],
    ])('%s: still Not found', (_name, text) => {
      expect(nothing(text).status).toBe('not_found');
    });
  });

  // With pages or a volume the reference is a paper in a proceedings volume, talk word or not (as for "Proceedings
  // from"). ICML 2020/2021 labelled orals "long talk"; "paper presentation" is a paper.
  describe('a talk word next to pages is a paper', () => {
    test.each([
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Paper presentation at ICML 2021, pages 1-9.`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In Proceedings of the 38th International Conference on Machine Learning, PMLR 139, pages 1-9 (long talk).`,
      // DESIGN says a spotlight is a paper; the exception list only covers "spotlight presentation".
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In Advances in Neural Information Processing Systems 34, pages 1-12, 2021 (spotlight talk).`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In ICLR 2021 Workshop on Neural Compression, contributed talk.`,
    ])('%s', (text) => {
      expect(nothing(text).status).toBe('not_found');
    });
  });

  // The cases the rule is meant for, and its intended limits.
  describe('the talk rule, intended behaviour (control)', () => {
    test.each([
      'Bottou, L. (2015). Two big challenges in machine learning. Proceedings from 32nd International Conference on Machine Learning.',
      'Bottou, L. (2015). Two big challenges in machine learning. Invited talk, ICML 2015.',
    ])('real talk is Can\'t check: %s', (text) => {
      expect(nothing(text).status).toBe('cant_check');
    });
    test.each([
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In NeurIPS 2021 (Oral Presentation).`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In Proceedings from the 38th International Conference on Machine Learning, Virtual, July 18-24, 2021.`,
      `A. Whitfield and R. Okonkwo, "A tutorial on sparse mixture routing for long-context retrieval," IEEE Trans. Signal Process., vol. 69, pp. 1-12, 2021.`,
    ])('fabricated paper is Not found: %s', (text) => {
      expect(nothing(text).status).toBe('not_found');
    });
    // PROCEEDINGS_FROM costs these (by design): an invented paper cited as "Proceedings from <meeting>" with no pages.
    test.each([
      `A. Whitfield and R. Okonkwo. ${FAB}. Proceedings from the International Conference on Machine Learning, 2021.`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Proceedings from ICML 2021.`,
    ])('by design Can\'t check (cost of PROCEEDINGS_FROM): %s', (text) => {
      expect(nothing(text).status).toBe('cant_check');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // A custom macro without an argument may be a word of the title (\NP, \PSPACE, \eps, \R, a method name); dropping
  // it would make two different titles score as the same.
  describe('a dropped no-argument macro must not make two different titles the same title', () => {
    test.each([
      ['\\PSPACE-hardness of learning sparse mixture routers', 'NP-hardness of learning sparse mixture routers'],
    ])('%s vs %s', (cited, record) => {
      expect(titleSimilarity(cited, record)).toBeLessThan(VERIFIED_TITLE);
    });
    test('a custom macro that is the only word naming the method is kept', () => {
      expect(normalizeTitle('\\NP-hardness of learning')).toContain('np');
    });
  });

  // Control: with an argument the macro is the argument, which is what a Unicode record folds to anyway.
  describe('TeX with an argument (control)', () => {
    test.each([
      ['$\\mathsf{PSPACE}$-hardness of learning sparse mixture routers', 'NP-hardness of learning sparse mixture routers'],
      ['$\\widetilde{O}(T^{-1})$ convergence to correlated equilibria in general-sum Markov games', '$\\widetilde{O}(T^{-1/2})$ convergence to Nash equilibria in zero-sum Markov games'],
    ])('%s vs %s is not the same title', (cited, record) => {
      expect(titleSimilarity(cited, record)).toBeLessThan(VERIFIED_TITLE);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // Controls for reading a lower-case name as a name.
  describe('lower-case name before a bracketed year (control)', () => {
    test('the title after the year is read as the title', () => {
      expect(parse(`A. Whitfield, noam okonkwo, L. Haverford (2021) ${FAB}. In ICML.`).title).toBe(FAB);
    });
    test('an invented title after a lower-case list is still Not found when nothing matches', () => {
      expect(nothing(`A. Whitfield, noam okonkwo, L. Haverford (2021) ${FAB}. In ICML.`).status).toBe('not_found');
    });
    test.each([
      // a lower-case title of three words before the year is absorbed as a "name"; the rest is no credible title
      'K. He, X. Zhang, S. Ren, deep residual learning (2016) In CVPR, pages 770-778.',
      'K. He, X. Zhang, S. Ren, deep residual learning (2016) Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition, pages 770-778.',
    ])('a misread never becomes Not found: %s', (text) => {
      expect(nothing(text).status).not.toBe('not_found');
    });
  });

  describe('the talk rule: pages, volumes and journal names', () => {
    test.each([
      `Whitfield, A., Okonkwo, R. (2020). ${FAB}. In Proceedings of the 58th Annual Meeting of the ACL: Tutorial Abstracts, 2020.`,
      `Whitfield, A., Okonkwo, R. (2019). ${FAB}. In ACM SIGGRAPH 2019 Talks.`,
      `Whitfield, A., Okonkwo, R. (2019). ${FAB}. In SIGGRAPH Talks, 2019.`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In ICML 2021 (contributed talk).`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In ICML 2021, long presentation.`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In ICML 2021, short talk.`,
    ])('a venue name or a paper designation without pages is no talk: %s', (text) => {
      expect(nothing(text).status).toBe('not_found');
    });
    test('a journal name with "Tutorials" and no pages is not read as a talk (whether the name is a known journal is the venue rule\'s call)', () => {
      expect(nothing(`Whitfield, A., Okonkwo, R. (2020). ${FAB}. IEEE Communications Surveys & Tutorials, 2020.`).reason).not.toMatch(/talk/);
    });
    test('an author called Talk, with no pages either, is no talk', () => {
      expect(nothing(`P. Talk and R. Okonkwo. ${FAB}. In Proceedings of ICML 2021.`).status).toBe('not_found');
    });
    test('a parsed title that is not in the raw text reads nothing as a talk', () => {
      const c = { ...parse(`A. Whitfield and R. Okonkwo. ${FAB}. Invited talk, ICML 2021.`), title: 'Sparse mixture routing for long context retrieval' };
      expect(classify({ citation: c, searched: [...REQUIRED_SOURCES], failed: [] }).status).toBe('not_found');
    });
    test('"Proceedings from Proceedings of" is a proceedings paper', () => {
      expect(nothing(`Whitfield, A., Okonkwo, R. (2017). ${FAB}. Proceedings from Proceedings of Computer Vision and Pattern Recognition (CVPR).`).status).toBe('not_found');
    });
  });
});

// The talk rule against real talks with other date forms and plural or capitalised talk words, and against invented
// papers whose title was cut short before a journal or a "Proceedings of" volume; a word macro written with braces.
describe('the talk rule on real talks and cut titles', () => {
  const nothing = (text: string) => classify({ citation: parse(text), searched: [...REQUIRED_SOURCES], failed: [] });
  const FAB = 'Sparse mixture routing for long-context retrieval in multilingual corpora';

  // Real talks, as people cite them, are Can't check.
  describe('real talks reach Can\'t check', () => {
    test.each([
      ['day-first date', 'Bottou, L. (2015). Two big challenges in machine learning. Keynote, 32nd International Conference on Machine Learning, Lille, 7 July 2015.'],
      ['date range', 'Bottou, L. (2015). Two big challenges in machine learning. Invited talk, ICML 2015, Lille, July 6-11.'],
      ['ISO date', 'Bottou, L. (2015). Two big challenges in machine learning. Invited talk at ICML, 2015-07-07.'],
      ['plural "talks"', 'Bottou, L. (2015). Two big challenges in machine learning. ICML invited talks, 2015.'],
      ['TED Talks', 'Robinson, K. (2006). Do schools kill creativity? TED Talks, 2006.'],
    ])('%s', (_name, text) => {
      expect(nothing(text).status).toBe('cant_check');
    });
  });

  test('a talk word before the title, set off by a colon, names a talk', () => {
    expect(nothing('Bottou, L. Invited talk: Two big challenges in machine learning. ICML 2015.').status).toBe('cant_check');
  });

  // Invented papers stay Not found.

  describe('invented papers stay Not found', () => {
    test.each([
      ['subtitle cut at a full stop, no pages', 'Whitfield, A., Okonkwo, R. (2021). Sparse mixture routing for long-context retrieval. A tutorial review. Journal of Machine Learning Research, 2021.'],
      ['title cut at a colon-less full stop, keynote word in the cut part', 'A. Whitfield and R. Okonkwo. Sparse mixture routing. Keynote speakers and long-context retrieval. In Proceedings of ICML, 2021.'],
      ['tutorial track of a proceedings', `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In Proceedings of the ICML 2021 Tutorial Track.`],
      ['venue holds "Presentation"', `Whitfield, A., Okonkwo, R. (2021). ${FAB}. Journal of Data Presentation and Visual Analytics, 2021.`],
    ])('%s', (_name, text) => {
      expect(nothing(text).status).toBe('not_found');
    });
  });

  // Controls.
  describe('talks and papers the rule already tells apart', () => {
    test.each([
      `A. Whitfield, R. Okonkwo, ${FAB}, IEEE Communications Surveys & Tutorials 22 (3) (2020) 1646-1685.`,
      'A. Whitfield and R. Okonkwo. A tutorial on sparse mixture routing for long-con-\ntext retrieval. In Proceedings of ICML, pages 1-9, 2021.',
      `P. Talk and R. Okonkwo. ${FAB}. In Proceedings of ICML, pages 1-9, 2021.`,
      `Whitfield, A., Okonkwo, R. (2021). ${FAB}. In NeurIPS 2021 (spotlight talk).`,
      'Lopez-Paz, D., Nishihara, R. (2017). Sparse mixture routing in images. Proceedings from Proceedings of Computer Vision and Pattern Recognition (CVPR).',
    ])('Not found: %s', (text) => {
      expect(nothing(text).status).toBe('not_found');
    });
    test('Bottou is Can\'t check', () => {
      expect(nothing('Bottou, L. (2015). Two big challenges in machine learning. Proceedings from 32nd International Conference on Machine Learning.').status).toBe('cant_check');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // TeX: a macro with a brace drops its name, also for words.
  describe('TeX: names kept', () => {
    test('\\NP keeps its name', () => {
      expect(titleSimilarity('\\PSPACE-hardness of learning sparse mixture routers', 'NP-hardness of learning sparse mixture routers')).toBeLessThan(0.9);
    });
    test.each([
      ['$O(\\log{n})$ rounds for sparse mixture routing', 'o log n rounds for sparse mixture routing'],
      ['$\\alpha{}$-divergences for sparse mixture routing', 'alpha divergences for sparse mixture routing'],
    ])('a word macro written with braces keeps its name (documented): %s', (title, folded) => {
      expect(normalizeTitle(title)).toBe(folded);
    });
  });
});

// A "Note:" field or a publisher is no venue, and
// legislation, a dataset or an agency's document that nothing matched is Can't check. An invented journal paper dressed the
// same way stays Not found.
describe('notes, publishers and documents are no venue', () => {
  const nothing = (text: string, blocks?: string[]) =>
    classify({ citation: parseCitation({ index: 1, label: '[1]', text, ...(blocks !== undefined && { blocks }) }), searched: [...REQUIRED_SOURCES], failed: [] });
  const COPERNICUS = ['E.U. Copernicus Marine Service Information', 'Global ocean waves reanalysis.', 'Copernicus Marine Service.', 'Note: Product ID: GLOBAL_MULTIYEAR_WAV_001_032; DATASET_ID: cmems_mod_glo_wav_my_0.2deg_PT3H-i'];
  const DIRECTIVE = ['European Union', 'Directive (EU) 2023/959 amending Directive 2003/87/EC establishing a system for greenhouse gas emission allowance trading within the Union.', 'Note: Official Journal of the European Union, L 130, 16 May 2023, pp. 134–202'];
  const OECD = ['OECD', 'Maritime transport CO {}_{2} emissions: methodology update.', 'Note: Methodological note for the 2025-Q1 release of the OECD maritime transport CO {}_{2} emissions database'];

  test.each([
    ['#14 Copernicus dataset', COPERNICUS],
    ['#16 EU directive', DIRECTIVE],
    ['#30 OECD methodology note', OECD],
  ])('the real reference (2610.01008 %s) is Can\'t check, with and without its blocks', (_name, blocks) => {
    const v = nothing(blocks.join(' '), blocks);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/^Not in Crossref, arXiv, OpenReview or OpenAlex, and /);
    expect(nothing(blocks.join(' ')).status).toBe('cant_check');
  });

  test.each([
    'Directive (EU) 2023/959 of the European Parliament and of the Council amending Directive 2003/87/EC. Official Journal of the European Union, L 130, 16.5.2023, p. 134–202.',
    'Regulation (EC) No 1907/2006 concerning the Registration, Evaluation, Authorisation and Restriction of Chemicals (REACH). OJ L 396, 30.12.2006, pp. 1–849.',
    'Council Directive 92/43/EEC on the conservation of natural habitats and of wild fauna and flora. OJ L 206, 22.7.1992, p. 7.',
    'Inflation Reduction Act of 2022. Pub. L. No. 117-169, 136 Stat. 1818.',
    'Clean Air Act Amendments of 1990. 42 U.S.C. § 7401 et seq.',
    'Copernicus Climate Change Service (2023). ERA5 hourly data on single levels from 1940 to present. Product ID: reanalysis-era5-single-levels.',
    'Copernicus Marine Service (2024). Global ocean waves reanalysis. Product ID GLOBAL_MULTIYEAR_WAV_001_032.',
  ])('legislation, a dataset or an agency\'s document is Can\'t check: %s', (text) => {
    const v = nothing(text);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/^Not in Crossref, arXiv, OpenReview or OpenAlex, and /);
  });

  test.each([
    [['IMO', '2023 IMO Strategy on Reduction of GHG Emissions from Ships.', 'Resolution MEPC.377(80), adopted 7 July 2023.']],
    [['OECD', 'Maritime transport CO2 emissions: methodology update.', 'Methodological note for the 2025-Q1 release.']],
    [['World Bank', 'State and trends of carbon pricing 2024.', 'Report No. 189209, Washington, DC.']],
  ])('an agency\'s document is Can\'t check: %j', (blocks) => {
    const v = nothing(blocks.join(' '), blocks);
    expect(v.status).toBe('cant_check');
    expect(v.reason).toMatch(/^Not in Crossref, arXiv, OpenReview or OpenAlex, and /);
  });

  test.each([
    // A journal and its volume before a note still name the venue.
    'A. Whitfield and R. Okonkwo. Carbon pricing and fleet speed in short-sea shipping. Journal of Maritime Economics 12 (3), pp. 45–67. Note: forthcoming',
    'A. Whitfield and R. Okonkwo (2021) Sparse mixture routing in larval zebrafish. Nature Communications 12, pp. 6578. Note: Data: Harvard Dataverse, https://doi.org/10.7910/DVN/POVJYS, CC0',
    // A legislative designation in a paper's title, a journal after it.
    'Whitfield, A. (2011). Directive 2003/87/EC and carbon leakage: evidence from shipping. Energy Policy 39, 1234–1240.',
    'Whitfield, A. (2013). The Official Journal of the European Union as a data source for policy research. Journal of European Public Policy 20, 1–19.',
    // A dataset paper in a journal, and a datasets track.
    'Whitfield, A. (2020). A global dataset of sparse mixture routes for ships. Scientific Data 7, 123.',
    'Whitfield, A., Okonkwo, R. (2021). A dataset of sparse mixture routes. In NeurIPS Datasets and Benchmarks Track.',
    'Whitfield, A., Okonkwo, R. (2021). A dataset of sparse mixture routes. In Advances in Neural Information Processing Systems Datasets and Benchmarks Track [Data set].',
    // A publisher with a venue word, with a journal's volume and pages as well.
    'Whitfield, A. (2021). Sparse mixture routing for ship emissions. Nature Portfolio, Nature Communications 12, 4567.',
    // An agency read as the title by the parser: the work's own title is not taken for what follows it.
    'World Health Organization (2019). Sparse mixture routing for vaccine supply chains. The Lancet 393, 12–20.',
    'Copernicus Climate Change Service (2023). Sparse mixture reanalysis of ocean waves. Ocean Modelling 12, 45–67.',
    // An Act in a title, a journal after it.
    'Whitfield, A. (2015). The Clean Air Act and sparse mixture routing. Journal of Environmental Economics 12, 45–67.',
  ])('an invented journal paper dressed the same way stays Not found: %s', (text) => {
    expect(nothing(text).status).toBe('not_found');
  });

  test.each([
    [['OECD', 'Carbon pricing in sparse mixture shipping.', 'Journal of Maritime Economics 12, pp. 45–67.']],
    [['IMO', 'Sparse mixture routing for ballast water.', 'Marine Policy 104, pp. 12–19.']],
    [['European Union', 'Directive 2003/87/EC and carbon leakage in sparse mixture shipping.', 'Energy Policy 39, pp. 1234–1240.']],
    [['E.U. Copernicus Marine Service Information', 'Sparse mixture reanalysis of ocean waves.', 'Ocean Modelling 12 (3), pp. 45–67.', 'Note: Product ID: GLOBAL_MULTIYEAR_WAV_001_032']],
  ])('an agency as the author of an invented journal paper stays Not found: %j', (blocks) => {
    expect(nothing(blocks.join(' '), blocks).status).toBe('not_found');
  });

  test('a publisher that holds a venue word is no venue', () => {
    expect(nothing('Whitfield, A. (2021). Sparse mixture routing for ship emissions. Springer Nature.').status).toBe('cant_check');
    expect(nothing('Whitfield, A. (2021). Sparse mixture routing for ship emissions. Elsevier Science.').status).toBe('cant_check');
  });

  test('a note is no venue, but an identifier in it still is one', () => {
    expect(nothing('A. Whitfield and R. Okonkwo. Sparse mixture routing for ship emissions. Note: Journal of Maritime Economics, in press, vol. 12').status).toBe('cant_check');
    expect(parse('M. Salahshour and I. D. Couzin (2026) Harmonic theory of sparse routing. Note: arXiv:2609.33896 [physics.bio-ph]').kind).toBe('paper');
  });
});

// A wrong record with the same title must not win over one whose authors and year agree, and a
// record whose author list is implausible ("1", single letters) is weak evidence: never Verified, never Retracted, its
// "authors" never shown as differing, and below the Verified title no evidence at all (Can't check, never Not found).
describe('the candidate whose authors and year agree, and weak records', () => {
  const churnText = 'Umayaparvathi V, Iyakutti K. A survey on customer churn prediction in telecom industry: datasets, methods and metric. Int Res J Eng Technol. 2016;3(4):1065–70.';
  const junk = rec({ source: 'openalex', title: 'CUSTOMER CHURN PREDICTION IN TELECOM INDUSTRY', authors: ['1'], year: 2026, venue: 'International Journal of Engineering Research and Science & Technology' });
  const verdict = (citation: ParsedCitation, match: WorkRecord, retraction?: { retracted: true; version: 'cited' }) =>
    classify({ citation, match, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [], ...(retraction !== undefined && { retraction }) });

  test('the real reference (1904.00690#6) against a record whose only author is "1" is Can\'t check', () => {
    const v = verdict(parse(churnText), junk);
    expect(v.status).toBe('cant_check');
    expect(v.reason).not.toMatch(/Not found/);
  });

  test.each([
    [['1'], 2016],
    [['a', 'b'], 2016],
    [['1', '2', '3'], 2016],
  ])('a weak record with the cited title is never Verified or Retracted, and lists no differing authors: %j', (authors, year) => {
    const c = parse('Whitfield, A., Okonkwo, R. (2016). Sparse mixture routing for long-context retrieval. In Proceedings of ICML, pages 1-9.');
    const weak = rec({ title: 'Sparse mixture routing for long-context retrieval', authors, year, isRetracted: true });
    const v = verdict(c, weak, { retracted: true, version: 'cited' });
    expect(['details_differ', 'cant_check']).toContain(v.status);
    expect(v.diffs.map((d) => d.field)).not.toContain('authors');
    expect(verdict(c, { ...weak, isRetracted: false }).status).not.toBe('verified');
  });

  test('a weak record loses to a plausible one, an agreeing one to none', () => {
    const c = parse('Goodfellow, I., Pouget-Abadie, J., Mirza, M., Xu, B., Warde-Farley, D., Ozair, S., Courville, A., Bengio, Y.: Generative adversarial nets. Advances in neural information processing systems 27 (2014)');
    const chapter = rec({ title: 'Generative Adversarial Nets', authors: ['labaca castro'], year: 2023, venue: 'Machine Learning under Malware Attack' });
    const weak = rec({ source: 'openalex', title: 'Generative adversarial nets', authors: ['1'], year: 2014 });
    const real = rec({ source: 'openalex', title: 'Generative adversarial nets', authors: ['goodfellow', 'pouget abadie', 'mirza'], year: 2014 });
    const sibling = rec({ source: 'arxiv', title: 'Conditional Generative Adversarial Nets', authors: ['mirza', 'osindero'], year: 2014 });
    expect(pickBest(c, [weak, chapter])).toBe(chapter);
    expect(pickBest(c, [chapter, weak, real])).toBe(real);
    // One shared author of three is no agreement: the closer title still wins.
    expect(pickBest(c, [sibling, chapter])).toBe(chapter);
  });

  test('a candidate preferred for its authors and year is still only Details differ when its title differs', () => {
    const c = parse('Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need for graph transformers. In NeurIPS.');
    const other = rec({ title: 'Attention is all you need for graph transformers', authors: ['smith', 'jones'], year: 2022 });
    const agreeing = rec({ title: 'Attention Is All You Need', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017 });
    const best = pickBest(c, [other, agreeing]);
    expect(best).toBe(agreeing);
    expect(verdict(c, agreeing).status).toBe('details_differ');
  });
});

// An author list of Han characters (Crossref "family": "王") is a real one, not an implausible one.
describe('CJK family names are not implausible authors', () => {
  test.each([[['王', '李', '张']], [['陈']], [['林', '王']], [['田']], [['た']], [['김']], [['Ж']]])('%j is a plausible author list', (authors) => {
    expect(hasImplausibleAuthors(rec({ title: 'x', authors }))).toBe(false);
  });
});

describe('what stays implausible', () => {
  test.each([[['1']], [['a']], [['1', '2.']], [['a', 'b']]])('%j is implausible', (authors) => {
    expect(hasImplausibleAuthors(rec({ title: 'x', authors }))).toBe(true);
  });
});

const nothingAtAll = (text: string) => classify({ citation: parseCitation({ index: 1, label: '[1]', text }), searched: [...REQUIRED_SOURCES], failed: [] });
// readsAsDocument and the note field: an invented journal paper that names its journal must stay Not found.
describe('the document and note rules must not swallow invented journal papers', () => {
  test.each([
    // "Public Law" is a law journal (Sweet & Maxwell); the GAZETTE pattern and its tail eat the journal and its numbers.
    'Whitfield, A. (2019). Sparse mixture routing and the separation of powers. Public Law 2019, 123–145.',
    'A. Whitfield, Sparse mixture routing and the separation of powers, Public Law 2019 (2) 123.',
    // An agency as the only author, a journal whose name has a venue word the parser knows but PAPER_VENUE does not.
    'World Health Organization. Sparse mixture routing for vaccine supply chains. Nature Medicine.',
    'OECD. Sparse mixture routing for carbon pricing. Nature Climate Change, 2021.',
    'IPCC. Sparse mixture routing for climate projections. Science Advances, 2021.',
    'European Commission. Sparse mixture routing for energy policy. Advances in Applied Energy (2022).',
    // An agency read as the title, the invented title ending in a comma: the "first sentence" strip eats the journal.
    'World Health Organization (2019). Sparse mixture routing for vaccine supply chains, The Lancet 393, 12–20.',
    // A "Note:" title (Rev. Sci. Instrum., J. Chem. Phys. ran hundreds): the note-field strip starts inside the title.
    'Whitfield, A. (2015). Note: A compact sparse mixture laser source. Applied Optics 54, 123.',
  ])('stays Not found: %s', (text) => {
    expect(nothingAtAll(text).status).toBe('not_found');
  });
});

describe('the documents the rule is for stay Can\'t check', () => {
  test.each([
    'Inflation Reduction Act of 2022. Pub. L. No. 117-169, 136 Stat. 1818.',
    'Public Law No. 117-169, Inflation Reduction Act of 2022. 136 Stat. 1818.',
    'Copernicus Climate Change Service (2023). ERA5 hourly data on single levels from 1940 to present. Product ID: reanalysis-era5-single-levels.',
    'World Bank (2024). State and trends of carbon pricing 2024, Report No. 189209.',
  ])('%s', (text) => {
    expect(nothingAtAll(text).status).toBe('cant_check');
  });
});

// pickBest must not depend on the order the candidates arrive in.
describe('pickBest does not depend on result order', () => {
  test('the same three candidates give one answer in every order', () => {
    const c = parseCitation({ index: 1, label: '[1]', text: 'Whitfield, A., Okonkwo, R. (2019). Sparse mixture routing for long-context retrieval in multilingual corpora. In Proceedings of ICML, pages 1-9.' });
    const A = rec({ title: 'Sparse mixture routing for long-context retrieval', authors: ['whitfield', 'okonkwo'], year: 2019 });
    const B = rec({ title: 'Sparse mixture routing for long-context retrieval in multilingual corpora', authors: ['smith', 'jones'], year: 2022 });
    const C = rec({ title: 'Sparse mixture routing for long-context retrieval in multilingual text corpora', authors: [], year: 2019 });
    const picks = new Set([[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]].map((rs) => pickBest(c, rs)));
    expect(picks.size).toBe(1);
  });
});

describe('pickBest is the same in every order', () => {
  const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  test('four candidates of every kind (agreeing, no authors, other authors, implausible), all 24 orders', () => {
    const c = parseCitation({ index: 1, label: '[1]', text: 'Whitfield, A., Okonkwo, R. (2019). Sparse mixture routing for long-context retrieval in multilingual corpora. In Proceedings of ICML, pages 1-9.' });
    const A = rec({ title: 'Sparse mixture routing for long-context retrieval', authors: ['whitfield', 'okonkwo'], year: 2019 });
    const B = rec({ title: 'Sparse mixture routing for long-context retrieval in multilingual corpora', authors: ['smith', 'jones'], year: 2022 });
    const C = rec({ title: 'Sparse mixture routing for long-context retrieval in multilingual text corpora', authors: [], year: 2019 });
    const D = rec({ title: 'Sparse mixture routing for long-context retrieval in multilingual corpora', authors: ['1'], year: 2019 });
    const picks = new Set(permutations([A, B, C, D]).map((rs) => pickBest(c, rs)));
    expect([...picks]).toEqual([A]);
  });
});

// A venue's leading words that the matched record's venue does not hold go back to
// the title for the comparison; the real journal citations of 2610.00901 are untouched.
describe('the venue lead is re-read with the record', () => {
  const N = 'Grosskinsky, S., Schütz, G.M. and Spohn, H.,';
  const T = 'Condensation in the zero range process: stationary and dynamical properties';
  const zrp = rec({ title: 'Condensation in the Zero Range Process: Stationary and Dynamical Properties', authors: ['grosskinsky', 'schutz', 'spohn'], year: 2003, venue: 'Journal of Statistical Physics' });
  const verdict = (text: string, r: WorkRecord) => classify({ citation: parse(text), match: r, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [] }).status;

  test.each(['Probability Bounds', 'Physical Origins', 'Entropy Bounds', 'Suppl. Material', 'Pt. Two', 'Corr'])('"%s." against the record is part of the title', (s) => {
    const text = `${N} ${T}. ${s}. J. Stat. Phys. 113, 389–410 (2003).`;
    expect(verdict(text, zrp)).toBe('details_differ');
  });

  test.each(['Suppl. Material', 'Pt. Two', 'Corr'])('"%s." is part of the title against a record with no venue too', (s) => {
    expect(verdict(`${N} ${T}. ${s}. J. Stat. Phys. 113, 389–410 (2003).`, { ...zrp, venue: undefined })).not.toBe('verified');
  });

  // Against a record with no venue (an arXiv record, some OpenAlex ones) there is nothing to read the journal against. A
  // one-word sentence written like an abbreviation ("Models.") or a journal's opening word and one such word ("Probability
  // Bounds.") before a name that is a journal on its own ("J. Stat. Phys.") is an added sentence, compared with the title.
  test.each(['Probability Bounds', 'Physical Origins', 'Entropy Bounds', 'Models', 'Bounds', 'Results', 'Geophysics', 'Pacific'])('"%s." against a record with no venue is part of the title', (s) => {
    const text = `${N} ${T}. ${s}. J. Stat. Phys. 113, 389–410 (2003).`;
    expect(comparedWith(parse(text), { ...zrp, venue: undefined }).title).toBe(`${T}. ${s}`);
    expect(verdict(text, { ...zrp, venue: undefined })).toBe('details_differ');
  });

  test.each(['Models', 'Probability Bounds'])('"%s." before "Phys. Rev. Lett." against a record with no venue is part of the title', (s) => {
    expect(verdict(`${N} ${T}. ${s}. Phys. Rev. Lett. 113, 389–410 (2003).`, { ...zrp, venue: undefined })).toBe('details_differ');
  });

  // Real journals whose name opens with an abbreviation, or whose remaining words are no journal on their own, keep
  // Verified against a record with no venue.
  test.each([
    'J. Stat. Phys.',
    'Phys. Rev.',
    'Phys. Rev. Lett.',
    'Ann. Stat.',
    'Theory Probab. Appl.',
    'Physica A',
    'Electron. J. Probab.',
    'Electron. Commun. Probab.',
    'Bull. Amer. Math. Soc.',
    'Trans. Amer. Math. Soc.',
    'Prog. Part. Nucl. Phys.',
    'Stoch. Process. Appl.',
    'Phil. Trans. R. Soc. A',
    'Philos. Trans. R. Soc. A',
    'Br. J. Psychol.',
    'Braz. J. Phys.',
    'Combin. Probab. Comput.',
    'Found. Comput. Math.',
    'Quart. J. Econ.',
    'Mol. Biol. Evol.',
    'N. Engl. J. Med.',
    'Statist. Probab. Lett.',
    'Theoret. Comput. Sci.',
    'Front. Comput. Neurosci.',
    'Ergod. Theory Dyn. Syst.',
    'Stud. Appl. Math.',
    'Z. Angew. Math. Phys.',
    'Environ. Sci. Technol.',
    'Atmos. Chem. Phys.',
    'Geophys. J. Int.',
    'Pac. J. Math.',
    'Helv. Phys. Acta',
  ])('"%s" against a record with no venue stays Verified', (journal) => {
    expect(verdict(`${N} ${T}. ${journal} 113, 389–410 (2003).`, { ...zrp, venue: undefined })).toBe('verified');
  });

  test.each([
    ['Mukhin, A. B., Local limit theorems for lattice random variables. Theory Probab. Appl. 36, 698–713 (1991).', rec({ title: 'Local Limit Theorems for Lattice Random Variables', authors: ['mukhin'], year: 1992, venue: 'Theory of Probability &amp; Its Applications' })],
    ['Xi, N., Ding, N and Wang, Y., How required reserve ratio affects distribution and velocity of money. Physica A 357, 543–555 (2005).', rec({ title: 'How required reserve ratio affects distribution and velocity of money', authors: ['xi', 'ding', 'wang'], year: 2005, venue: 'Physica A: Statistical Mechanics and its Applications' })],
    ['Sakagawa, H., Limiting distributions of generalized money exchange models on hypergraphs. Adv. in Appl. Probab. 58, 850–875 (2026).', rec({ title: 'Limiting distributions of generalized money exchange models on hypergraphs', authors: ['sakagawa'], year: 2026, venue: 'Advances in Applied Probability' })],
    ['Armendáriz, I., Grosskinsky, S. and Loulakis, M., Zero-range condensation at criticality, Stoch. Process. Appl. 123, 3466–3496 (2013).', rec({ title: 'Zero-range condensation at criticality', authors: ['armendariz', 'grosskinsky', 'loulakis'], year: 2013, venue: 'Stochastic Processes and their Applications' })],
    ['Greenberg, M. and Gao, H.O., Twenty-five years of random asset exchange modeling. Eur. Phys. J. B 97, 69 (2024).', rec({ title: 'Twenty-five years of random asset exchange modeling', authors: ['greenberg', 'gao'], year: 2024, venue: 'The European Physical Journal B' })],
    ['Greenberg, M. and Gao, H.O., Twenty-five years of random asset exchange modeling. Eur. Phys. J. B 97, 69 (2024).', rec({ title: 'Twenty-five years of random asset exchange modeling', authors: ['greenberg', 'gao'], year: 2024 })],
  ])('a real journal citation stays Verified against its record: %s', (text, r) => {
    expect(verdict(text, r)).toBe('verified');
  });
});

describe('an abbreviation without its full stop matches the record\'s venue', () => {
  test('"Nat Phys 6, 681–684 (2010)" (1803.00255#3) stays Verified against Nature Physics', () => {
    const c = parse('Yusupov, R. et al. Coherent dynamics of macroscopic electronic order through a symmetry breaking transition. Nat Phys 6, 681–684 (2010).');
    const r = rec({ title: 'Coherent dynamics of macroscopic electronic order through a symmetry breaking transition', authors: ['yusupov', 'mertelj', 'kabanov'], year: 2010, venue: 'Nature Physics' });
    expect(classify({ citation: c, match: r, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [] }).status).toBe('verified');
  });
});

// The venue's leading words stay in the venue only when every word of the journal name, in
// order, abbreviates a word of the record's venue; otherwise the words before that run go back to the title.
describe('the journal name must abbreviate the record\'s venue in order', () => {
  const verdict = (text: string, r: WorkRecord) => classify({ citation: parse(text), match: r, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [] }).status;
  const prl = rec({ title: 'Condensation in the zero range process: stationary and dynamical properties', authors: ['grosskinsky', 'schutz', 'spohn'], year: 2003, venue: 'Physical Review Letters', shortVenues: ['Phys. Rev. Lett.'] });
  const N = 'Grosskinsky, S., Schütz, G.M. and Spohn, H.,';
  const T = 'Condensation in the zero range process: stationary and dynamical properties';

  test.each(['Physical Origins', 'Physical Review', 'Letters on Physics'])('"%s." before Phys. Rev. Lett. is not Verified against a PRL record', (s) => {
    expect(verdict(`${N} ${T}. ${s}. Phys. Rev. Lett. 113, 389–410 (2003).`, prl)).not.toBe('verified');
  });

  test('the real form against the same record is Verified', () => {
    expect(verdict(`${N} ${T}. Phys. Rev. Lett. 113, 389–410 (2003).`, prl)).toBe('verified');
  });

  test('"Nat Phys 6" against Nature Physics stays Verified, also with no short name on the record', () => {
    const c = 'Yusupov, R. et al. Coherent dynamics of macroscopic electronic order through a symmetry breaking transition. Nat Phys 6, 681–684 (2010).';
    const r = rec({ title: 'Coherent dynamics of macroscopic electronic order through a symmetry breaking transition', authors: ['yusupov', 'mertelj', 'kabanov'], year: 2010, venue: 'Nature Physics' });
    expect(verdict(c, r)).toBe('verified');
    expect(verdict(c, { ...r, shortVenues: ['Nature Phys'] })).toBe('verified');
  });
});

describe('journal names longer than the record\'s venue name', () => {
  const verdict = (text: string, r: WorkRecord) => classify({ citation: parse(text), match: r, matchedVia: 'search', searched: [...REQUIRED_SOURCES], failed: [] }).status;
  test.each([
    ['Torquato, S. & Stillinger, F. H. Local density fluctuations, hyperuniformity, and order metrics. Phys Rev E Stat Nonlin Soft Matter Phys 68, 411131–4111325 (2003).', rec({ title: 'Local density fluctuations, hyperuniformity, and order metrics', authors: ['torquato', 'stillinger'], year: 2003, venue: 'Physical Review E', shortVenues: ['Phys. Rev. E'] })],
    ['Reshak, A. H. & Auluck, S. Full-potential calculations of the electronic and optical properties for 1T and 2H phases of TaS2 and TaSe2. Physica B: Physics of Condensed Matter 358, 158–165 (2005).', rec({ title: 'Full-potential calculations of the electronic and optical properties for 1T and 2H phases of TaS2 and TaSe2', authors: ['reshak', 'auluck'], year: 2005, venue: 'Physica B: Condensed Matter' })],
  ])('stays Verified (1803.00255#16, #23): %s', (text, r) => {
    expect(verdict(text, r)).toBe('verified');
  });
});

// A record marked retracted whose retraction lookup could not answer is never Verified.
describe('a retracted record with an unknown retraction lookup', () => {
  const c = parse('Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need. In NeurIPS.');
  const r = rec({ title: 'Attention Is All You Need', authors: ['vaswani', 'shazeer', 'parmar'], year: 2017, isRetracted: true });
  const v = (retraction: 'unknown' | { retracted: boolean; version?: 'cited' }) => classify({ citation: c, match: r, matchedVia: 'search', retraction: retraction as never, searched: [...REQUIRED_SOURCES], failed: [] });
  test('Can\'t check, try again later', () => {
    expect(v('unknown').status).toBe('cant_check');
    expect(v('unknown').reason).toMatch(/marked as retracted.*Try again later/);
  });
  test('when the lookup answers, the existing paths apply', () => {
    expect(v({ retracted: true, version: 'cited' }).status).toBe('retracted');
    expect(v({ retracted: false }).status).toBe('verified');
  });
  test('a record not marked retracted with an unknown lookup is still Verified, with the note', () => {
    const ok = classify({ citation: c, match: { ...r, isRetracted: false }, matchedVia: 'search', retraction: 'unknown', searched: [...REQUIRED_SOURCES], failed: [] });
    expect(ok.status).toBe('verified');
  });
});

describe('a bracketed locator read as a reprint of the same work', () => {
  test('an invented titled paper with a real locator in brackets is still Not found when nothing matches', () => {
    const v = nothingAtAll('J. Doe, A. Roe, Invented dynamics of quantum lattice spin chains in curved backgrounds, Phys. Rev. D 82, 123456 (2010) [Phys. Rev. Lett. 116, 061102 (2016)].');
    expect(v.status).toBe('not_found');
  });
  test('a title-less entry is never read by the locator in brackets', async () => {
    const { journalLocator } = await import('../../../src/core/journalLocator');
    const loc = journalLocator(parse('J. Doe, Phys. Rev. D 82, 123456 (2010) [Phys. Rev. Lett. 116, 061102 (2016)].'));
    expect(loc?.volume ?? '82').toBe('82');
    expect(nothingAtAll('J. Doe, Phys. Rev. D 82, 123456 (2010) [Phys. Rev. Lett. 116, 061102 (2016)].').status).not.toBe('verified');
  });
});

describe('the chapter and report-series rules must not swallow invented journal papers', () => {
  test.each([
    'Smith, J., Jones, K.: Invented dynamics of neural magnitude estimation. In: Journal of Mathematical Psychology, pp. 73–88 (2019)',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Proceedings of the Cognitive Science Society, pp. 73–88, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Psychological Review 126, pp. 73–88, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In ICML, pp. 73–88, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Phys. Rev. Lett., pp. 73–88, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. Journal of Economic Working Papers 12(3), 45–67, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. Working Papers in Cognitive Science 12, 45–67, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. Neural Computation Working Paper 6, 2019.',
    // Pages alone are no sign of a book (natbib cites proceedings this way too).
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Invented Book on Magnitude, pp. 73–88.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Artificial Intelligence and Statistics, pp. 73–88. PMLR, 2019.',
    // A publisher alone, or editors with a proceedings title, is no book.
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Algorithmic Learning Theory, pp. 73–88. Springer, 2019.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Artificial Intelligence and Statistics (eds. A. Roe and B. Poe), pp. 73–88, 2019.',
    // Series that register every paper with Crossref.
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. NBER Working Paper No. 28411, 2021.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. World Bank Policy Research Working Paper 9512, 2021.',
    'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. IZA Discussion Paper No. 14012, 2021.',
  ])('stays Not found: %s', (text) => {
    expect(nothingAtAll(text).status).toBe('not_found');
  });

  test.each([
    ['a chapter', 'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In A. Roe (Ed.), Invented Book on Magnitude, pp. 73–88.'],
    ['a handbook chapter', 'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. In Handbook of Invented Magnitude, pp. 73–88. Springer, 2019.'],
    ['a working paper', 'J. Smith and K. Jones. Invented dynamics of neural magnitude estimation. Invented Group Working Paper 6.'],
  ])('residual, accepted: an invented %s shaped exactly like a real one is Can\'t check, never Verified', (_what, text) => {
    expect(nothingAtAll(text).status).toBe('cant_check');
  });
});
