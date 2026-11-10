import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { normalizeTitle } from '../../../src/core/normalize';
import { parseCitation } from '../../../src/core/parseCitation';
import type { ParsedCitation, RawReference } from '../../../src/core/types';

function ref(text: string, extra: Partial<RawReference> = {}): RawReference {
  return { index: 1, label: '[1]', text, ...extra };
}

describe('parseCitation: structured blocks', () => {
  const cho = parseCitation({
    index: 5,
    label: '[5]',
    text: '…',
    blocks: [
      'Kyunghyun Cho, Bart van Merrienboer, Caglar Gulcehre, Fethi Bougares, Holger Schwenk, and Yoshua Bengio.',
      'Learning phrase representations using rnn encoder-decoder for statistical machine translation.',
      'CoRR, abs/1406.1078, 2014.',
    ],
  });

  test('reads title, authors, year and arXiv id from arXiv HTML bib blocks', () => {
    expect(cho).toMatchObject({ arxivId: '1406.1078', year: 2014, kind: 'paper' });
    expect(cho.title).toMatch(/^Learning phrase representations/);
    expect(cho.authors.slice(0, 2)).toEqual(['cho', 'van merrienboer']);
    expect(cho.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('keeps the original text as raw', () => {
    expect(cho.raw).toBe('…');
  });

  test('a title block that also holds the venue is cut at the first sentence', () => {
    const parsed = parseCitation({
      index: 1,
      label: '[1]',
      text: '',
      blocks: [
        'Dengxin Dai and Luc Van Gool. 2018.',
        'Dark Model Adaptation: Semantic Image Segmentation from Daytime to Nighttime. In 2018 21st International Conference on Intelligent Transportation Systems (ITSC). 3819–3824.',
        'https://doi.org/10.1109/ITSC.2018.8569387',
      ],
    });
    expect(parsed.title).toBe('Dark Model Adaptation: Semantic Image Segmentation from Daytime to Nighttime');
    expect(parsed.year).toBe(2018);
    expect(parsed.doi).toBe('10.1109/ITSC.2018.8569387');
  });

  test('a single block falls back to reading the text', () => {
    const parsed = parseCitation(ref('A. Author and B. Writer. A study of things. In ICML, 2020.', { blocks: ['A. Author and B. Writer. A study of things. In ICML, 2020.'] }));
    expect(parsed.title).toBe('A study of things');
    expect(parsed.year).toBe(2020);
  });
});

describe('parseCitation: text only', () => {
  test('a GitHub URL with no DOI or arXiv id is software', () => {
    expect(parseCitation(ref('PyTorch. https://github.com/pytorch/pytorch, 2019.')).kind).toBe('software');
  });

  test('a bare URL with no DOI or arXiv id is a web page', () => {
    expect(parseCitation(ref('OpenAI. GPT-4 technical report. https://openai.com/research/gpt-4, 2023.')).kind).toBe('web');
  });

  test('reads a quoted IEEE title and drops the closing punctuation', () => {
    const parsed = parseCitation(ref('A. Vaswani, N. Shazeer et al., "Attention is all you need," in NeurIPS, 2017.'));
    expect(parsed.title).toBe('Attention is all you need');
    expect(parsed.authors.slice(0, 2)).toEqual(['vaswani', 'shazeer']);
    expect(parsed.year).toBe(2017);
  });

  test('garbled text gets low confidence and no invented title', () => {
    const parsed = parseCitation(ref('§§ garbled ¶ 12 34'));
    expect(parsed.confidence).toBeLessThan(0.4);
    expect(parsed.title).toBeUndefined();
  });

  test('empty text parses to an empty, zero-confidence citation', () => {
    expect(parseCitation(ref(''))).toMatchObject({ authors: [], kind: 'unknown', confidence: 0 });
  });

  test('strips a leading reference label, in brackets, parentheses or as a number', () => {
    for (const text of ['[7] A. Author. A study of things. In ICML, 2020.', '(7) A. Author. A study of things. In ICML, 2020.', '7. A. Author. A study of things. In ICML, 2020.']) {
      expect(parseCitation(ref(text)).title).toBe('A study of things');
    }
  });

  test('strips an author-year label that the text repeats', () => {
    const parsed = parseCitation({
      index: 3,
      label: 'Cer et al. (2017)',
      text: 'Cer et al. (2017) Daniel Cer, Mona Diab, and Lucia Specia. 2017. Semeval-2017 task 1. In Proceedings of SemEval, pages 1–14.',
    });
    expect(parsed.authors).toEqual(['cer', 'diab', 'specia']);
    expect(parsed.title).toBe('Semeval-2017 task 1');
    expect(parsed.year).toBe(2017);
  });

  test('reads an APA-style year in parentheses after the authors', () => {
    const parsed = parseCitation(ref('Smith, J. and Jones, K. (2019). Deep things in shallow water. Journal of Water, 12(3):45–67.'));
    expect(parsed).toMatchObject({ title: 'Deep things in shallow water', year: 2019, kind: 'paper' });
    expect(parsed.authors).toEqual(['smith', 'jones']);
  });

  test('a year inside the title does not win over the publication year', () => {
    const parsed = parseCitation(ref('College Board. 2020 USABO Semifinal exam score distribution, 2022. URL https://www.usabo-trc.org/x.pdf.'));
    expect(parsed.year).toBe(2022);
    expect(parsed.title).toBe('2020 USABO Semifinal exam score distribution');
  });

  test('page ranges, volumes and URLs are not read as years', () => {
    const parsed = parseCitation(ref('J. Smith. A study of things. Journal of Stuff, 12(3):1990–2005, https://example.org/2021/a, 2018.'));
    expect(parsed.year).toBe(2018);
  });

  test('a year with a letter suffix is a year', () => {
    expect(parseCitation(ref('Jason Wei. Chain of thought prompting. Advances in Neural Information Processing Systems, 35:24824–24837, 2022b.')).year).toBe(2022);
  });

  test('finds a DOI and an arXiv id and removes any version suffix', () => {
    const parsed = parseCitation(ref('A. Author. A study of things. arXiv:1706.03762v5, doi: 10.1145/3442188.3445922.'));
    expect(parsed.doi).toBe('10.1145/3442188.3445922');
    expect(parsed.arxivId).toBe('1706.03762');
  });

  test('a Zenodo DOI with no venue is software', () => {
    expect(parseCitation(ref('Speer, R. ftfy. Zenodo, 2019. URL https://doi.org/10.5281/zenodo.2591652. Version 5.5.')).kind).toBe('software');
  });

  test('joins a word split by a hyphen at a line break', () => {
    const parsed = parseCitation(ref('A. Author. Large-scale pre-\ntraining of models. In ICML, 2020.'));
    expect(parsed.title).toBe('Large-scale pretraining of models');
  });

  test('a scare-quoted word inside a title is not mistaken for a quoted title', () => {
    const parsed = parseCitation(ref('Su Lin Blodgett and Hanna Wallach. Language is power: A critical survey of “bias” in NLP. In Proceedings of ACL, 2020.'));
    expect(parsed.title).toBe('Language is power: A critical survey of “bias” in NLP');
  });

  test('a title that starts with a quote and is followed by a colon is kept whole', () => {
    const parsed = parseCitation(ref('Eric Smith and Adina Williams. “i’m sorry to hear that”: Finding new biases in language models. In Proceedings of EMNLP, pages 9180–9211, 2022.'));
    expect(parsed.title).toBe('“i’m sorry to hear that”: Finding new biases in language models');
  });

  test('reads AAAI-style semicolon-separated authors', () => {
    const parsed = parseCitation(ref('Belkin, M.; and Niyogi, P. 2003. Laplacian eigenmaps for dimensionality reduction. Neural computation 15(6): 1373–1396.'));
    expect(parsed).toMatchObject({ title: 'Laplacian eigenmaps for dimensionality reduction', year: 2003 });
    expect(parsed.authors).toEqual(['belkin', 'niyogi']);
  });

  test('a title that starts in lower case still follows the author list', () => {
    const parsed = parseCitation(ref('Hongyi Zhang, Moustapha Cissé, and David Lopez-Paz. mixup: Beyond empirical risk minimization. arXiv preprint arXiv:1710.09412, 2017.'));
    expect(parsed.title).toBe('mixup: Beyond empirical risk minimization');
    expect(parsed.authors).toEqual(['zhang', 'cisse', 'lopez paz']);
  });

  test('lower-case initials such as "d." and "v." do not end the author list', () => {
    const parsed = parseCitation(ref('Chen, M., Pinto, H. P. d. O., Kaplan, J., et al. (2021). Evaluating large language models trained on code. arXiv preprint arXiv:2107.03374.'));
    expect(parsed.title).toBe('Evaluating large language models trained on code');
  });

  test('a title that begins "Technical report" is a title, not a venue', () => {
    const parsed = parseCitation(ref('Ying Ju, Fubang Zhao, and Yunfeng Liu. Technical report on conversational question answering. arXiv preprint arXiv:1909.10772, 2019.'));
    expect(parsed.title).toBe('Technical report on conversational question answering');
  });

  test('a quoted web title followed by a URL has no author and no year from the link', () => {
    const parsed = parseCitation({
      index: 47,
      label: '[47]',
      text: '[47] “Revisiting the unreasonable effectiveness of data.” https://ai.googleblog.com/2017/07/revisiting-unreasonable-effectiveness.html. Accessed: 2020-12-31.',
      blocks: ['“Revisiting the unreasonable effectiveness of data.” https://ai.googleblog.com/2017/07/revisiting-unreasonable-effectiveness.html.', 'Accessed: 2020-12-31.'],
    });
    expect(parsed).toMatchObject({ title: 'Revisiting the unreasonable effectiveness of data', kind: 'web', authors: [] });
    expect(parsed.year).toBeUndefined();
  });

  test('a comma-only two-surname list is still read as one Last, First author (known limitation)', () => {
    // surnamesFrom cannot tell "Cho, Bengio" from "Cho, Kyunghyun" without more context.
    expect(parseCitation(ref('Cho, Bengio. A study of things. In ICML, 2014.')).authors).toEqual(['cho']);
  });
});

// The best of three runs: a blow-up from a bad regex fails every run, while a busy
// machine only slows some of them.
function timed(text: string): { parsed: ParsedCitation; elapsed: number } {
  let best = Infinity;
  let parsed = parseCitation(ref(''));
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    parsed = parseCitation(ref(text));
    best = Math.min(best, performance.now() - start);
  }
  return { parsed, elapsed: best };
}

describe('parseCitation: Nature-style et al., punctuation inside titles and Vancouver style', () => {
  test.each([
    ['Vaswani, A. et al. Attention is all you need. Adv. Neural Inf. Process. Syst. 30 (2017).', 'Attention is all you need', 2017, 'vaswani'],
    ['Vaswani, A., Shazeer, N. et al. Attention is all you need. Adv. Neural Inf. Process. Syst. 30 (2017).', 'Attention is all you need', 2017, 'vaswani'],
    ['Ouyang, L. et al. Training language models to follow instructions with human feedback. arXiv:2203.02155 (2022).', 'Training language models to follow instructions with human feedback', 2022, 'ouyang'],
    ['Brown, T. B. et al. Language models are few-shot learners. Adv. Neural Inf. Process. Syst. 33, 1877–1901 (2020).', 'Language models are few-shot learners', 2020, 'brown'],
  ])('"Last, F. et al. Title." (Nature style): %s', (text, title, year, first) => {
    const parsed = parseCitation(ref(text));
    expect(parsed.title).toBe(title);
    expect(parsed.year).toBe(year);
    expect(parsed.authors[0]).toBe(first);
  });

  test('et al. is never accepted as a title', () => {
    for (const text of ['Smith, J. et al. 2019.', 'Smith, J. et al.', 'Smith J, et al. Journal of Things 2019.']) {
      expect(parseCitation(ref(text)).title ?? '').not.toMatch(/^et\.? al\.?$/i);
    }
  });

  test('arXiv id is kept for the et-al style', () => {
    expect(parseCitation(ref('Ouyang, L. et al. Training language models to follow instructions with human feedback. arXiv:2203.02155 (2022).')).arxivId).toBe('2203.02155');
  });

  test('a question mark inside a title does not end it', () => {
    const parsed = parseCitation(ref('Di Jin, Zhijing Jin, Joey Tianyi Zhou, and Peter Szolovits. Is BERT really robust? A strong baseline for natural language attack on text classification and entailment. In AAAI, 2020.'));
    expect(parsed.title).toBe('Is BERT really robust? A strong baseline for natural language attack on text classification and entailment');
    expect(parsed.year).toBe(2020);
  });

  test('an exclamation mark inside a title does not end it either, and blocks agree', () => {
    const title = 'Attention! A new look at memory networks';
    expect(parseCitation(ref(`A. Author and B. Writer. ${title}. In ICML, 2020.`)).title).toBe(title);
    const withBlocks = parseCitation(ref('', { blocks: ['A. Author and B. Writer.', `${title}.`, 'In ICML, 2020.'] }));
    expect(withBlocks.title).toBe(title);
  });

  test('a question at the end of a title still ends it', () => {
    expect(parseCitation(ref('A. Author. Is it really so? arXiv preprint arXiv:1801.00001, 2018.')).title).toBe('Is it really so?');
    expect(parseCitation(ref('A. Author. Is it really so? In ICML, 2018.')).title).toBe('Is it really so?');
  });

  test('"arXiv preprint arXiv:<id>" on its own is not a title', () => {
    for (const text of ['arXiv preprint arXiv:2001.01234, 2020.', 'arXiv preprint arXiv:2001.01234', 'ArXiv e-prints, arXiv:2001.01234, 2020.']) {
      const parsed = parseCitation(ref(text));
      expect(parsed.title, text).toBeUndefined();
      expect(parsed.arxivId, text).toBe('2001.01234');
    }
  });

  test('Vancouver style with unpunctuated initials', () => {
    const parsed = parseCitation(ref('Mikolov T, Chen K, Corrado G, Dean J. Efficient estimation of word representations in vector space. arXiv:1301.3781. 2013.'));
    expect(parsed.title).toBe('Efficient estimation of word representations in vector space');
    expect(parsed.authors).toEqual(['mikolov', 'chen', 'corrado', 'dean']);
    expect(parsed.arxivId).toBe('1301.3781');
    expect(parsed.year).toBe(2013);
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('Vancouver journal reference', () => {
    const parsed = parseCitation(ref('Hinton G, Salakhutdinov R. Reducing the dimensionality of data with neural networks. Science. 2006;313(5786):504-7.'));
    expect(parsed.title).toBe('Reducing the dimensionality of data with neural networks');
    expect(parsed.authors).toEqual(['hinton', 'salakhutdinov']);
    expect(parsed.year).toBe(2006);
    expect(parsed.kind).toBe('paper');
  });

  test('a layout whose title is really an author run fails with low confidence', () => {
    // Initials-only run with no recognisable author segment before it.
    const parsed = parseCitation(ref('Mikolov T, Chen K, Corrado G, Dean J'));
    expect(parsed.title).toBeUndefined();
    expect(parsed.confidence).toBeLessThan(0.4);
  });

  test('a title that is an author run is rejected even when no author segment was found', () => {
    const parsed = parseCitation(ref('', { blocks: ['Anon.', 'Smith J, Jones K, Lee M.'] }));
    expect(parsed.title).toBeUndefined();
    expect(parsed.confidence).toBeLessThan(0.4);
  });

  test('an In: venue in LNCS style is a venue', () => {
    const parsed = parseCitation(ref('He, K., Zhang, X., Ren, S., Sun, J.: Deep residual learning for image recognition. In: CVPR (2016)'));
    expect(parsed).toMatchObject({ title: 'Deep residual learning for image recognition', year: 2016, kind: 'paper' });
  });
});

describe('parseCitation: question-mark titles, single initials and hostile input', () => {
  test.each([
    ['Smith, J. Is the brain a computer? Nature. 2019;5:1-3.', 'Is the brain a computer?', 2019, 'paper'],
    ['Smith, J., Lee, K. Is the brain a computer? Nature 5, 1-3 (2019).', 'Is the brain a computer?', 2019, 'paper'],
    ['Do transformers reason? Neural Computation, 2020.', 'Do transformers reason?', 2020, undefined],
    ['Is it so? Physical Review Letters 5, 2018.', 'Is it so?', 2018, 'paper'],
    ['Does it work? Springer, 2020.', 'Does it work?', 2020, undefined],
  ])('a venue after a question-mark title is not absorbed: %s', (text, title, year, kind) => {
    const parsed = parseCitation(ref(text));
    expect(parsed.title).toBe(title);
    expect(parsed.year).toBe(year);
    if (kind !== undefined) expect(parsed.kind).toBe(kind);
  });

  test('a title with an inner question mark still runs to its full stop', () => {
    const parsed = parseCitation(ref('Di Jin and Peter Szolovits. Is BERT really robust? A strong baseline for natural language attack on text classification and entailment. In AAAI, 2020.'));
    expect(parsed.title).toBe('Is BERT really robust? A strong baseline for natural language attack on text classification and entailment');
  });

  test('"In-context" and a plain "To" after a question mark are title words', () => {
    expect(parseCitation(ref('Is it enough? In-context learning of things. In ICML, 2020.')).title).toBe('Is it enough? In-context learning of things');
    expect(parseCitation(ref('Why? To what end. In ICML, 2020.')).title).toBe('Why? To what end');
  });

  test('a single Vancouver author with one unpunctuated initial', () => {
    const parsed = parseCitation(ref('Hinton G. Reducing the dimensionality of data with neural networks. Science. 2006;313(5786):504-7.'));
    expect(parsed.title).toBe('Reducing the dimensionality of data with neural networks');
    expect(parsed.authors).toEqual(['hinton']);
    expect(parsed.year).toBe(2006);
  });

  test('a given-first author with a middle initial is not read as Vancouver', () => {
    const parsed = parseCitation(ref('Quoc V. Le. Distributed representations of sentences and documents. In ICML, 2014.'));
    expect(parsed.title).toBe('Distributed representations of sentences and documents');
    expect(parsed.authors).toEqual(['le']);
  });

  test('"Green AI. CoRR, 2019." keeps no title and low confidence', () => {
    const parsed = parseCitation(ref('Green AI. CoRR, 2019.'));
    expect(parsed.title).toBeUndefined();
    expect(parsed.confidence).toBeLessThan(0.4);
  });
});

describe('parseCitation: robustness', () => {
  test('a 50k-character garbage reference parses quickly and gets low confidence', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:()[]"“”-/§¶\n';
    let garbage = '';
    while (garbage.length < 50_000) garbage += alphabet.charAt(next() % alphabet.length);
    const { parsed, elapsed } = timed(garbage);
    expect(elapsed).toBeLessThan(100);
    expect(parsed.confidence).toBeLessThan(0.4);
  });

  test.each([
    ['one long word', 'a'.repeat(50_000)],
    ['hyphen chain', 'a-'.repeat(25_000)],
    ['sentence soup', 'Aa Bb. '.repeat(7_000)],
    ['initials soup', 'A. B. '.repeat(8_000)],
    ['quote soup', '“a '.repeat(16_000)],
    ['comma soup', 'Aa, Bb, '.repeat(6_000)],
    ['question soup', 'Aa? Bb '.repeat(7_000)],
    ['single-initial soup', 'Aa B. Cc dd ee ff '.repeat(2_800)],
    ['digit soup', '1234.5678 10.1234/ '.repeat(2_500)],
  ])('%s of about 50k characters parses in under 100 ms with low confidence', (_name, text) => {
    const { parsed, elapsed } = timed(text);
    expect(elapsed).toBeLessThan(100);
    expect(parsed.confidence).toBeLessThan(0.4);
  });

  test('a huge block list is bounded and parses quickly', () => {
    const blocks = Array.from({ length: 5_000 }, () => 'Aa Bb. '.repeat(100));
    const start = performance.now();
    const parsed = parseCitation({ index: 1, label: '[1]', text: '', blocks });
    expect(performance.now() - start).toBeLessThan(100);
    expect(parsed.confidence).toBeLessThan(0.4);
  });

  test('a reference label that is a bare number does not eat the start of the text', () => {
    const parsed = parseCitation({ index: 1, label: '2', text: '2D Gaussian splatting for fast rendering. In SIGGRAPH, 2023.' });
    expect(parsed.title).toBe('2D Gaussian splatting for fast rendering');
  });

  test('never throws on control characters and zero-width text', () => {
    const parsed = parseCitation(ref('\u0000​‮[1]\u0007 A. Author. ​A study. In ICML, 2020.'));
    expect(parsed.authors.length).toBeGreaterThanOrEqual(0);
  });
});

interface Fixture {
  id: string;
  style: string;
  source: string;
  label: string;
  text: string;
  blocks?: string[];
  expect: {
    title: string;
    year: number | null;
    doi?: string;
    arxivId?: string;
    kind: ParsedCitation['kind'];
    authors?: string[];
  };
}

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/citations.json', import.meta.url), 'utf8')) as Fixture[];

describe('parseCitation: real reference fixtures', () => {
  test('there are at least 40 fixtures covering the main styles', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    const styles = new Set(fixtures.map((f) => f.style));
    for (const style of ['numeric', 'author-year', 'acl', 'ieee', 'icml', 'acm', 'aaai', 'lncs', 'web', 'github', 'book']) expect(styles).toContain(style);
    expect(fixtures.filter((f) => f.expect.doi !== undefined).length).toBeGreaterThanOrEqual(5);
    expect(fixtures.filter((f) => f.expect.arxivId !== undefined).length).toBeGreaterThanOrEqual(5);
    expect(fixtures.filter((f) => f.blocks !== undefined).length).toBeGreaterThanOrEqual(10);
    expect(fixtures.filter((f) => f.blocks === undefined).length).toBeGreaterThanOrEqual(10);
  });

  test.each(fixtures.map((f) => [`${f.id} ${f.style}: ${f.expect.title.slice(0, 50)}`, f] as const))('%s', (_name, f) => {
    const raw: RawReference = { index: 1, label: f.label, text: f.text, ...(f.blocks === undefined ? {} : { blocks: f.blocks }) };
    const parsed = parseCitation(raw);
    expect(normalizeTitle(parsed.title ?? '')).toBe(normalizeTitle(f.expect.title));
    expect(parsed.year).toBe(f.expect.year ?? undefined);
    expect(parsed.doi).toBe(f.expect.doi);
    expect(parsed.arxivId).toBe(f.expect.arxivId);
    expect(parsed.kind).toBe(f.expect.kind);
    if (f.expect.authors !== undefined) expect(parsed.authors.slice(0, f.expect.authors.length)).toEqual(f.expect.authors);
    expect(parsed.raw).toBe(f.text);
  });

  test('every fixture with a title is parsed with at least the minimum confidence', () => {
    for (const f of fixtures) {
      const parsed = parseCitation({ index: 1, label: f.label, text: f.text, ...(f.blocks === undefined ? {} : { blocks: f.blocks }) });
      if (parsed.title !== undefined) expect(parsed.confidence, f.id).toBeGreaterThanOrEqual(0.4);
    }
  });

  test('a title was found with confidence for every fixture that has authors', () => {
    for (const f of fixtures) {
      const parsed = parseCitation({ index: 1, label: f.label, text: f.text, ...(f.blocks === undefined ? {} : { blocks: f.blocks }) });
      if (f.expect.authors !== undefined && f.expect.authors.length > 0) expect(parsed.confidence, f.id).toBeGreaterThanOrEqual(0.6);
    }
  });
});

describe('parseCitation: a generic short title with nothing else is not a reference', () => {
  const conf = (text: string) => parseCitation({ index: 1, label: '[1]', text }).confidence;

  test.each(['see above', 'See above.', 'ibid.', 'Editorial', 'Supplementary material'])('%j gets low confidence', (text) => {
    expect(conf(text)).toBeLessThan(0.4);
  });

  test('authors, a year or an identifier each keep it above the line', () => {
    expect(conf('Editorial, 2015.')).toBeGreaterThanOrEqual(0.4);
    expect(conf('Roe J, Smith J. Editorial.')).toBeGreaterThanOrEqual(0.4);
    expect(conf('"Editorial." doi:10.1000/xyz123')).toBeGreaterThanOrEqual(0.4);
  });

  test('a title of three words is not affected', () => {
    expect(conf('"Attention is all"')).toBeGreaterThanOrEqual(0.4);
  });
});

describe('parseCitation: labels left in the text', () => {
  const RISK = 'Risk factors for severe disease in hospitalised patients: cohort study';
  const bmj = `Smith J, Jones K, Patel A, et al. ${RISK}. BMJ 2020;368:m1. doi:10.1136/bmj.m1`;
  const rsc = 'J. Roe and J. Smith, Chem. Sci., 2020, 11, 1234, doi:10.1000/abc.';
  const same = (a: ParsedCitation, b: ParsedCitation): void => expect({ ...a, raw: '' }).toEqual({ ...b, raw: '' });

  test.each(['1 ', '23 ', '¹ ', '²³', 'S1. ', 'A12. '])('%j before a Vancouver author list is a label: the title is not cut at "et al"', (label) => {
    const c = parseCitation(ref(`${label}${bmj}`));
    expect(c.title).toBe(RISK);
    expect(c.authors).toEqual(['smith', 'jones', 'patel']);
    same(c, parseCitation(ref(bmj)));
  });

  test.each(['1 ', '23 ', '1', 'S1. ', 'A12. ', '¹'])('%j before an initial is a label (RSC / physics styles)', (label) => {
    same(parseCitation(ref(`${label}${rsc}`)), parseCitation(ref(rsc)));
  });

  test('a number glued to an initial is a label', () => {
    same(parseCitation(ref('1J. Roe and J. Smith, Chem. Sci., 2020, 11, 1234, doi:10.1000/abc.')), parseCitation(ref(rsc)));
  });

  test.each([
    ['100 Years of relativity. J. Roe. Nature 2020.', '100 Years of relativity'],
    ['10 Things I learned about graphs. J. Roe. Nature 2020.', '10 Things I learned about graphs'],
    ['1000 Genomes Project Consortium. A global reference for human genetic variation. Nature 526, 68 (2015).', '1000 Genomes Project Consortium'],
    ['3D printing of soft robots. J. Roe. Nature 2020.', '3D printing of soft robots'],
  ])('a number that starts a title is not a label: %s', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });

  test('a year that opens an entry is not taken for a bare label', () => {
    const c = parseCitation(ref('2020 J. Roe. Some title of a paper. Nature.'));
    expect(c.year).toBe(2020);
  });
});

// Found by the accuracy evaluation: physics reference lists give authors and a journal citation and no title at
// all ("C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)"). The "Phys." was read as the end of the authors and
// "Rev" as the title, which then searched for the word "Rev" and called a real paper Not found.
describe('parseCitation: journal citations with no title (physics style)', () => {
  const cases: [string, string[], number][] = [
    ['C. Brans, R.H. Dicke, Phys. Rev. 124, 925 (1961)', ['brans', 'dicke'], 1961],
    ['S. Nojiri, S.D. Odintsov, V.K. Oikonomou, Phys. Rept. 692, 1 (2017)', ['nojiri', 'odintsov', 'oikonomou'], 2017],
    ['R.P. Woodard, Lect. Notes Phys. 720, 403 (2007)', ['woodard'], 2007],
    ['A.H. Guth, Phys. Rev. D 23(2), 347 (1981)', ['guth'], 1981],
    ['A.A. Starobinsky, Phys. Lett. B 91(1), 99 (1980)', ['starobinsky'], 1980],
    ['R. Utiyama, B.S. DeWitt, J. Math. Phys. 3, 608 (1962)', ['utiyama', 'dewitt'], 1962],
    ['H. Weyl, Annalen Phys. 59, 101 (1919)', ['weyl'], 1919],
    // Journals spelled out, in lower case, with article numbers and long names.
    ['E.V. Linder, Phys. Rev. D81, 127301 (2010)', ['linder'], 2010],
    ['B. Majumder, Int. J. Mod. Phys. D 22(13), 1350079 (2013)', ['majumder'], 2013],
    // Conference entries without a title: venue, pages and year, or only an acronym and the year.
    ['T. Mikolov, I. Sutskever, K. Chen, G. Corrado, and J. Dean, NIPS pp. 1389–1399 (2017).', ['mikolov', 'sutskever', 'chen', 'corrado', 'dean'], 2017],
    ['J. Pennington, R. Socher, and C. D. Manning, EMNLP (2014).', ['pennington', 'socher', 'manning'], 2014],
    ['R. E. Korf, IJCAI International Joint Conference on Artificial Intelligence pp. 538–543 (2009), ISSN 10450823.', ['korf'], 2009],
    ['J. Liu, W. Zhang, and H. V. Poor, IEEE International Symposium on Information Theory - Proceedings 2021-July, 2894 (2021), ISSN 21578095.', ['liu', 'zhang', 'poor'], 2021],
    ['G. A. Miller, Psychological review 63, 81 (1956).', ['miller'], 1956],
    ['A. Yoshimori, Journal of the Physical Society of Japan 14, 807 (1959).', ['yoshimori'], 1959],
    ['N. Nagaosa and Y. Tokura, Nature nanotechnology 8, 899 (2013).', ['nagaosa', 'tokura'], 2013],
    ['S. Bhatia, R. Richie, and W. Zou, Current Opinion in Behavioral Sciences 29, 31 (2019).', ['bhatia', 'richie', 'zou'], 2019],
    ['A. Georgiou, T. Can, M. Katkov, and M. Tsodyks, Learning & Memory 32, a054043 (2025).', ['georgiou', 'can', 'katkov', 'tsodyks'], 2025],
    ['Y. Zhou, B. H. Smith, and T. O. Sharpee, Science advances 4, eaaq1458 (2018).', ['zhou', 'smith', 'sharpee'], 2018],
    // PNAS article numbers have ten digits; the whole text is no title to report Not found.
    ['A. H. Mayo, D.-A. Deaconu, H. Masuda, Y. Nii, H. Takahashi, R. V. Belosludov, S. Ishiwata, M. S. Bahramy, and Y. Onose, Proceedings of the National Academy of Sciences 122, e2405839122 (2025).', ['mayo', 'deaconu', 'masuda'], 2025],
  ];

  test.each(cases)('%s has no title, and the journal is not an author', (text, authors, year) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBeUndefined();
    // No author list is reported (the identifier checks read the author part of the raw text), and no surname is a journal word.
    expect(c.authors).toEqual([]);
    expect(c.venue).toBeDefined();
    for (const surname of authors) expect(c.venue?.toLowerCase()).not.toContain(surname);
    expect(c.year).toBe(year);
    // Nothing to search for, so it is not read reliably enough to be looked up.
    expect(c.confidence).toBeLessThan(0.4);
  });

  test('a journal citation after a quoted title is untouched', () => {
    const c = parseCitation(ref('J. Roe, A. Smith, “Black holes and the second law,” Phys. Rev. Lett. 98, 123 (2007).'));
    expect(c.title).toBe('Black holes and the second law');
    expect(c.authors).toEqual(['roe', 'smith']);
  });

  test('an identifier after the year is allowed, and still found', () => {
    const c = parseCitation(ref('G.A. Vilkovisky, Class. Quant. Grav. 9, 895 (1992). DOI 10.1088/0264-9381/9/4/008'));
    expect(c.title).toBeUndefined();
    expect(c.doi).toBe('10.1088/0264-9381/9/4/008');
  });

  test('hostile near-matches are read quickly', () => {
    const started = performance.now();
    for (const text of ['A, '.repeat(130), `${'Aa b, '.repeat(60)}Journal of ${'x '.repeat(40)}12, 3 (20`, `${'J. Roe, '.repeat(40)}${'Phys. '.repeat(30)}1, 2 (2001`]) parseCitation(ref(text));
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('a book with its publisher in brackets still has the book as its title', () => {
    expect(parseCitation(ref('F. C. Bartlett, Remembering (Cambridge University Press, 1932).')).title).toMatch(/Remembering/);
  });

  test('an ordinary paper reference with a journal volume is untouched', () => {
    const c = parseCitation(ref('Hochreiter S, Schmidhuber J. Long short-term memory. Neural Computation. 1997;9(8):1735-1780.'));
    expect(c.title).toBe('Long short-term memory');
  });
});

// Physics PDFs print a DOI where the page goes, or an erratum in brackets after the locator. Neither is a title, and
// neither splits the journal's name into a title and a venue.
describe('parseCitation: a title-less journal citation with a DOI for its page, or an erratum after it', () => {
  test('"Nucl. Phys. B537, <DOI> (1999)" has no title, keeps its DOI and the whole journal name (2610.31730#26)', () => {
    const c = parseCitation(ref('M. G. Alford, K. Rajagopal, and F. Wilczek, Nucl. Phys. B537, 10.1016/S0550-3213(98)00668-3 (1999).'));
    expect(c.title).toBeUndefined();
    expect(c.doi).toBe('10.1016/S0550-3213(98)00668-3');
    expect(c.year).toBe(1999);
    expect(c.authors).toEqual([]);
    expect(c.venue).toMatch(/^Nucl\. Phys\. B537/);
  });

  test.each([
    ['M. Roe, Phys. Rev. D 81, 10.1103/PhysRevD.81.084001 (2010).', '10.1103/PhysRevD.81.084001', 2010],
    ['M. Roe and K. Poe, J. High Energy Phys. 03, 10.1007/JHEP03(2014)022 (2014).', '10.1007/JHEP03(2014)022', 2014],
  ])('%s has no title and keeps its DOI', (text, doi, year) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBeUndefined();
    expect(c.doi).toBe(doi);
    expect(c.year).toBe(year);
  });

  test('"Rev. Mod. Phys. 90, 015004 (2018), [Erratum: ...]" is a title-less locator of 2018 (2610.27843#11)', () => {
    const c = parseCitation(ref('F.-K. Guo, C. Hanhart, U.-G. Meißner, Q. Wang, Q. Zhao, and B.-S. Zou, Rev. Mod. Phys. 90, 015004 (2018), [Erratum: Rev.Mod.Phys. 94, 029901 (2022)].'));
    expect(c.title).toBeUndefined();
    expect(c.authors).toEqual([]);
    expect(c.year).toBe(2018);
    expect(c.venue).toMatch(/^Rev\. Mod\. Phys\. 90, 015004/);
  });

  test.each([
    ['J. Roe, Phys. Rev. D 73, 064030 (2006) [erratum].', 2006],
    ['J. Roe and K. Poe, Commun. Math. Phys. 43, 199 (1975) [Erratum: Commun. Math. Phys. 46, 206 (1976)].', 1975],
  ])('%s is a title-less locator with the year of the work, not of its erratum', (text, year) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBeUndefined();
    expect(c.year).toBe(year);
  });

  test('a year inside an erratum bracket is not the year of a titled work either', () => {
    expect(parseCitation(ref('S. W. Hawking, “Particle Creation by Black Holes,” Commun. Math. Phys. 43, 199-220 (1975) [erratum: Commun. Math. Phys. 46, 206 (1976)].')).year).toBe(1975);
  });
});

