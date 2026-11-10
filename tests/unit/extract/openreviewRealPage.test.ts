import { describe, expect, test } from 'vitest';
import { readOpenReviewPage } from '../../../src/extract/openreviewPage';
import { pageText, parseHtml as parseInert } from '../helpers/pages';

// A real OpenReview forum page (ICLR 2021, legacy forum layout), saved from a browser that was not
// signed in and trimmed (tests/fixtures/pages/README.md). Its data comes as Next.js app-router chunks,
// `self.__next_f.push([1,"..."])`, not as a `__NEXT_DATA__` script, and the paper's own "Readers:" line
// sits in the forum note's header, `#note_<forumId>`.

const FORUM = 'YicbFdNTTy';
const TITLE = 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale';
const FIXTURE = 'openreview-iclr2021-legacy-forum.html';
const REAL = pageText(FIXTURE);

function parseAt(html: string, url = `https://openreview.net/forum?id=${FORUM}`): Document {
  const doc = parseInert(html);
  Object.defineProperty(doc, 'URL', { value: url, configurable: true });
  return doc;
}
const read = (html: string) => readOpenReviewPage(parseAt(html));

// The page's data scripts, decoded: one string per `self.__next_f.push([1, "..."])`.
const PUSH = /<script>self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
function chunksOf(html: string): string[] {
  return [...html.matchAll(PUSH)].map((m) => {
    const value: unknown = JSON.parse(m[1] ?? '');
    if (!Array.isArray(value) || typeof value[1] !== 'string') throw new Error('unexpected push');
    return value[1];
  });
}
const pushScript = (chunk: string) =>
  `<script>self.__next_f.push(${JSON.stringify([1, chunk]).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')})</script>`;

/** The real page with its data chunks replaced by `edit(chunks)`. */
function withChunks(edit: (chunks: string[]) => string[], html = REAL): string {
  const chunks = edit(chunksOf(html));
  const first = html.search(PUSH);
  const stripped = html.replace(PUSH, '');
  return stripped.slice(0, first) + chunks.map(pushScript).join('') + stripped.slice(first);
}
/** The same edit applied to the joined row text. */
const editRows = (edit: (rows: string) => string) => withChunks((chunks) => [edit(chunks.join(''))]);

const OPEN = '"readers":["everyone"],"nonreaders":[]';
const restrictNote = (rows: string) => {
  if (!rows.includes(OPEN)) throw new Error('fixture changed');
  return rows.replace(OPEN, '"readers":["ICLR.cc/2021/Conference/Paper1909/Reviewers"],"nonreaders":[]');
};
const HEADER_LABEL = 'Readers: <span class="readers-icon glyphicon glyphicon-globe"></span> Everyone';
const relabelHeader = (html: string, label: string) => {
  // The first "Readers:" item of the page is the forum note's own; the others are replies'.
  if (!html.includes(HEADER_LABEL)) throw new Error('fixture changed');
  return html.replace(HEADER_LABEL, label);
};
const noData = (html: string) => html.replace(PUSH, '');
const row = (id: string, value: unknown) => `${id}:${JSON.stringify(value)}\n`;
const copy = (readers: unknown, title = TITLE) => ({ id: FORUM, forum: FORUM, readers, content: { title } });

