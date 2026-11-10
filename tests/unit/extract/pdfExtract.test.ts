import { describe, expect, test } from 'vitest';
import { titleSimilarity } from '../../../src/core/normalize';
import { extractArxivReferences } from '../../../src/extract/arxivHtml';
import { extractPdfReferences } from '../../../src/extract/pdfReferences';
import { PdfReadError } from '../../../src/extract/readError';
import { pageBytes, pageText, parseHtml } from '../helpers/pages';

// Real arXiv PDFs read with pdf.js's legacy build in Node. The counts are recorded in
// tests/fixtures/pages/README.md with how each was confirmed.

const year = /\b(?:19|20)\d{2}[a-z]?\b/;

const pgw = await extractPdfReferences(pageBytes('arxiv-2402.03664v5-numeric.pdf'));
const sand = await extractPdfReferences(pageBytes('arxiv-2503.00260-twocol-numeric.pdf'));
const decoupling = await extractPdfReferences(pageBytes('arxiv-2503.00258-twocol-authoryear.pdf'));
const etf = await extractPdfReferences(pageBytes('arxiv-2610.39097-authoryear.pdf'));
const ddn = await extractPdfReferences(pageBytes('iclr-2401.00036-authoryear.pdf'));

describe('extractPdfReferences: numeric labels, one column (Partial Gromov-Wasserstein Metric)', () => {
  test('finds all 71 references with their labels', () => {
    expect(pgw.refs).toHaveLength(71);
    expect(pgw.refs.map((r) => r.label)).toEqual(Array.from({ length: 71 }, (_, i) => `[${i + 1}]`));
    expect(pgw.refs[0]?.text).toBe('Cedric Villani. Optimal transport: old and new. Springer, 2009.');
    expect(pgw.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('agrees with the same bibliography read from arXiv HTML', () => {
    const html = extractArxivReferences(parseHtml(pageText('arxiv-2402.03664v5.html')));
    expect(html).toHaveLength(pgw.refs.length);
    pgw.refs.forEach((ref, i) => {
      expect(titleSimilarity(ref.text, html[i]?.text ?? ''), `reference ${i + 1}: ${ref.text}`).toBeGreaterThanOrEqual(0.9);
    });
  });
});

describe('extractPdfReferences: numeric labels, two columns (Seeing A 3D World in A Grain of Sand)', () => {
  test('finds the 42 references in reading order across both columns', () => {
    expect(sand.refs).toHaveLength(42);
    expect(sand.refs.map((r) => r.label)).toEqual(Array.from({ length: 42 }, (_, i) => `[${i + 1}]`));
    expect(sand.refs[0]?.text).toBe('Byeongjoo Ahn, Ioannis Gkioulekas, and Aswin C Sankaranarayanan. Kaleidoscopic structured light. ACM TOG, 40 (6):1–15, 2021. 2, 3');
    expect(sand.refs[41]?.text).toBe('Zehao Zhu, Zhiwen Fan, Yifan Jiang, and Zhangyang Wang. FSGS: Real-time few-shot view synthesis using gaussian splatting. In ECCV, 2024. 2, 7, 10, 11');
  });

  test('every entry looks like one reference', () => {
    for (const ref of sand.refs) {
      expect(ref.text, ref.label).toMatch(year);
      expect(ref.text.length, ref.label).toBeLessThan(400);
      expect(ref.text, ref.label).not.toMatch(/^\[|\s{2}/);
    }
    expect(sand.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('extractPdfReferences: author-year, two columns, hanging indent (Decoupling Content and Expression)', () => {
  test('finds the 67 references and stops before the appendix', () => {
    expect(decoupling.refs).toHaveLength(67);
    expect(decoupling.refs[0]?.text.startsWith('Mervat Abassy, Kareem Elozeiri, Alexander Aziz, Minh Ta, Raj Tomar')).toBe(true);
    expect(decoupling.refs[66]?.text.startsWith('Zoie Zhao, Sophie Song, Bridget Duah')).toBe(true);
    expect(decoupling.refs[0]?.label).toBe('[1]');
    expect(decoupling.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('agrees with the same bibliography read from arXiv HTML', () => {
    const html = extractArxivReferences(parseHtml(pageText('arxiv-2503.00258.html')));
    expect(html).toHaveLength(67);
    decoupling.refs.forEach((ref, i) => {
      expect(titleSimilarity(ref.text, html[i]?.text ?? ''), `reference ${i + 1}: ${ref.text}`).toBeGreaterThanOrEqual(0.9);
    });
  });
});

describe('extractPdfReferences: one-column author-year styles', () => {
  // The list runs over a page break, and each page ends with its page number right under the last entry.
  test('ETF paper: 21 entries in surname-first style, with the page numbers left out', () => {
    expect(etf.refs).toHaveLength(21);
    expect(etf.refs[0]?.text).toBe('Avellaneda, M. and Zhang, S. J. (2010). Path-dependence of leveraged ETF returns. SIAM Journal on Financial Mathematics, 1(1):586–603.');
    expect(etf.refs[1]?.text).toBe('Ayres, I. and Nalebuff, B. (2014). Practical applications of diversification across time. Practical Applications, 1(4):1–4.');
    expect(etf.refs[20]?.text).toBe('Vanguard (2026). 50 years, 50 facts: Indexing since 1976. Vanguard corporate website.');
    expect(etf.refs.every((r) => year.test(r.text))).toBe(true);
    expect(etf.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('DDN (ICLR): 43 entries, web addresses intact, the running head left out', () => {
    expect(ddn.refs).toHaveLength(43);
    expect(ddn.refs[5]?.text).toContain('URL http://arxiv.org/abs/2012.09841.');
    expect(ddn.refs[21]?.text).toContain('URL https://doi.org/10.5281/zenodo.4431043.');
    expect(ddn.refs.map((r) => r.text).join(' ')).not.toMatch(/Published as a conference paper/);
    expect(ddn.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('DDN agrees with the same bibliography read from arXiv HTML', () => {
    const html = extractArxivReferences(parseHtml(pageText('arxiv-2401.00036.html')));
    expect(html).toHaveLength(43);
    ddn.refs.forEach((ref, i) => {
      expect(titleSimilarity(ref.text, html[i]?.text ?? ''), `reference ${i + 1}: ${ref.text}`).toBeGreaterThanOrEqual(0.85);
    });
  });
});

describe('extractPdfReferences: the input', () => {
  test('the caller keeps a usable buffer, so the same bytes can be read again', async () => {
    const bytes = pageBytes('arxiv-2610.39097-authoryear.pdf');
    const size = bytes.byteLength;
    await extractPdfReferences(bytes);
    expect(bytes.byteLength).toBe(size);
    expect((await extractPdfReferences(bytes)).refs).toHaveLength(21);
  });

  test('a PDF without a reference list gives no references and zero confidence', async () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 44>>stream',
      'BT /F1 12 Tf 72 700 Td (Just one line.) Tj ET',
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R/Size 6>>',
      '%%EOF',
    ].join('\n');
    const data = new TextEncoder().encode(pdf);
    expect(await extractPdfReferences(data.buffer as ArrayBuffer)).toEqual({ refs: [], confidence: 0 });
  });

  test.each([
    ['empty', new ArrayBuffer(0)],
    ['not a PDF', new TextEncoder().encode('<html>hello</html>').buffer as ArrayBuffer],
    ['a truncated PDF', pageBytes('arxiv-2610.39097-authoryear.pdf').slice(0, 2000)],
  ])('%s is rejected with a plain message', async (_name, data) => {
    const error = await extractPdfReferences(data).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfReadError);
    expect((error as PdfReadError).message).toBe('This file could not be read as a PDF');
  });
});