// INSPIRE and BibTeX-style physics entries are comma-separated all the way ("Authors, Title, Journal vol (year) page
// [eprint]"). Read as one sentence, the title would be the whole entry, authors included, and a correctly found paper
// would be reported as "Title differs".
describe('parseCitation: comma-separated authors, title and journal (physics style)', () => {
  test('initials-first authors, title, journal, volume, year and page', () => {
    const c = parseCitation(ref('E. V. Levine, M. J. Turner, P. Kehayias, C. A. Hart, N. Langellier, R. Trubko et al., Principles and techniques of the quantum diamond microscope, Nanophotonics 8 (Nov., 2019) 1945–1973.'));
    expect(c.title).toBe('Principles and techniques of the quantum diamond microscope');
    expect(c.authors.slice(0, 3)).toEqual(['levine', 'turner', 'kehayias']);
    expect(c.authors).toContain('trubko');
    expect(c.year).toBe(2019);
  });

  test('"X and Y" inside the author list, and an arXiv number in brackets', () => {
    const c = parseCitation(ref('O. DeWolfe, A. Giryavets, S. Kachru and W. Taylor, Enumerating flux vacua with enhanced symmetries, JHEP 02 (2005) 037 [hep-th/0411061].'));
    expect(c.title).toBe('Enumerating flux vacua with enhanced symmetries');
    expect(c.authors).toEqual(['dewolfe', 'giryavets', 'kachru', 'taylor']);
    expect(c.arxivId).toBe('hep-th/0411061');
    expect(c.year).toBe(2005);
  });

  test('a title that contains a comma stays whole', () => {
    const c = parseCitation(ref('J. Michelson, Compactifications of type IIB strings to four-dimensions, with nontrivial classical potential, Nucl. Phys. B 495 (1997) 127 [hep-th/9610151].'));
    expect(c.title).toBe('Compactifications of type IIB strings to four-dimensions, with nontrivial classical potential');
  });

  test('a title followed only by an eprint number', () => {
    const c = parseCitation(ref('G.W. Moore, Arithmetic and attractors, hep-th/9807087.'));
    expect(c.title).toBe('Arithmetic and attractors');
    expect(c.arxivId).toBe('hep-th/9807087');
  });

  test('last-name-first and sentence-style entries keep their own reading', () => {
    expect(parseCitation(ref('Smith, J., Jones, K. (2019). A study of things. Journal of Stuff, 4, 1-9.')).title).toBe('A study of things');
    expect(parseCitation(ref('J. Smith and K. Jones. A study of things. Journal of Stuff 4:1-9, 2019.')).title).toBe('A study of things');
  });
});