describe('a real forum page (legacy layout)', () => {
  test('the fixture holds what the reader relies on', () => {
    const doc = parseAt(REAL);
    expect(doc.getElementById('__NEXT_DATA__')).toBeNull();
    expect(doc.querySelector('.readers')).toBeNull();
    expect(doc.getElementById(`note_${FORUM}`)).not.toBeNull();
    expect(chunksOf(REAL).join('')).toContain(`"id":"${FORUM}"`);
    // The replies carry "Readers: Everyone" too, and the filter row a "Visible To" choice of "everyone".
    expect(REAL.split('Readers: <span').length - 1).toBe(3);
    expect(REAL).toContain('value="everyone"');
  });

  test('is public, with the title from its data and the forum id from its address', () => {
    expect(read(REAL)).toEqual({ title: TITLE, forumId: FORUM, visibility: 'public' });
  });

  test('a forum address with a note id still reads it', () => {
    const doc = parseAt(REAL, `https://openreview.net/forum?id=${FORUM}&noteId=wQtnbEGYd4b`);
    expect(readOpenReviewPage(doc)).toEqual({ title: TITLE, forumId: FORUM, visibility: 'public' });
  });

  test('another forum id in the address is unclear, not public', () => {
    const doc = parseAt(REAL, 'https://openreview.net/forum?id=otherId99');
    expect(readOpenReviewPage(doc)).toEqual({ forumId: 'otherId99', visibility: 'unclear' });
  });

  test('the forum note readable by a group only is confidential and gives no title', () => {
    const result = read(editRows(restrictNote));
    expect(result).toEqual({ forumId: FORUM, visibility: 'confidential' });
  });

  test('a restricted copy of the note in a later chunk is confidential', () => {
    const html = withChunks((chunks) => [...chunks, row('30', copy(['ICLR.cc/2021/Conference/Program_Chairs']))]);
    expect(read(html)).toEqual({ forumId: FORUM, visibility: 'confidential' });
  });

  test('a restricted copy split over two chunks is still found', () => {
    const extra = row('30', copy(['ICLR.cc/2021/Conference/Program_Chairs']));
    const html = withChunks((chunks) => [...chunks, extra.slice(0, 20), extra.slice(20)]);
    expect(read(html).visibility).toBe('confidential');
  });

  test('the data still decides when its rows are cut at other places', () => {
    const joined = chunksOf(REAL).join('');
    const pieces = Array.from({ length: Math.ceil(joined.length / 97) }, (_, i) => joined.slice(i * 97, (i + 1) * 97));
    expect(read(withChunks(() => pieces))).toEqual({ title: TITLE, forumId: FORUM, visibility: 'public' });
  });

  test('a header that says "Readers: Program Committee" is not public', () => {
    const html = relabelHeader(REAL, 'Readers: Program Committee');
    expect(read(html)).toEqual({ forumId: FORUM, visibility: 'unclear' });
    // With no data on the page the header alone decides, and it says restricted.
    expect(read(noData(html))).toEqual({ forumId: FORUM, visibility: 'confidential' });
  });

  test('a restricted data copy and a header that says Everyone are confidential', () => {
    expect(read(editRows(restrictNote)).visibility).toBe('confidential');
  });

  test('replies and the reply filter that say everyone never make a restricted forum note public', () => {
    const html = relabelHeader(editRows(restrictNote), 'Readers: Program Committee');
    expect(read(html)).toEqual({ forumId: FORUM, visibility: 'confidential' });
  });

  test('without data and without the header line, the replies and filters decide nothing', () => {
    expect(read(relabelHeader(noData(REAL), ''))).toEqual({ forumId: FORUM, visibility: 'unclear' });
    const noHeader = noData(REAL).replace(`id="note_${FORUM}"`, 'id="note_elsewhere1"');
    expect(read(noHeader)).toEqual({ forumId: FORUM, visibility: 'unclear' });
  });

  test('without data, the header line alone makes the page public, with the citation_title meta', () => {
    expect(read(noData(REAL))).toEqual({ title: TITLE, forumId: FORUM, visibility: 'public' });
  });

  test('a second "Readers:" line inside the header must agree', () => {
    const forged = `<div class="meta_row"><span class="item">Readers: Program Committee</span></div><div class="note_contents">`;
    const html = noData(REAL).replace('<div class="note_contents">', forged);
    expect(read(html).visibility).toBe('confidential');
  });

  test('a readers line in math or rendered markdown is ignored when the header has none', () => {
    const mathjaxReaders =
      `<mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX" aria-hidden="true"><mjx-mtext class="mjx-n readers">` +
      `<mjx-utext variant="-explicitFont">Readers: Everyone</mjx-utext></mjx-mtext></mjx-math><mjx-assistive-mml>` +
      `<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext class="readers">Readers: Everyone</mtext></math></mjx-assistive-mml></mjx-container>`;
    const noHeader = relabelHeader(noData(REAL), 'Program Committee');
    const target = '<span class="note_content_value markdown-rendered">';
    expect(noHeader).toContain(target);
    expect(read(noHeader.replace(target, `${target}<p>${mathjaxReaders}</p>`))).toEqual({ forumId: FORUM, visibility: 'unclear' });
    const markdown = '<div class="markdown-rendered"><p class="readers">Readers: Everyone</p></div>';
    expect(read(noHeader.replace(target, `${target}${markdown}`))).toEqual({ forumId: FORUM, visibility: 'unclear' });
  });

  test('a header id inside math is not the header', () => {
    const forged = `<mjx-container class="MathJax"><mjx-mrow id="note_${FORUM}" class="note meta_row"><mjx-mtext class="item">Readers: Everyone</mjx-mtext></mjx-mrow></mjx-container>`;
    const html = noData(REAL).replace(`id="note_${FORUM}"`, 'id="note_elsewhere1"').replace('Abstract text (placeholder).', forged);
    expect(html).toContain(forged);
    expect(read(html)).toEqual({ forumId: FORUM, visibility: 'unclear' });
  });

  test('a "Readers: Everyone" line written into a field of the note is ignored', () => {
    const fake = '<span class="note_content_value"><span class="meta_row"><span class="item">Readers: Everyone</span></span></span>';
    const html = relabelHeader(noData(REAL), '').replace('Abstract text (placeholder).', fake);
    expect(read(html)).toEqual({ forumId: FORUM, visibility: 'unclear' });
  });

  describe('chunks that cannot be read in full are unclear, never public', () => {
    test('a truncated chunk', () => {
      const html = withChunks((chunks) => chunks.map((c) => (c.includes(`"forumNote"`) ? c.slice(0, Math.floor(c.length / 2)) : c)));
      expect(read(html)).toEqual({ forumId: FORUM, visibility: 'unclear' });
    });

    test('a chunk whose last row has no line end', () => {
      expect(read(editRows((rows) => rows.replace(/\n$/, '')))).toEqual({ forumId: FORUM, visibility: 'unclear' });
    });

    test('a row that is not JSON', () => {
      expect(read(withChunks((chunks) => [...chunks, '31:{"id":"x",\n']))).toEqual({ forumId: FORUM, visibility: 'unclear' });
    });

    test('a data script that is not a plain push', () => {
      const html = REAL.replace('</body>', '<script>self.__next_f.push([1,"30:null\\n"]); doSomething()</script></body>');
      expect(read(html).visibility).toBe('unclear');
    });

    test('a push of a kind the reader does not read', () => {
      const html = REAL.replace('</body>', '<script>self.__next_f.push([3,"AAAA"])</script></body>');
      expect(read(html).visibility).toBe('unclear');
    });

    test('a text row longer than what follows it', () => {
      expect(read(withChunks((chunks) => [...chunks, '32:Tfff,short']))).toEqual({ forumId: FORUM, visibility: 'unclear' });
    });

    test('a restricted label still wins over unreadable chunks', () => {
      const html = relabelHeader(withChunks((chunks) => [...chunks, '31:{oops\n']), 'Readers: Program Committee');
      expect(read(html).visibility).toBe('confidential');
    });

    test('chunks over the size limit', () => {
      const pad = `33:"${'x'.repeat(11 * 1024 * 1024)}"\n`;
      expect(read(withChunks((chunks) => [...chunks, pad]))).toEqual({ forumId: FORUM, visibility: 'unclear' });
    });

    test('a note of another forum in the chunks', () => {
      const other = { id: 'zzz999QQQ', forum: 'zzz999QQQ', readers: ['everyone'], content: { title: 'Other' } };
      expect(read(withChunks((chunks) => [...chunks, row('34', other)])).visibility).toBe('unclear');
    });
  });

  describe('the search of the chunks', () => {
    const nest = (inner: unknown, levels: number): unknown => {
      let o = inner;
      for (let i = 0; i < levels; i++) o = ['$', 'div', null, { children: o }];
      return o;
    };

    test('a restricted copy deep in a React tree (as deep as the page itself nests) is found', () => {
      const html = withChunks((chunks) => [...chunks, row('38', nest(copy(['Reviewers']), 20))]);
      expect(read(html).visibility).toBe('confidential');
    });

    test('a tree deeper than the search goes is unclear, never public', () => {
      const html = withChunks((chunks) => [...chunks, row('39', nest(copy(['Reviewers']), 40))]);
      expect(read(html)).toEqual({ forumId: FORUM, visibility: 'unclear' });
    });

    test('the setup script may also say there is no form state', () => {
      const html = REAL.replace('.push([0])</script>', '.push([0]);self.__next_f.push([2,null])</script>');
      expect(html).not.toBe(REAL);
      expect(read(html)).toEqual({ title: TITLE, forumId: FORUM, visibility: 'public' });
    });
  });

  describe('text rows', () => {
    test('a text row (length in UTF-8 bytes, no line end) is skipped and the rows after it are read', () => {
      const text = 'Abstract with é and 𝔼 and a line\nbreak';
      const bytes = new TextEncoder().encode(text).length;
      const html = withChunks((chunks) => [`35:T${bytes.toString(16)},${text}`, ...chunks]);
      expect(read(html)).toEqual({ title: TITLE, forumId: FORUM, visibility: 'public' });
    });

    test('a note written inside text is not a note, and cannot hide the restricted one after it', () => {
      const text = `x\n36:${JSON.stringify(copy(['everyone']))}\n`;
      const bytes = new TextEncoder().encode(text).length;
      const html = withChunks((chunks) => [`35:T${bytes.toString(16)},${text}`, restrictNote(chunks.join(''))]);
      expect(read(html).visibility).toBe('confidential');
    });

    test('a wrong text length that swallows the note row leaves the page unclear, not public', () => {
      const html = withChunks((chunks) => [`35:T10,ab`, ...chunks]);
      expect(read(html).visibility).not.toBe('public');
    });
  });

  describe('titles in the chunks', () => {
    const retitle = (title: string) => editRows((rows) => rows.replace(`"title":"${TITLE}"`, () => `"title":"${title}"`));

    test('a title that starts with "$" is written "$$" and read back with one', () => {
      expect(read(retitle('$$5 Ways'))).toEqual({ title: '$5 Ways', forumId: FORUM, visibility: 'public' });
    });

    test('a title that is a reference to another row gives no title', () => {
      const result = read(retitle('$1c'));
      expect(result.visibility).toBe('public');
      expect(result).not.toHaveProperty('title');
    });

    test('copies in the chunks that disagree on the title give none', () => {
      const html = withChunks((chunks) => [...chunks, row('37', copy(['everyone'], 'Some Other Title'))]);
      const result = read(html);
      expect(result.visibility).toBe('public');
      expect(result).not.toHaveProperty('title');
    });
  });

  test('both kinds of page data are read: a restricted copy in either one wins', () => {
    const nextData = (readers: unknown) =>
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { forumNote: copy(readers) } } })}</script>`;
    expect(read(REAL.replace('</body>', `${nextData(['everyone'])}</body>`)).visibility).toBe('public');
    expect(read(REAL.replace('</body>', `${nextData(['Reviewers'])}</body>`)).visibility).toBe('confidential');
    expect(read(editRows(restrictNote).replace('</body>', `${nextData(['everyone'])}</body>`)).visibility).toBe('confidential');
  });
});

// A real forum page of the newer layout (ICLR 2025), saved the same way and trimmed. The tab reached
// it from the venue page inside the site, so its chunks are the venue page's (they include a text
// row) and hold no forum note: the label in the forum note's header decides alone. Its text is
// "Everyone", with no "Readers:" prefix.
describe('a real forum page (newer layout)', () => {
  const V2_FORUM = 'imT03YXlG2';
  const V2_TITLE = 'Sparse autoencoders reveal selective remapping of visual concepts during adaptation';
  const V2 = pageText('openreview-iclr2025-forum.html');
  const readV2 = (html: string, url = `https://openreview.net/forum?id=${V2_FORUM}`) => readOpenReviewPage(parseAt(html, url));
  const V2_LABEL = '<span class="glyphicon glyphicon-eye-open " aria-hidden="true"></span>Everyone</span><span class="item">';
  const V2_LABEL_ITEM = /<span class="readers item"[^>]*>.*?<\/span>Everyone<\/span>/;
  const relabel = (label: string, html = V2) => {
    // Only the forum note's own readers item is followed by another meta item.
    if (html.split(V2_LABEL).length !== 2) throw new Error('fixture changed');
    return html.replace(V2_LABEL, () => `<span class="glyphicon glyphicon-eye-open " aria-hidden="true"></span>${label}</span><span class="item">`);
  };
  const unlabelled = () => {
    const html = V2.replace(V2_LABEL_ITEM, '');
    if (html === V2) throw new Error('fixture changed');
    return html;
  };
  const v2Copy = (readers: unknown) => ({ id: V2_FORUM, forum: V2_FORUM, readers, content: { title: { value: V2_TITLE } } });

  test('the fixture holds what the reader relies on', () => {
    const doc = parseAt(V2);
    expect(doc.getElementById('__NEXT_DATA__')).toBeNull();
    expect(doc.getElementById(`note_${V2_FORUM}`)).toBeNull();
    expect(doc.querySelectorAll('.forum-note')).toHaveLength(1);
    const rows = chunksOf(V2).join('');
    expect(rows).not.toContain(`"id":"${V2_FORUM}"`);
    expect(rows).toMatch(/\n26:T[0-9a-f]+,/);
    // Replies have their own "Everyone", and the reply filter offers "everyone".
    expect(doc.querySelectorAll('.readers')).toHaveLength(3);
    expect(V2).toContain('value="everyone"');
  });

  test('is public by its label, with the citation_title meta as the title', () => {
    expect(readV2(V2)).toEqual({ title: V2_TITLE, forumId: V2_FORUM, visibility: 'public' });
  });

  test.each([
    ['groups', 'ICLR 2025 Conference Submission14240 Authors, Program Chairs'],
    ['everyone and a group', 'Everyone, Program Chairs'],
    ['a prefixed group', 'Readers: Program Chairs'],
    ['nothing', ''],
    ['everyone with more words', 'Everyone (after the decision)'],
  ])('a header label that names %s is confidential and gives no title', (_name, label) => {
    expect(readV2(relabel(label))).toEqual({ forumId: V2_FORUM, visibility: 'confidential' });
  });

  test('a header label that reads "Readers: Everyone" is public too', () => {
    expect(readV2(relabel('Readers: Everyone')).visibility).toBe('public');
  });

  test('without the header label, replies and the reply filter that say everyone decide nothing', () => {
    expect(readV2(unlabelled())).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
  });

  test('a second forum note on the page is not public', () => {
    const html = V2.replace('<div class="filters-container', '<div class="forum-note"><div class="forum-meta"><span class="readers item">Everyone</span></div></div><div class="filters-container');
    expect(readV2(html).visibility).toBe('confidential');
  });

  test('a readers item written into a field of the note is ignored', () => {
    const fake = '<span class="forum-meta"><span class="readers item">Everyone</span></span>';
    expect(readV2(unlabelled().replace('Abstract text (placeholder).', fake))).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
    expect(readV2(relabel('Program Chairs').replace('Abstract text (placeholder).', fake)).visibility).toBe('confidential');
  });

  test('a forum note whose pdf link names another forum does not speak for this one', () => {
    const html = V2.replace(`class="citation_pdf_url" href="https://openreview.net/pdf?id=${V2_FORUM}"`, `class="citation_pdf_url" href="https://openreview.net/pdf?id=otherId99"`);
    expect(html).not.toBe(V2);
    expect(readV2(html)).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
  });

  test('a page at another forum address is not made public by this note', () => {
    expect(readV2(V2, 'https://openreview.net/forum?id=otherId99')).toEqual({ forumId: 'otherId99', visibility: 'unclear' });
  });

  // The label names no forum, so it counts only when the note's own links (its pdf, Revisions and BibTeX links) name
  // the address's forum and none names another. A tab that still shows paper A after a click on B must not read public.
  describe("the label counts only when the note's own links name this forum", () => {
    const PDF_LINK = /<div class="forum-content-link">[\s\S]*?<\/a><\/div>/;
    const withoutPdfLink = () => {
      const html = V2.replace(PDF_LINK, '');
      if (html === V2 || !html.includes(`revisions?id=${V2_FORUM}`) || !html.includes(`forum?id=${V2_FORUM}#`)) throw new Error('fixture changed');
      return html;
    };
    const withoutOwnLinks = () => withoutPdfLink().replace(`revisions?id=${V2_FORUM}`, 'revisions').replace(`forum?id=${V2_FORUM}#`, 'forum#');

    test('without a pdf link, another forum address still reads unclear (the Revisions and BibTeX links name this note)', () => {
      expect(readV2(withoutPdfLink(), 'https://openreview.net/forum?id=otherId99')).toEqual({ forumId: 'otherId99', visibility: 'unclear' });
    });

    test('without a pdf link, the Revisions and BibTeX links are enough for its own address', () => {
      expect(readV2(withoutPdfLink())).toEqual({ title: V2_TITLE, forumId: V2_FORUM, visibility: 'public' });
    });

    test('a note with none of its own links says nothing', () => {
      expect(readV2(withoutOwnLinks())).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
    });

    test('a Revisions link that names another forum does not speak for this one', () => {
      const html = V2.replace(`revisions?id=${V2_FORUM}`, 'revisions?id=otherId99');
      expect(html).not.toBe(V2);
      expect(readV2(html)).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
    });

    test('links in a field of the note or in a reply are not the note\'s own', () => {
      const own = `<a href="https://openreview.net/pdf?id=${V2_FORUM}">pdf</a>`;
      const html = withoutOwnLinks().replace('Abstract text (placeholder).', own).replace('<p>Reply text (placeholder).</p>', `<p>${own}</p>`);
      expect(readV2(html)).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
    });

    test('a restricted label still wins without the links', () => {
      expect(readV2(relabel('Program Chairs', withoutOwnLinks()))).toEqual({ forumId: V2_FORUM, visibility: 'confidential' });
    });
  });

  // MathJax typesets reply values, and TeX can give a node an id and classes (\cssId, \class). Such a node, with real
  // text in it, must not stand in for the paper's own label.
  describe('math and author-written content never stand in for the label', () => {
    const mathjaxLabel = (id: string) =>
      `<mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX" aria-hidden="true">` +
      `<mjx-mrow id="note_${id}" class="note meta_row"><mjx-mtext class="mjx-n item"><mjx-utext variant="-explicitFont">Readers: Everyone</mjx-utext></mjx-mtext></mjx-mrow>` +
      `</mjx-math><mjx-assistive-mml unselectable="on" display="inline"><math xmlns="http://www.w3.org/1998/Math/MathML">` +
      `<mrow id="note_${id}" class="note meta_row"><mtext class="item">Readers: Everyone</mtext></mrow></math></mjx-assistive-mml></mjx-container>`;
    const REPLY = '<p>Reply text (placeholder).</p>';

    test("a reply's math with id note_<forum> and a readers line does not make an unlabelled page public", () => {
      const html = unlabelled().replace(REPLY, `<p>${mathjaxLabel(V2_FORUM)}</p>`);
      expect(html).not.toBe(unlabelled());
      expect(readV2(html)).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
    });

    test('the real restricted label still wins over it', () => {
      const html = relabel('Program Chairs').replace(REPLY, `<p>${mathjaxLabel(V2_FORUM)}</p>`);
      expect(readV2(html).visibility).toBe('confidential');
    });
  });

  test('a restricted copy of the note in the chunks wins over the label', () => {
    const html = withChunks((chunks) => [...chunks, row('40', v2Copy(['ICLR.cc/2025/Conference/Submission14240/Authors']))], V2);
    expect(readV2(html)).toEqual({ forumId: V2_FORUM, visibility: 'confidential' });
  });

  test('a public copy of the note in the chunks decides, and gives its title', () => {
    const html = withChunks((chunks) => [...chunks, row('40', v2Copy(['everyone']))], V2);
    expect(readV2(html)).toEqual({ title: V2_TITLE, forumId: V2_FORUM, visibility: 'public' });
  });

  test("another forum's note in the chunks (a tab that came from another paper) is unclear", () => {
    const other = { id: 'zzz999QQQ', forum: 'zzz999QQQ', readers: ['everyone'], content: { title: { value: 'Other' } } };
    expect(readV2(withChunks((chunks) => [...chunks, row('41', other)], V2)).visibility).toBe('unclear');
  });

  test('a truncated chunk is unclear, even with the Everyone label', () => {
    const html = withChunks((chunks) => chunks.map((c) => (c.includes('"$L25"') ? c.slice(0, -40) : c)), V2);
    expect(readV2(html)).toEqual({ forumId: V2_FORUM, visibility: 'unclear' });
  });

  test('a text row whose length is wrong is unclear', () => {
    const html = withChunks((chunks) => [chunks.join('').replace(/\n26:T([0-9a-f]+),/, (_m, n: string) => `\n26:T${(parseInt(n, 16) + 5).toString(16)},`)], V2);
    expect(html).not.toBe(V2);
    expect(readV2(html).visibility).toBe('unclear');
  });

  test('the text row is read by its length in bytes, so a row right after it is reached', () => {
    const html = withChunks((chunks) => [chunks.join('').replace('17:["$","$L25"', (m) => `${row('42', v2Copy(['Reviewers']))}${m}`)], V2);
    expect(html).not.toBe(V2);
    expect(readV2(html).visibility).toBe('confidential');
  });
});

