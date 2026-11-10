import { describe, expect, test } from 'vitest';
import { authorOverlap, foldGermanSpelling, normalizeTitle, plainQueryText, surnameForms, surnamesFrom, titleSimilarity } from '../../../src/core/normalize';

describe('normalizeTitle', () => {
  test('ignores case, trailing punctuation, line breaks and dash style', () => {
    expect(normalizeTitle('Learning phrase representations using rnn encoder-decoder for\nstatistical machine translation.')).toBe(
      normalizeTitle('Learning Phrase Representations using RNN Encoder–Decoder for Statistical Machine Translation'),
    );
  });

  test('resolves LaTeX accents, math and ligatures', () => {
    expect(normalizeTitle('Schr\\"odinger bridges for $\\ell_1$ ﬁne-tuning')).toBe('schrodinger bridges for l1 fine tuning');
    expect(normalizeTitle("Na{\\\"i}ve Bayes and {\\'E}cole {\\c C}elik")).toBe('naive bayes and ecole celik');
    expect(normalizeTitle('{BERT}: \\textit{Pre-training}')).toBe('bert pre training');
  });

  test('folds diacritics and letters that do not decompose', () => {
    expect(normalizeTitle('Schrödinger, Łukasiewicz and Straße')).toBe('schrodinger lukasiewicz and strasse');
  });

  test('joins a word split by a hyphen at a line break', () => {
    expect(normalizeTitle('transfor-\nmers for text')).toBe('transformers for text');
  });

  test('is empty for empty or punctuation-only input', () => {
    expect(normalizeTitle('')).toBe('');
    expect(normalizeTitle(' .,; ')).toBe('');
  });
});