describe('parseCitation: comma-separated entries with particles and suffixes in the names', () => {
  test.each([
    ['D. R. Glenn, R. R. Fu, P. Kehayias, D. Le Sage, E. A. Lima, B. P. Weiss et al., Micrometer-scale magnetic imaging of geological samples using a quantum diamond microscope, Geochem. Geophys. Geosyst. 18 (2017) 3254–3267.', 'Micrometer-scale magnetic imaging of geological samples using a quantum diamond microscope'],
    ['A. Mittelholz, S. C. Steele, R. R. Fu, C. L. Johnson, R. J. Lillis and G. Stucky de Quay, Magnetic field signatures of craters on mars, Geophysical Research Letters 51 (2024) e2023GL106788.', 'Magnetic field signatures of craters on mars'],
    ['B. J. Roth, N. G. Sepulveda and J. P. Wikswo Jr, Using a magnetometer to image a two-dimensional current distribution, J. Appl. Phys. 65 (1989) 361–372.', 'Using a magnetometer to image a two-dimensional current distribution'],
    ['A. Gruber, A. Dräbenstedt, C. Tietz, L. Fleury, J. Wrachtrup and C. v. Borczyskowski, Scanning Confocal Optical Microscopy and Magnetic Resonance on Single Defect Centers, Science 276 (June, 1997) 2012–2014.', 'Scanning Confocal Optical Microscopy and Magnetic Resonance on Single Defect Centers'],
  ])('%#: the title is not swallowed by an unusual name', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });
});