// The newer layout loaded directly (ICLR 2025, a hard reload), saved the same way and trimmed. Here the
// chunks are the forum page's own: they hold the forum note (API v2 shape, `content.title.value`) and the
// page's `query` object, `{"id":"<forumId>"}`, which carries the id but is no copy of the note. Data and
// label both say public.
describe('a real forum page (newer layout, loaded directly)', () => {
  const H_FORUM = 'odjMSBSWRt';
  const H_TITLE = 'DarkBench: Benchmarking Dark Patterns in Large Language Models';
  const HARD = pageText('openreview-iclr2025-forum-hard-load.html');
  const readH = (html: string) => readOpenReviewPage(parseAt(html, `https://openreview.net/forum?id=${H_FORUM}`));
  const H_OPEN = '"readers":["everyone"]';
  const H_LABEL = '<span class="glyphicon glyphicon-eye-open " aria-hidden="true"></span>Everyone</span><span class="item">';
  const H_LABEL_ITEM = /<span class="readers item"[^>]*>.*?<\/span>Everyone<\/span>/;
  const editH = (edit: (rows: string) => string) => {
    const html = withChunks((chunks) => [edit(chunks.join(''))], HARD);
    if (html === HARD) throw new Error('fixture changed');
    return html;
  };
  const relabelH = (label: string, html = HARD) => {
    if (html.split(H_LABEL).length !== 2) throw new Error('fixture changed');
    return html.replace(H_LABEL, () => `<span class="glyphicon glyphicon-eye-open " aria-hidden="true"></span>${label}</span><span class="item">`);
  };
  const restrictH = (rows: string) => {
    if (rows.split(H_OPEN).length !== 2) throw new Error('fixture changed');
    return rows.replace(H_OPEN, '"readers":["ICLR.cc/2025/Conference/Submission14257/Authors"]');
  };
  const hCopy = (over: Record<string, unknown>) => ({ id: H_FORUM, forum: H_FORUM, content: { title: { value: H_TITLE } }, ...over });

  test('the fixture holds the note and the query object, both with the forum id', () => {
    const rows = chunksOf(HARD).join('');
    expect(rows.split(`"id":"${H_FORUM}"`)).toHaveLength(3);
    expect(rows).toContain(`"query":{"id":"${H_FORUM}"}`);
    expect(rows).toContain('"forumNote":{');
    expect(parseAt(HARD).querySelectorAll('.forum-note .forum-meta .readers')).toHaveLength(1);
  });

  test('is public, with the title from its data', () => {
    expect(readH(HARD)).toEqual({ title: H_TITLE, forumId: H_FORUM, visibility: 'public' });
  });

  test('data and label agree: each alone also says public', () => {
    expect(readH(HARD.replace(H_LABEL_ITEM, ''))).toEqual({ title: H_TITLE, forumId: H_FORUM, visibility: 'public' });
    expect(readH(HARD.replace(PUSH, ''))).toEqual({ title: H_TITLE, forumId: H_FORUM, visibility: 'public' });
  });

  test('the title comes from the data, not the meta tag, when the data has the note', () => {
    const html = HARD.replace(`<meta name="citation_title" content="${H_TITLE}">`, '<meta name="citation_title" content="META TITLE">');
    expect(html).not.toBe(HARD);
    expect(readH(html).title).toBe(H_TITLE);
  });

  test('the note readable by a group only is confidential and gives no title, whatever the label says', () => {
    expect(readH(editH(restrictH))).toEqual({ forumId: H_FORUM, visibility: 'confidential' });
  });

  test('a header label that names groups, over data that says everyone, is unclear', () => {
    expect(readH(relabelH('Program Chairs, Submission14257 Authors'))).toEqual({ forumId: H_FORUM, visibility: 'unclear' });
  });

  test('a restricted note and a restricted label are confidential', () => {
    const html = relabelH('Submission14257 Authors', editH(restrictH));
    expect(readH(html)).toEqual({ forumId: H_FORUM, visibility: 'confidential' });
  });

  test('one restricted copy among public ones is confidential', () => {
    const html = editH((rows) => `${rows}${row('50', hCopy({ readers: ['ICLR.cc/2025/Conference/Program_Chairs'] }))}`);
    expect(readH(html)).toEqual({ forumId: H_FORUM, visibility: 'confidential' });
  });

  test('a second copy of the note without its own readers is unclear, not public', () => {
    // It has note keys (forum, content), so it is a copy, and a copy whose readers cannot be read is unclear.
    const html = editH((rows) => `${rows}${row('51', hCopy({}))}`);
    expect(readH(html)).toEqual({ forumId: H_FORUM, visibility: 'unclear' });
  });

  test('the query object alone is not a copy: with the note gone the label decides', () => {
    // The note loses its id; only the query object still carries the forum id.
    const html = editH((rows) => rows.replace(`"id":"${H_FORUM}","forum"`, () => `"noteId":"${H_FORUM}","forum"`));
    expect(readH(html)).toEqual({ title: H_TITLE, forumId: H_FORUM, visibility: 'public' });
    expect(readH(relabelH('Program Chairs', html)).visibility).toBe('confidential');
  });
});