describe('titleSimilarity', () => {
  test('matches the same title written in LaTeX and in Unicode', () => {
    expect(titleSimilarity('Schr\\"odinger bridges for $\\ell_1$ ﬁne-tuning', 'Schrödinger Bridges for ℓ1 Fine-Tuning')).toBeGreaterThanOrEqual(0.9);
  });

  test('tolerates a hyphen broken across lines', () => {
    expect(titleSimilarity('pre-\ntraining of deep bidirectional transformers', 'Pre-training of Deep Bidirectional Transformers')).toBeGreaterThanOrEqual(0.95);
  });

  test('is 1 for identical titles and 0 when nothing is shared', () => {
    expect(titleSimilarity('Deep Residual Learning', 'deep residual learning.')).toBe(1);
    expect(titleSimilarity('aaaa bbbb', 'cccc dddd')).toBe(0);
  });

  test('scores a different paper with a similar title as clearly lower', () => {
    expect(titleSimilarity('Attention is all you need', 'Dataflow is all you need')).toBeLessThan(0.75);
  });

  test('stays high for a small typo or a dropped word, low for unrelated titles', () => {
    expect(titleSimilarity('Generative adversarial networks', 'Generative adverserial networks')).toBeGreaterThan(0.85);
    expect(titleSimilarity('Deep residual learning for image recognition', 'Deep residual learning for image recognition in video')).toBeGreaterThan(0.75);
    expect(titleSimilarity('Deep residual learning', 'A survey of graph neural networks')).toBeLessThan(0.4);
  });

  describe('subtitles and truncated titles', () => {
    const resnetFull = 'Deep Residual Learning for Image Recognition';
    const bertFull = 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding';

    test('a one-word main title is too weak to match a long title', () => {
      expect(titleSimilarity('BERT: Pre-training of deep bidirectional transformers for language understanding', 'BERT')).toBeLessThan(0.75);
    });

    test('a title cited without its leading name still verifies', () => {
      expect(titleSimilarity('Pre-training of deep bidirectional transformers for language understanding', bertFull)).toBeGreaterThanOrEqual(0.9);
    });

    test('a title cited without its subtitle still verifies, in either direction', () => {
      expect(titleSimilarity('Attention is all you need', 'Attention Is All You Need: a survey of variants')).toBeGreaterThanOrEqual(0.9);
      expect(titleSimilarity('Attention Is All You Need: a survey of variants', 'Attention is all you need')).toBeGreaterThanOrEqual(0.9);
      expect(titleSimilarity('Foo bar baz \u2014 an extended study', 'Foo bar baz')).toBeGreaterThanOrEqual(0.9);
    });

    test('a truncated title is close but not verified', () => {
      expect(titleSimilarity('Deep residual learning', resnetFull)).toBeGreaterThanOrEqual(0.75);
      expect(titleSimilarity('Deep residual learning', resnetFull)).toBeLessThan(0.9);
    });

    test('a title cut short stays below verified however much of it survives', () => {
      expect(titleSimilarity('Deep residual learning for image', resnetFull)).toBeGreaterThanOrEqual(0.75);
      expect(titleSimilarity('Deep residual learning for image', resnetFull)).toBeLessThan(0.9);
      expect(titleSimilarity('Deep residual learning for image recognition', `${resnetFull} in video`)).toBeLessThan(0.9);
    });

    test('two different subtitles on the same main title do not verify', () => {
      expect(titleSimilarity('Deep Learning for Time Series: A Survey', 'Deep Learning for Time Series: Applications to Finance')).toBeLessThan(0.9);
    });

    test('a two-word fragment is not treated as a contained title', () => {
      expect(titleSimilarity('Deep learning', resnetFull)).toBeLessThan(0.75);
    });
  });

  test('returns 0 when either title is empty', () => {
    expect(titleSimilarity('', 'Something')).toBe(0);
    expect(titleSimilarity('', '')).toBe(0);
  });

  test('copes with very long input', () => {
    const long = 'word '.repeat(5000);
    const start = performance.now();
    expect(titleSimilarity(long, long)).toBe(1);
    // One extra trailing word makes it a cut-short title: close, never verified.
    expect(titleSimilarity(long, long + 'x')).toBeLessThan(0.9);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('surnamesFrom', () => {
  test('reads "First Last" lists and keeps surname particles', () => {
    expect(surnamesFrom('Kyunghyun Cho, Bart van Merrienboer, Caglar Gulcehre, and Yoshua Bengio.')).toEqual([
      'cho',
      'van merrienboer',
      'gulcehre',
      'bengio',
    ]);
  });

  test('reads "Last, F." lists', () => {
    expect(surnamesFrom('Vaswani, A., Shazeer, N. and Parmar, N.')).toEqual(['vaswani', 'shazeer', 'parmar']);
  });

  test('reads "Last, First and Last, First" lists', () => {
    expect(surnamesFrom('Bengio, Yoshua and Courville, Aaron')).toEqual(['bengio', 'courville']);
  });

  test('reads "F. Last" and "Last F" initials styles', () => {
    expect(surnamesFrom('A. Vaswani, N. Shazeer, J.-P. Smith')).toEqual(['vaswani', 'shazeer', 'smith']);
    expect(surnamesFrom('Vaswani A, Shazeer N')).toEqual(['vaswani', 'shazeer']);
  });

  test('folds accents and LaTeX, and drops "et al."', () => {
    expect(surnamesFrom('Jürgen Schmidhuber, Sepp Hochreiter et al.')).toEqual(['schmidhuber', 'hochreiter']);
    expect(surnamesFrom('Erwin Schr\\"odinger and Jos{\\\'e} Garc{\\\'i}a')).toEqual(['schrodinger', 'garcia']);
  });

  test('returns an empty list for empty input', () => {
    expect(surnamesFrom('')).toEqual([]);
    expect(surnamesFrom('  .  ')).toEqual([]);
  });
});

describe('surnameForms', () => {
  test('the whole name, the name without particles, and each part of a multi-word name', () => {
    expect(surnameForms('van der berg')).toEqual(expect.arrayContaining(['van der berg', 'berg']));
    expect(surnameForms('da silva')).toEqual(expect.arrayContaining(['da silva', 'silva']));
    expect(surnameForms('garcia perez')).toEqual(expect.arrayContaining(['garcia perez', 'garcia', 'perez']));
    expect(surnameForms('chen')).toEqual(['chen']);
    // Forms come German-folded, the same way the text they are compared with is.
    expect(surnameForms('roe')).toEqual(['ro']);
  });

  test('particles and filler words are never forms on their own', () => {
    expect(surnameForms('van der berg')).not.toContain('van');
    expect(surnameForms('the atlas collaboration')).not.toContain('the');
  });

  test('German spellings fold the same way on both sides', () => {
    expect(foldGermanSpelling('mueller')).toBe(foldGermanSpelling('muller'));
    expect(surnameForms('mueller')).toContain('muller');
    expect(foldGermanSpelling('j mueller and k schroeder')).toBe('j muller and k schroder');
  });
});

describe('authorOverlap', () => {
  test('ignores a surname particle on either side', () => {
    expect(authorOverlap(['cho', 'van merrienboer', 'gulcehre'], ['cho', 'merrienboer', 'gulcehre', 'bougares'])).toBeCloseTo(1);
    expect(authorOverlap(['merrienboer'], ['van merrienboer'])).toBeCloseTo(1);
  });

  test('is the fraction of the first three cited surnames found', () => {
    expect(authorOverlap(['smith', 'jones', 'lee', 'kim'], ['smith', 'jones', 'kim'])).toBeCloseTo(2 / 3);
    expect(authorOverlap(['smith', 'jones'], ['smith'])).toBeCloseTo(0.5);
    expect(authorOverlap(['smith'], ['wang'])).toBe(0);
  });

  test('is 1 when nothing was cited and 0 when the record has no authors', () => {
    expect(authorOverlap([], ['smith'])).toBe(1);
    expect(authorOverlap(['smith'], [])).toBe(0);
  });
});

describe('surnamesFrom on hostile input', () => {
  test('a very long run of whitespace does not stall the parser', () => {
    const hostile = `Smith J, ${' '.repeat(20_000)}et al${' '.repeat(20_000)}and others`;
    const started = performance.now();
    const surnames = surnamesFrom(hostile);
    expect(performance.now() - started).toBeLessThan(100);
    expect(surnames).toContain('smith');
  });

  test('ordinary whitespace (tabs, newlines, runs of spaces) still parses', () => {
    expect(surnamesFrom('Ashish  Vaswani,\n\tNoam   Shazeer')).toEqual(['vaswani', 'shazeer']);
  });
});

// "\widetilde{O}(T^{-1})" must not fold to "widetildeo t 1", which no arXiv title query matches. A macro with an argument leaves its argument; one without keeps its name (it may be
// the one word that tells two titles apart), unless it is a symbol or spacing.
describe('TeX macros in titles', () => {
  const MAO = '\\widetilde{O}(T^{-1}) convergence to (coarse) correlated equilibria in full-information general-sum Markov games';

  test('a macro with an argument keeps the argument and drops its name', () => {
    expect(normalizeTitle(MAO)).toBe('o t 1 convergence to coarse correlated equilibria in full information general sum markov games');
    expect(normalizeTitle('\\tilde{x}, \\hat{\\beta}, \\bar{X} and \\vec{v}')).toBe('x beta x and v');
    expect(normalizeTitle('\\mathcal{O}(n) bounds on \\mathbb{R}^d and \\mathrm{SU}(2)')).toBe('o n bounds on rd and su 2');
    expect(normalizeTitle('\\textit{Pre-training} with \\textsc{Bert} and \\emph{less} \\texttt{code}')).toBe('pre training with bert and less code');
    expect(normalizeTitle('\\sqrt{n}-consistent \\operatorname{Var} estimates')).toBe('n consistent var estimates');
  });

  test('a macro without an argument keeps its name, unless it is a symbol or spacing', () => {
    expect(normalizeTitle('\\NP-hardness and \\PSPACE-completeness of \\eps-nets')).toBe('np hardness and pspace completeness of eps nets');
    expect(normalizeTitle('Rates of $O(\\log n)$ for $\\alpha$-divergences')).toBe('rates of o log n for alpha divergences');
    expect(normalizeTitle('The $\\star$-product and $\\dagger$-categories')).toBe('the product and categories');
    expect(normalizeTitle('Typesetting with \\LaTeX')).toBe('typesetting with latex');
  });

  test('the cited title matches the arXiv record written in TeX and a record written in Unicode', () => {
    expect(titleSimilarity(MAO, '$\\widetilde{O}(T^{-1})$ Convergence to (Coarse) Correlated Equilibria in Full-Information General-Sum Markov Games')).toBe(1);
    expect(titleSimilarity(MAO, 'Õ(T^-1) Convergence to (Coarse) Correlated Equilibria in Full-Information General-Sum Markov Games')).toBeGreaterThanOrEqual(0.95);
  });

  test('an invented title in the same TeX is not the same title', () => {
    expect(titleSimilarity('\\widetilde{O}(\\sqrt{T}) regret for adversarial bandits in general-sum Markov games', MAO)).toBeLessThan(0.9);
  });

  test('plainQueryText folds TeX for a search and leaves every other title as it is', () => {
    expect(plainQueryText(MAO)).toBe('O(T-1) convergence to (coarse) correlated equilibria in full-information general-sum Markov games');
    expect(plainQueryText('On the sandpile group of p_{4}\\times c_{n}')).toBe('On the sandpile group of p4 cn');
    expect(plainQueryText('Schr\\"odinger bridges for $\\ell_1$')).toBe('Schrödinger bridges for l1');
    for (const plain of ['Attention is all you need', 'BERT: Pre-training of deep bidirectional transformers', 'Price ~ $5 (or less)?'.replace('$', 'USD')]) expect(plainQueryText(plain)).toBe(plain);
  });
});