// Real items that are not papers (a thesis, work in preparation, a talk, a dataset page) are in no database, so they
// are Can't check, never searched for and reported Not found.
describe('parseCitation: items that are not papers', () => {
  test.each([
    ['Benjamin Jiahong Zhang. Efficient Sampling Methods of, by, and for Stochastic Dynamical Systems. PhD thesis, Massachusetts Institute of Technology, 2022.'],
    ['H Corrales and C Valencia. The critical group of the cartesian product of matrices. PhD thesis, Master thesis, Mathematics Department, Cinvestav-IPN, 2010.'],
    ['Carsten Hartmann, Lara Neureither, and Upanshu Sharma. Soft constraints in Langevin dynamics. in preparation, 2025.'],
    ['A. Kitaev. Talk given at the Fundamental Physics Prize Symposium, Nov. 10, 2014.'],
    ['Scott Crossley, Perpetual Baffour, Jules King, Lauryn Burleigh, Walter Reade, and Maggie Demkin. 2024. Asap 2.0: Automated student assessment prize. Kaggle.'],
  ])('%s is not a paper', (text) => {
    expect(['book', 'web', 'software']).toContain(parseCitation(ref(text)).kind);
  });

  test('a paper that merely mentions a thesis topic or a talk in its title is still a paper', () => {
    expect(parseCitation(ref('J. Roe. A talk about thesis writing. Journal of Stuff 4:1-9, 2019.')).kind).toBe('paper');
  });
});

// Found by the accuracy evaluation: arXiv's own bibliography rendering writes "Authors (year) Title. Venue. Cited by: §1."
// with no full stop after the authors, so the authors, the year and the title were read as one title.
describe('parseCitation: "Authors (year) Title. Venue." entries', () => {
  test('reads the authors, the year and the title apart', () => {
    const c = parseCitation(ref('R. Abebe, J. Kleinberg, and S. M. Weinberg (2020) Subsidy allocations in the presence of income shocks. In Proceedings of the AAAI Conference on Artificial Intelligence, Vol. 34, pp. 7032–7039. Cited by: §1.2.'));
    expect(c.title).toBe('Subsidy allocations in the presence of income shocks');
    expect(c.authors).toEqual(['abebe', 'kleinberg', 'weinberg']);
    expect(c.year).toBe(2020);
  });

  test('full author names work too, and so does a journal entry', () => {
    const c = parseCitation(ref('D. Allhutter, F. Cech, F. Fischer, G. Grill, and A. Mager (2020) Algorithmic profiling of job seekers in austria: how austerity politics are made effective. Frontiers in big data 3, pp. 502780. Cited by: Appendix D, §6.'));
    expect(c.title).toBe('Algorithmic profiling of job seekers in austria: how austerity politics are made effective');
    expect(c.authors.slice(0, 2)).toEqual(['allhutter', 'cech']);
  });
});

describe('parseCitation: a talk is a talk even when its venue has a venue word', () => {
  test('"Talk given at the ... Symposium" is not a paper', () => {
    expect(parseCitation(ref('A. Kitaev. https://www.youtube.com/watch?v=OQ9qN8j7EZI. Talk given at the Fundamental Physics Prize Symposium, Nov. 10, 2014.')).kind).toBe('web');
  });
});

// Web pages whose address was dropped from the text (arXiv's rendering keeps only "External Links: Link") are not
// papers, so they are not searched for in four services and reported Not found.
describe('parseCitation: web pages without an address in the text', () => {
  test.each([
    ['OpenAI GPT-4o: multimodal large language model. Note: Accessed: 2025-02-17 External Links: Link Cited by: §4.1.'],
    ['Jon Christian. 2023. Cnet secretly used ai on articles that didn’t disclose that fact. Futurism. Accessed on March 3, 2023.'],
    ['DeepMind. The Gemini model family overview. Retrieved from the company website.'],
    ['Anthropic. The model family overview. Retrieved on 12 May 2024.'],
    ['World Health Organization. Global status report on road safety [Online].'],
    ['Federal Reserve Bank. Monetary policy report, February. Online; accessed 4 April 2022.'],
  ])('%s is not a paper', (text) => {
    expect(parseCitation(ref(text)).kind).toBe('web');
  });

  test('"External Links: Link, Document" (the entry has a DOI that was dropped from the text) is not a web page', () => {
    expect(parseCitation(ref('S. Baltes and P. Ralph (2022) Sampling in software engineering research: a critical review and guidelines. Empirical Software Engineering (EMSE). External Links: Link, Document Cited by: §4.4.')).kind).not.toBe('web');
    expect(parseCitation(ref('V. Braun and V. Clarke (2006) Using thematic analysis in psychology. Qualitative Research in Psychology. External Links: Link, ISSN 1478-0887 Cited by: §4.5.')).kind).not.toBe('web');
  });

  test('a note about access never overrides an identifier', () => {
    expect(parseCitation(ref('J. Roe. Deep things in shallow water. 2019. doi:10.1000/xyz123. Accessed: 2020-01-01')).kind).toBe('paper');
    expect(parseCitation(ref('J. Roe. Deep things in shallow water. 2019. arXiv:1906.01234. Accessed: 2020-01-01')).kind).toBe('paper');
  });

  test('a journal citation that also says when it was accessed is still a paper', () => {
    expect(parseCitation(ref('J. Roe and K. Smith. Deep things in shallow water. Journal of Stuff 4, 1-9 (2019). Accessed: 2020-01-01.')).kind).toBe('paper');
    // A venue with no venue word in it ("Neuron") but a volume and pages is a paper's, not a page's.
    expect(parseCitation(ref('A. G. Huth, S. Nishimoto. Natural speech reveals the semantic maps. Neuron 76, 1210 (2012). External Links: Link')).kind).not.toBe('web');
  });
});

// A month in brackets ("(Oct., 2011)") or a publisher in brackets ("(Cambridge University Press, 2005)") left in the
// title would no longer match the record's title, and the row would say "Details differ".
describe('parseCitation: dates and publishers in brackets are not part of the title', () => {
  test.each([
    ['A. J. Nichols and C. L. Evans, Video-rate Scanning Confocal Microscopy and Microendoscopy, Journal of Visualized Experiments : JoVE (Oct., 2011) 3252.', 'Video-rate Scanning Confocal Microscopy and Microendoscopy', 2011],
    ['Smith, J., Jones, K.: A study of things (Oct., 2011). Journal of Stuff 4, 1-9.', 'A study of things', 2011],
    ['J. Smith and K. Jones. A study of things (Oct 2011). Journal of Stuff 4, 1-9.', 'A study of things', 2011],
    ['J. Smith and K. Jones. A study of things (July, 2011). Journal of Stuff 4, 1-9.', 'A study of things', 2011],
    ['N.D. Birrell, P.C.W. Davies, Quantum Fields in Curved Space (Cambridge Univ. Press, Cambridge, UK, 1984)', 'Quantum Fields in Curved Space', 1984],
    ['N. Cowan, Working memory capacity (Psychology press, 2012).', 'Working memory capacity', 2012],
    ['V. Mukhanov, Physical foundations of cosmology (Cambridge University Press, 2005)', 'Physical foundations of cosmology', 2005],
    ['I.L. Buchbinder, S.D. Odintsov, I.L. Shapiro, Effective Action in Quantum Gravity (IOP Publishing, Bristol, UK, 1992)', 'Effective Action in Quantum Gravity', 1992],
    ['M. Mézard, G. Parisi, and M. A. Virasoro, Spin glass theory and beyond: An Introduction to the Replica Method and Its Applications, vol. 9 (World Scientific Publishing Company, 1987).', 'Spin glass theory and beyond: An Introduction to the Replica Method and Its Applications', 1987],
    ['W. M. Hsynes, CRC Handbook of Chemistry and Physics 92nd edn (CRC, Florida, 2011-12).', 'CRC Handbook of Chemistry and Physics 92nd edn', 2011],
  ])('%s', (text, title, year) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBe(title);
    expect(c.year).toBe(year);
  });

  test('a book whose publisher was in brackets is a book, not something to search for', () => {
    expect(parseCitation(ref('V. Mukhanov, Physical foundations of cosmology (Cambridge University Press, 2005)')).kind).toBe('book');
  });

  test('brackets that are part of the title stay', () => {
    expect(parseCitation(ref('Jane Roe and John Smith. The update framework (TUF). Journal of Stuff 4, 1-9, 2019.')).title).toBe('The update framework (TUF)');
    expect(parseCitation(ref('Jane Roe and John Smith. Gradient flows (with an appendix on notation). Journal of Stuff 4, 1-9, 2019.')).title).toBe('Gradient flows (with an appendix on notation)');
  });
});

// A note LaTeXML appends ("Cited by: §2.") must not make "H. Everett, Rev. Mod. Phys. 29, 454 (1957)" a titled paper
// whose title is "Mod".
describe('parseCitation: a trailing "Cited by" note is not part of the reference', () => {
  test('a journal citation with the note is read like one without it', () => {
    const plain = parseCitation(ref('H. Everett, Rev. Mod. Phys. 29, 454 (1957)'));
    const noted = parseCitation(ref('H. Everett, Rev. Mod. Phys. 29, 454 (1957) Cited by: §2.'));
    expect(noted.title).toBeUndefined();
    expect(noted).toMatchObject({ year: 1957, kind: plain.kind });
    expect(noted.confidence).toBeLessThan(0.4);
  });

  test('so are a note with several sections and a note after a titled entry', () => {
    expect(parseCitation(ref('H. Everett, Rev. Mod. Phys. 29, 454 (1957). Cited by: §1, §2.2, Appendix A.')).title).toBeUndefined();
    const c = parseCitation(ref('Jane Roe and John Smith. Deep things in shallow water. Journal of Stuff 4, 1-9, 2019. Cited by: §1.'));
    expect(c.title).toBe('Deep things in shallow water');
  });

  test('"cited by" inside a title stays', () => {
    expect(parseCitation(ref('Jane Roe and John Smith. Who is cited by whom in physics. Journal of Stuff 4, 1-9, 2019.')).title).toBe('Who is cited by whom in physics');
  });
});

// Only a bracket that is a date or an imprint (a comma before the year, or a month in front of it) is cut.
describe('parseCitation: brackets that end in a year but belong to the title', () => {
  test.each([
    ['Jane Roe and John Smith. Bibliometric analysis of deep learning research (2012–2022). Journal of Stuff 4, 1-9, 2023.', 'Bibliometric analysis of deep learning research (2012–2022)'],
    ['Jane Roe and John Smith. Climate trends in Europe (1950 to 2010). Journal of Stuff 4, 1-9, 2012.', 'Climate trends in Europe (1950 to 2010)'],
    ['Jane Roe and John Smith. Report on the workshop (Dagstuhl 2019). Journal of Stuff 4, 1-9, 2020.', 'Report on the workshop (Dagstuhl 2019)'],
  ])('%s keeps its bracket', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });

  test.each([
    ['A. J. Nichols and C. L. Evans, Video-rate Scanning Confocal Microscopy and Microendoscopy, Journal of Visualized Experiments : JoVE (Oct., 2011) 3252.', 'Video-rate Scanning Confocal Microscopy and Microendoscopy'],
    ['V. Mukhanov, Physical foundations of cosmology (Cambridge University Press, 2005)', 'Physical foundations of cosmology'],
    ['W. M. Hsynes, CRC Handbook of Chemistry and Physics 92nd edn (CRC, Florida, 2011-12).', 'CRC Handbook of Chemistry and Physics 92nd edn'],
    ['J. Smith and K. Jones. A study of things (Oct 2011). Journal of Stuff 4, 1-9.', 'A study of things'],
  ])('%s still loses its date or imprint', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });
});

// Three kinds of item that are real but in no scholarly database, so never Not found.
describe('parseCitation: books with a city and publisher, GitHub projects, and addresses in a sentence', () => {
  test.each([
    'Kahneman, D. (2013). Thinking, fast and slow (1st pbk. ed. ed.). New York: Farrar, Straus and Giroux.',
    'Jane Roe. The Shape of Water. Cambridge: Harvard Univ. Press, 1999.',
    'John Smith. A History of Things, 2nd edition. London: Allen and Unwin, 1988.',
  ])('%s is a book', (text) => {
    expect(parseCitation(ref(text)).kind).toBe('book');
  });

  test('a city before a colon in a title is not a publisher', () => {
    expect(parseCitation(ref('Jane Roe and John Smith. Boston: a city and its schools. Journal of Stuff 4, 1-9, 2019.')).kind).toBe('paper');
  });

  test.each([
    'James Bradbury, Roy Frostig, Peter Hawkins. JAX: Composable transformations of Python+NumPy programs. GitHub, 2018.',
  ])('%s is software', (text) => {
    expect(parseCitation(ref(text)).kind).toBe('software');
  });

  test('a paper that mentions GitHub in its title is still a paper', () => {
    expect(parseCitation(ref('Jane Roe and John Smith. Mining GitHub repositories at scale. Journal of Stuff 4, 1-9, 2019.')).kind).toBe('paper');
  });

  test('a sentence that carries an address is no title, and the entry is a web page', () => {
    const c = parseCitation(ref('The waveform shown is SXS:BBH:0305, available for download at http://www.black‑holes.org/waveforms.'));
    expect(c.title).toBeUndefined();
    expect(c.kind).toBe('web');
  });
});

// ", in <Book>" after a title in comma style is where the book starts.
describe('parseCitation: a chapter cited with the book it is in', () => {
  test('the title stops in front of ", in <Book>"', () => {
    const c = parseCitation(ref('G. Tian, Smoothness of the universal deformation space of compact Calabi-Yau manifolds and its Petersson-Weil metric, in Mathematical aspects of string theory (San Diego, Calif., 1986), vol. 1 of Adv. Ser. Math. Phys., pp. 629–646, World Sci. Publishing, Singapore (1987).'));
    expect(c.title).toBe('Smoothness of the universal deformation space of compact Calabi-Yau manifolds and its Petersson-Weil metric');
    expect(c.year).toBe(1987);
  });

  // ", in <Capital>" is a book only when the rest reads like a book.
  test.each([
    ['J. Roe and K. Smith, Spin liquids and emergent gauge fields, in Kitaev materials, Phys. Rev. B 99, 104 (2019)', 'Spin liquids and emergent gauge fields, in Kitaev materials'],
    ['J. Roe and K. Smith, Spin liquids and emergent gauge fields, in Kitaev Materials, Nature 571, 95 (2019)', 'Spin liquids and emergent gauge fields, in Kitaev Materials'],
  ])('%s keeps its whole title', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });

  test.each([
    'G. Tian, Smoothness of the universal deformation space, in Mathematical aspects of string theory, pp. 629–646 (1987)',
    'G. Tian, Smoothness of the universal deformation space, in Mathematical aspects of string theory, vol. 1, 1987',
    'G. Tian, Smoothness of the universal deformation space, in Mathematical Aspects, edited by S. Yau, 1987',
    'G. Tian, Smoothness of the universal deformation space, in Mathematical Aspects, World Scientific Press, 1987',
    'G. Tian, Smoothness of the universal deformation space, in Mathematical Aspects (San Diego, Calif., 1986), 1987',
  ])('%s stops before the book', (text) => {
    expect(parseCitation(ref(text)).title).toBe('Smoothness of the universal deformation space');
  });

  test('a title with ", in" inside it keeps it', () => {
    expect(parseCitation(ref('G. Tian, Gravity tests, in the laboratory and in space, Class. Quant. Grav. 21, 1725 (2004)')).title).toBe('Gravity tests, in the laboratory and in space');
  });

  // The commonest conference form has no book marker; the venue itself ends the title.
  test.each([
    ['S. Ioffe and C. Szegedy, Batch normalization, in Proceedings of the International Conference on Machine Learning, 2015', 'Batch normalization', 'in Proceedings of the International Conference on Machine Learning'],
    ['A. Vaswani, N. Shazeer and N. Parmar, Attention is all you need, in Advances in Neural Information Processing Systems, 2017', 'Attention is all you need', 'in Advances in Neural Information Processing Systems'],
    ['J. Ho, A. Jain and P. Abbeel, Denoising diffusion probabilistic models, in Advances in Neural Information Processing Systems, 2020', 'Denoising diffusion probabilistic models', 'in Advances in Neural Information Processing Systems'],
    ['I. Goodfellow, J. Pouget-Abadie and M. Mirza, Generative adversarial nets, in NeurIPS, 2014', 'Generative adversarial nets', 'in NeurIPS'],
    ['K. He, X. Zhang and S. Ren, Deep residual learning for image recognition, in CVPR, 2016', 'Deep residual learning for image recognition', 'in CVPR'],
    ['J. Devlin, M. Chang and K. Lee, BERT pre-training of deep bidirectional transformers, in Findings of the Association for Computational Linguistics, 2019', 'BERT pre-training of deep bidirectional transformers', 'in Findings of the Association for Computational Linguistics'],
  ])('%s ends the title at the venue', (text, title, venue) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBe(title);
    expect(c.venue?.startsWith(venue)).toBe(true);
  });

  // A title may carry ", in <something that starts like a venue>" without being one. The acronym reading
  // needs the chunk to be the acronym alone (with a year, Proceedings, Workshop or Conference after it), and
  // "International" / "Annual" must open an event or journal name, not any phrase.
  test.each([
    ['G. Tian, Gravity tests, in DNA repair pathways, Class. Quant. Grav. 21, 1725 (2004)', 'Gravity tests, in DNA repair pathways'],
    ['G. Tian, Gravity tests, in IEEE 802.11 networks, Class. Quant. Grav. 21, 1725 (2004)', 'Gravity tests, in IEEE 802.11 networks'],
    ['G. Tian, Gravity tests, in COVID-19 patients, Class. Quant. Grav. 21, 1725 (2004)', 'Gravity tests, in COVID-19 patients'],
    ['J. Roe and K. Smith, Gravity tests, in the International Space Station, 2019', 'Gravity tests, in the International Space Station'],
    ['G. Tian, Gravity tests, in International trade networks, Class. Quant. Grav. 21, 1725 (2004)', 'Gravity tests, in International trade networks'],
    // A venue word somewhere later in the phrase is not enough: it has to follow the acronym's name and end it.
    ['A. Smith and B. Jones, Open access, in IEEE Journal publishing models, Phys. Rev. D 12, 345 (2020)', 'Open access, in IEEE Journal publishing models'],
    ['A. Smith and B. Jones, Open access, in IEEE Transactions-style reviews, Phys. Rev. D 12, 345 (2020)', 'Open access, in IEEE Transactions-style reviews'],
    ['A. Smith and B. Jones, Open access, in LLM Journal citations, Phys. Rev. D 12, 345 (2020)', 'Open access, in LLM Journal citations'],
    ['A. Smith and B. Jones, Open access, in HPC Workshops at scale, Phys. Rev. D 12, 345 (2020)', 'Open access, in HPC Workshops at scale'],
    ['A. Smith and B. Jones, Open access, in NASA Conference proceedings archives, Phys. Rev. D 12, 345 (2020)', 'Open access, in NASA Conference proceedings archives'],
  ])('%s keeps the phrase in the title', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });

  test.each([
    ['J. Ho, A. Jain and P. Abbeel, Denoising diffusion probabilistic models, in NeurIPS 2020, 2020', 'Denoising diffusion probabilistic models'],
    ['K. He, X. Zhang and S. Ren, Deep residual learning for image recognition, in CVPR Workshop, 2016', 'Deep residual learning for image recognition'],
    ['K. He, X. Zhang and S. Ren, Deep residual learning for image recognition, in International Conference on Computer Vision, 2016', 'Deep residual learning for image recognition'],
    ['K. He, X. Zhang and S. Ren, Deep residual learning for image recognition, in Annual Meeting of the Association for Computational Linguistics, 2016', 'Deep residual learning for image recognition'],
  ])('%s still ends the title at the venue', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });

  // An acronym-led venue that continues with a venue word, or a suffixed acronym, ends the title too.
  test.each([
    'in IEEE Conference on Computer Vision and Pattern Recognition, 2019.',
    'in AAAI Conference on Artificial Intelligence, 2019.',
    'in IEEE International Conference on Robotics and Automation (ICRA), 2019.',
    'in IEEE/CVF International Conference on Computer Vision, 2019.',
    'in ACM SIGKDD International Conference on Knowledge Discovery and Data Mining, 2019.',
    'in IEEE Transactions on Pattern Analysis and Machine Intelligence, 2019.',
    'in USENIX Security Symposium, 2019.',
    'in CVPR Workshops, 2019.',
    'in NAACL-HLT, 2019.',
    'in IJCAI-19, 2019.',
    'in NeurIPS Datasets and Benchmarks Track, 2021.',
  ])('A. Smith and B. Jones, Deep networks for robust vision, %s ends the title at the venue', (venue) => {
    const c = parseCitation(ref(`A. Smith and B. Jones, Deep networks for robust vision, ${venue}`));
    expect(c.title).toBe('Deep networks for robust vision');
    expect(c.venue?.startsWith(venue.replace(/, \d{4}\.$/, ''))).toBe(true);
    expect(c.kind).toBe('paper');
  });

  test('a title that says "in <Capitalised word>" without a venue reading stays whole', () => {
    expect(parseCitation(ref('J. Roe and K. Smith, Spin liquids in Kitaev materials, Phys. Rev. B 99, 104 (2019)')).title).toBe('Spin liquids in Kitaev materials');
  });
});

// BibLaTeX writes a full stop after a given name ("Victor. Rodriguez"); the quoted
// title after the names is the title.
describe('a quoted title after names with a full stop after a given name', () => {
  test.each([
    ['Jørgen Andersen, Gaëtan Borot, Leonid. Chekhov and Nicolas Orantin “The ABCD of topological recursion” In Advances in Mathematics 439 Elsevier BV, 2024, pp. 109473 DOI: 10.1016/j.aim.2023.109473', 'The ABCD of topological recursion', ['andersen', 'borot', 'chekhov', 'orantin']],
    ['Mattia Biancotto, Lorenz Eberhardt, Victor. Rodriguez and Zi-Yue Wang “The Runkel-Watts string”, 2026 arXiv: https://arxiv.org/abs/2607.19462', 'The Runkel-Watts string', ['biancotto', 'eberhardt', 'rodriguez', 'wang']],
    ['Scott Collier, Lorenz Eberhardt, Beatrix Mühlmann and Victor. Rodriguez “Complex Liouville String” In Phys. Rev. Lett. 134.25, 2025, pp. 251602 DOI: 10.1103/k74n-s63l', 'Complex Liouville String', ['collier', 'eberhardt', 'muhlmann', 'rodriguez']],
    ['Scott Collier, Lorenz Eberhardt, Beatrix Mühlmann and Victor. Rodriguez “The complex Liouville string: The matrix integral” In SciPost Physics 18.5 Stichting SciPost, 2025 DOI: 10.21468/scipostphys.18.5.154', 'The complex Liouville string: The matrix integral', ['collier', 'eberhardt', 'muhlmann', 'rodriguez']],
    ['Scott Collier, Lorenz Eberhardt and Victor. Rodriguez “ c=1 strings as a matrix integral”, 2026 arXiv:2604.06301 [hep-th]', 'c=1 strings as a matrix integral', ['collier', 'eberhardt', 'rodriguez']],
  ])('%s', (text, title, authors) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBe(title);
    expect(c.authors).toEqual(authors);
  });
  test('a sentence before a quote is still not a list of names', () => {
    expect(parseCitation(ref('J. Smith. Deep Learning. “A quoted phrase” In Proc. 2020.')).title).not.toBe('A quoted phrase');
  });
});

// One author written in lower case ("yelong shen") makes the author list fail as names, and the names could be read
// as the title. With the year in brackets after the names, the text after the year is the title.
describe('a lower-case name in an author list before a bracketed year', () => {
  const LORA = 'E. J. Hu, yelong shen, P. Wallis, Z. Allen-Zhu, Y. Li, S. Wang, L. Wang, and W. Chen (2022) LoRA: low-rank adaptation of large language models. In International Conference on Learning Representations,';

  test('the real reference, as arXiv renders it', () => {
    const c = parseCitation(
      ref(LORA, {
        label: '[20]',
        blocks: ['E. J. Hu, yelong shen, P. Wallis, Z. Allen-Zhu, Y. Li, S. Wang, L. Wang, and W. Chen (2022)', 'LoRA: low-rank adaptation of large language models.', 'In International Conference on Learning Representations,'],
      }),
    );
    expect(c.title).toBe('LoRA: low-rank adaptation of large language models');
    expect(c.authors.slice(0, 3)).toEqual(['hu', 'shen', 'wallis']);
    expect(c.year).toBe(2022);
  });

  test('the same text without blocks', () => {
    expect(parseCitation(ref(LORA)).title).toBe('LoRA: low-rank adaptation of large language models');
  });

  test.each([
    // Two lower-case pieces: not a list of names with one lower-case author.
    'E. J. Hu, yelong shen, peter wallis, Z. Allen-Zhu and W. Chen (2022) LoRA: low-rank adaptation of large language models. In ICLR.',
    // A lower-case phrase is no name: a name is two or three words.
    'E. J. Hu, low rank adaptation methods, P. Wallis, Z. Allen-Zhu and W. Chen (2022) LoRA: low-rank adaptation of large language models. In ICLR.',
    // Only two pieces: too short a list to tell a lower-case name from words.
    'yelong shen and W. Chen (2022) LoRA: low-rank adaptation of large language models. In ICLR.',
  ])('not read as names: %s', (text) => {
    expect(parseCitation(ref(text)).title).not.toBe('LoRA: low-rank adaptation of large language models');
  });
});

// "Surname, I., Title. J. Stat. Phys. 113, 389–410 (2003)." The title
// is the text between the author block and the abbreviated journal followed by volume, pages and (year), or a publisher.
describe('parseCitation: "Surname, I., Title. Journal vol, pages (year)"', () => {
  test.each([
    ['Armendáriz, I., Grosskinsky, S. and Loulakis, M., Zero-range condensation at criticality, Stoch. Process. Appl. 123, 3466–3496 (2013).', 'Zero-range condensation at criticality', ['armendariz', 'grosskinsky', 'loulakis'], 2013],
    ['Davis, B. and McDonald, D., An elementary proof of the local central limit theorem. J. Theoret. Probab. 8, 693–701 (1995).', 'An elementary proof of the local central limit theorem', ['davis', 'mcdonald'], 1995],
    ['Funaki, T., Equivalence of ensembles under inhomogeneous conditioning and its applications to random Young diagrams. J. Stat. Phys. 154, 588–609 (2014).', 'Equivalence of ensembles under inhomogeneous conditioning and its applications to random Young diagrams', ['funaki'], 2014],
    ['Greenberg, M. and Gao, H.O., Twenty-five years of random asset exchange modeling. Eur. Phys. J. B 97, 69 (2024).', 'Twenty-five years of random asset exchange modeling', ['greenberg', 'gao'], 2024],
    ['Grosskinsky, S., Schütz, G.M. and Spohn, H., Condensation in the zero range process: stationary and dynamical properties. J. Stat. Phys. 113, 389–410 (2003).', 'Condensation in the zero range process: stationary and dynamical properties', ['grosskinsky', 'schutz', 'spohn'], 2003],
    ['Lanchier, N. and Reed, S., Rigorous results for the distribution of money on connected graphs (models with debts). J. Stat. Phys. 176, 1115–1137 (2019).', 'Rigorous results for the distribution of money on connected graphs (models with debts)', ['lanchier', 'reed'], 2019],
    ['Lanchier, N. and Reed, S., Distribution of money on connected graphs with multiple banks. Math. Model. Nat. Phenom. 19, Paper No.10 (2024).', 'Distribution of money on connected graphs with multiple banks', ['lanchier', 'reed'], 2024],
    ['Landim, C., Sethuraman, S. and Varadhan, S. R. S., Spectral gap for zero-range dynamics. Ann. Probab. 24, 1871–1902 (1996).', 'Spectral gap for zero-range dynamics', ['landim', 'sethuraman', 'varadhan'], 1996],
    ['Mukhin, A. B., Local limit theorems for lattice random variables. Theory Probab. Appl. 36, 698–713 (1991).', 'Local limit theorems for lattice random variables', ['mukhin'], 1991],
    ['Sakagawa, H., Limiting distributions of generalized money exchange models on hypergraphs. Adv. in Appl. Probab. 58, 850–875 (2026).', 'Limiting distributions of generalized money exchange models on hypergraphs', ['sakagawa'], 2026],
    ['Spitzer, F., Interaction of Markov processes. Adv. Math. 5, 246–290 (1970).', 'Interaction of Markov processes', ['spitzer'], 1970],
    ['Xi, N., Ding, N and Wang, Y., How required reserve ratio affects distribution and velocity of money. Physica A 357, 543–555 (2005).', 'How required reserve ratio affects distribution and velocity of money', ['xi', 'ding', 'wang'], 2005],
    ['Yakovenko, V. M. and Barkley Rosser, J. J., Colloquium: statistical mechanics of money, wealth, and income. Rev. Mod. Phys. 81, 1703–1725 (2009).', 'Colloquium: statistical mechanics of money, wealth, and income', ['yakovenko', 'barkley rosser'], 2009],
  ])('a journal paper: %s', (text, title, authors, year) => {
    const c = parseCitation(ref(text, { blocks: [text] }));
    expect(c.title).toBe(title);
    expect(c.authors).toEqual(authors);
    expect(c.year).toBe(year);
    expect(['paper', 'unknown']).toContain(c.kind);
    expect(c.confidence).toBeGreaterThanOrEqual(0.4);
  });

  test.each([
    ['Bingham, N., Goldie, C. M. and Teugels, J. L., Regular variation, Cambridge University Press, Cambridge (1987).', 'Regular variation', ['bingham', 'goldie', 'teugels']],
    ['Chakrabarti, B. K, Chakraborti, A., Chakravarty, S. R. and Chatterjee, A., Econophysics of Income and Wealth Distributions, Cambridge University Press, Cambridge (2013).', 'Econophysics of Income and Wealth Distributions', ['chakrabarti', 'chakraborti', 'chakravarty', 'chatterjee']],
    ['Durrett, R., Probability: Theory and Examples, 5th ed. Cambridge University Press, Cambridge (2019).', 'Probability: Theory and Examples', ['durrett']],
    ['Friedli, S. and Velenik, Y., Statistical mechanics of lattice systems. A concrete mathematical introduction. Cambridge University Press, Cambridge (2018).', 'Statistical mechanics of lattice systems. A concrete mathematical introduction', ['friedli', 'velenik']],
    ['Kipnis, C. and Landim, C., Scaling limits of interacting particle systems. Grundlehren Math. Wiss. 320, Springer-Verlag, Berlin (1999).', 'Scaling limits of interacting particle systems', ['kipnis', 'landim']],
    ['Lanchier, N., Stochastic Interacting Systems in Life and Social Sciences. De Gruyter, Berlin, Boston (2024).', 'Stochastic Interacting Systems in Life and Social Sciences', ['lanchier']],
    ['Petrov, V. V., Sums of independent random variables. Springer, Springer-Verlag, Berlin (1975).', 'Sums of independent random variables', ['petrov']],
  ])('a book: %s', (text, title, authors) => {
    const c = parseCitation(ref(text, { blocks: [text] }));
    expect(c.title).toBe(title);
    expect(c.authors).toEqual(authors);
    expect(c.kind).toBe('book');
  });

  test.each([
    // No title between the names and the journal: still title-less.
    'Roe, J., Phys. Rev. Lett. 98, 100401 (2007).',
    'Roe, J. and Smith, K., J. Stat. Phys. 113, 389–410 (2003).',
  ])('a title-less journal citation stays title-less: %s', (text) => {
    expect(parseCitation(ref(text)).title).toBeUndefined();
  });

  test.each([
    // A sequel word, a roman numeral or a part number is part of the title, not of the journal.
    ['Roe, J., Gibbs measures on lattices, Part II. J. Stat. Phys. 113, 389–410 (2003).', 'Gibbs measures on lattices, Part II'],
    ['Roe, J., Hydrodynamics of the zero range process: Further Results. J. Stat. Phys. 113, 389–410 (2003).', 'Hydrodynamics of the zero range process: Further Results'],
    ['Roe, J., Random walks on random Young Diagrams. J. Stat. Phys. 113, 389–410 (2003).', 'Random walks on random Young Diagrams'],
  ])('the journal is not read into the title, nor the title into the journal: %s', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });

  test('Springer\'s "Surname, I., Surname, I.: Title" is not this style', () => {
    const c = parseCitation(ref('Ronneberger, O., Fischer, P., Brox, T.: U-net: Convolutional networks for biomedical image segmentation. In: Medical image computing and computer-assisted intervention–MICCAI 2015, pp. 234–241. Springer (2015)'));
    expect(c.title).toBe('U-net: Convolutional networks for biomedical image segmentation');
  });
});

// A DOI in a "Data: ..." / "Data available at ..." / "Dataset:" clause
// is the data's, not the reference's own. A DOI outside such a clause is kept; with none, the title is searched.
describe('parseCitation: a data DOI is not the reference\'s DOI', () => {
  test.each([
    'R. Harpaz, M. N. Nguyen, A. Bahl, and F. Engert (2021) Precise visuomotor transformations underlying collective behavior in larval zebrafish. Nature Communications 12, pp. 6578. Note: Data: Harvard Dataverse, https://doi.org/10.7910/DVN/POVJYS, CC0',
    'S. Raikwar, A. Al-Kassem, N. S. Gov, A. I. Pesci, R. Jeanneret, and R. E. Goldstein (2025) Phototactic decision-making by microalgae. Physical Review Letters 135 (22), pp. 228401. Note: Data: Zenodo https://doi.org/10.5281/zenodo.15051634',
    'Z. Ajabi, A. T. Keinath, X. Wei, and M. P. Brandon (2023) Population dynamics of head-direction neurons during drift and reorientation. Nature 615, pp. 892–899. Note: Data: figshare https://doi.org/10.6084/m9.figshare.21792689',
    'A. Whitfield and R. Okonkwo (2021) Sparse mixture routing in zebrafish. Nature 615, 892–899. Data available at https://doi.org/10.5061/dryad.v9s4mw6qx.',
    'A. Whitfield and R. Okonkwo (2021) Sparse mixture routing in zebrafish. Nature 615, 892–899. Dataset: doi:10.5061/dryad.v9s4mw6qx',
    'A. Whitfield and R. Okonkwo (2021) Sparse mixture routing in zebrafish. Nature 615, 892–899. The data are publicly available from https://doi.org/10.5061/dryad.v9s4mw6qx',
  ])('the data DOI is dropped: %s', (text) => {
    const c = parseCitation(ref(text));
    expect(c.doi).toBeUndefined();
    expect(c.title).toBeDefined();
  });

  test('the reference\'s own DOI outside the clause is kept', () => {
    const c = parseCitation(ref('Z. Ajabi, A. T. Keinath, X. Wei, and M. P. Brandon (2023) Population dynamics of head-direction neurons during drift and reorientation. Nature 615, pp. 892–899. doi:10.1038/s41586-023-05813-2. Note: Data: figshare https://doi.org/10.6084/m9.figshare.21792689'));
    expect(c.doi).toBe('10.1038/s41586-023-05813-2');
  });

  test.each([
    // A dataset cited for itself keeps its DOI: no clause names it as the data of another work.
    ['V. H. Sridhar and L. Li (2021) GODM v0.1. Zenodo. Note: https://doi.org/10.5281/zenodo.5599712', '10.5281/zenodo.5599712'],
    ['T. Xue, X. Li, G. Lin, and G. Theraulaz (2023) Data for: tuning social interactions’ strength drives collective response to light intensity in schooling fish. Figshare. Note: https://doi.org/10.6084/m9.figshare.22640053.v1', '10.6084/m9.figshare.22640053.v1'],
    // "Data" in a title or a journal's name is no clause.
    ['A. Whitfield (2020) Big Data: sparse mixture routing at scale. Data Science Journal 19, 12. doi:10.5334/dsj-2020-012', '10.5334/dsj-2020-012'],
  ])('a DOI that is the work\'s own is kept: %s', (text, doi) => {
    expect(parseCitation(ref(text)).doi).toBe(doi);
  });
});

// "287 (1937)" is volume and issue, not the year, when the reference
// has another plausible year. Alone, a bracketed year after a volume is the year ("Nucl. Phys. B 360 (1991) 145").
describe('parseCitation: a bracketed issue number is not the year', () => {
  test.each([
    ['A. McKee, A. P. Soto, P. Chen, and M. J. McHenry (2020) The sensory basis of schooling by intermittent swimming in the rummy-nose tetra (Hemigrammus rhodostomus). Proceedings of the Royal Society B: Biological Sciences 287 (1937), pp. 20200568.', 2020],
    ['McKee A, Soto AP, Chen P, McHenry MJ. 2020. The sensory basis of schooling by intermittent swimming. Proc. R. Soc. B 287 (1937), 20200568.', 2020],
    ['Whitfield, A. (2019). Sparse mixture routing. Physica A 1999 (2018), 123–130.', 2019],
  ])('the other year is the year: %s', (text, year) => {
    expect(parseCitation(ref(text)).year).toBe(year);
  });

  test.each([
    ['J. Roe, Phys. Rev. 124, 925 (1961).', 1961],
    ['E. Witten, Nucl. Phys. B 360 (1991) 145.', 1991],
    ['A. Whitfield, Sparse mixture routing, Nanophotonics 8 (2019) 1945–1973.', 2019],
    ['A. Whitfield, Sparse mixture routing, Nanophotonics 8 (Nov., 2019) 1945–1973.', 2019],
    ['A. Whitfield, Sparse mixture routing, Phys. Rev. D 100 (2019) 2020.', 2019],
    ['A. McKee, A. P. Soto (2020) The sensory basis of schooling. Proceedings of the Royal Society B 287 (2020), pp. 20200568.', 2020],
    // A page before the bracket, and a volume designation that holds years, are no other year.
    ['R.L. Arnowitt, S. Deser, C.W. Misner, Gen. Rel. Grav. 40, 1997 (2008). DOI 10.1007/s10714-008-0661-1', 2008],
    ['P.T. Chrusciel, Anti-gravity à la Carlotto-Schoen [after Carlotto and Schoen], Séminaire Bourbaki, Vol. 2016/2017, Exp. 1120, Astérisque 407 (2019), 1–25.', 2019],
    ['H. Masuda, T. Seki, and Y. Onose, Nature Communications 15, 1999 (2024).', 2024],
  ])('a bracketed year after a volume is still the year when it is the only one: %s', (text, year) => {
    expect(parseCitation(ref(text)).year).toBe(year);
  });
});

// A chapter cited without its own title ("T. Nagamiya, in Solid State Physics,
// Vol. 20 ...") has no title. The volume's name is where it appeared, not what it is called.
describe('parseCitation: a chapter cited without its own title', () => {
  test.each([
    'T. Nagamiya, in Solid State Physics, Vol. 20 (Elsevier, 1968) pp. 305–411.',
    'T. Nagamiya, in Solid State Physics, edited by F. Seitz and D. Turnbull (Academic Press, New York, 1968), Vol. 20, p. 305.',
    'A. B. Roe and C. D. Smith, in Handbook of Magnetic Materials, Vol. 12, edited by K. H. J. Buschow (Elsevier, Amsterdam, 1999) pp. 1–87.',
    'J. Roe, in Proceedings of the 32nd International Conference on Machine Learning (PMLR, 2015) pp. 448–456.',
  ])('no title: %s', (text) => {
    const c = parseCitation(ref(text));
    expect(c.title).toBeUndefined();
    expect(c.venue).toMatch(/^in /i);
  });

  test.each([
    ['T. Nagamiya, Helical spin ordering: theory of helical spin configurations, in Solid State Physics, Vol. 20 (Elsevier, 1968) pp. 305–411.', 'Helical spin ordering: theory of helical spin configurations'],
    ['A. B. Roe and C. D. Smith, Rare-earth permanent magnets, in Handbook of Magnetic Materials, Vol. 12, edited by K. H. J. Buschow (Elsevier, Amsterdam, 1999) pp. 1–87.', 'Rare-earth permanent magnets'],
  ])('a chapter with its own title keeps it: %s', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });
});

// The journal opens with an abbreviation or a known journal word, only a full
// stop ends the title, and whole words between the title and the journal stay in the title.
describe('parseCitation: "Surname, I., Title. Journal ..." keeps added sentences in the title', () => {
  const N = 'Roe, J. and Smith, K.,';
  test.each([
    [`${N} Condensation in the zero range process. A Review. J. Stat. Phys. 113, 389–410 (2003).`, 'Condensation in the zero range process. A Review'],
    [`${N} Condensation in the zero range process. Reply. J. Stat. Phys. 113, 389–410 (2003).`, 'Condensation in the zero range process. Reply'],
    [`${N} Condensation in the zero range process. New Results. J. Stat. Phys. 113, 389–410 (2003).`, 'Condensation in the zero range process. New Results'],
    [`${N} Condensation in the zero range process. A New Approach. Physica A 113, 389–410 (2003).`, 'Condensation in the zero range process. A New Approach'],
    [`${N} Spin Glasses, Random Fields and Disorder. J. Stat. Phys. 113, 389–410 (2003).`, 'Spin Glasses, Random Fields and Disorder'],
    [`${N} Exact Results for Random Walks, Exclusion and Zero Range Models. J. Stat. Phys. 133, 100–120 (2008).`, 'Exact Results for Random Walks, Exclusion and Zero Range Models'],
    [`${N} Scaling Limits of Interacting Particle Systems. A Survey. Cambridge University Press, Cambridge (1999).`, 'Scaling Limits of Interacting Particle Systems. A Survey'],
    [`${N} Scaling Limits of Interacting Particle Systems. Lecture Notes. Oxford University Press, Oxford (1999).`, 'Scaling Limits of Interacting Particle Systems. Lecture Notes'],
  ])('%s', (text, title) => {
    expect(parseCitation(ref(text)).title).toBe(title);
  });
});
