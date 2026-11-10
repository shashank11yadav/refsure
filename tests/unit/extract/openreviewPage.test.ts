import { describe, expect, test } from 'vitest';
import { readOpenReviewPage } from '../../../src/extract/openreviewPage';
import { pageText, parseHtml as parseInert } from '../helpers/pages';

// These pages are written by hand (tests/fixtures/pages/README.md) for cases no real page shows.
// Real forum pages, saved from a browser, are tested in openreviewRealPage.test.ts.

// The reader only trusts a page whose address is an OpenReview forum or pdf page, so every
// document here is given one (the DOM parser makes documents with no address).
function parseHtml(html: string, id = 'abc123XYZ'): Document {
  const doc = parseInert(html);
  Object.defineProperty(doc, 'URL', { value: `https://openreview.net/forum?id=${id}`, configurable: true });
  return doc;
}

const read = (name: string, id = 'abc123XYZ') => readOpenReviewPage(parseHtml(pageText(name), id));

function withNextData(data: unknown, bodyHtml = ''): Document {
  const json = typeof data === 'string' ? data : JSON.stringify(data).replace(/</g, '\\u003c');
  return parseHtml(`<html><head><title>T | OpenReview</title></head><body>${bodyHtml}<script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`);
}

const note = (over: Record<string, unknown> = {}) => ({
  id: 'abc123XYZ',
  forum: 'abc123XYZ',
  readers: ['everyone'],
  content: { title: { value: 'A Title' } },
  ...over,
});
const pageProps = (forumNote: unknown) => ({ props: { pageProps: { forumNote } } });

describe('readOpenReviewPage: hand-made pages', () => {
  test('a note readable by everyone is public, with its title and forum id', () => {
    expect(read('openreview-public.handmade.html', 'abc123XYZ')).toEqual({
      title: 'A Handmade Public Paper',
      forumId: 'abc123XYZ',
      visibility: 'public',
    });
  });

  test('a note with a restricted readers list is confidential and gives no title', () => {
    const result = read('openreview-confidential.handmade.html', 'conf456ABC');
expect(result).toEqual({ forumId: 'conf456ABC', visibility: 'confidential' });
    expect(result).not.toHaveProperty('title');
  });

  test('a page without data or label is unclear', () => {
    expect(read('openreview-nodata.handmade.html')).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
  });

  test('damaged embedded data is unclear, not public', () => {
    expect(read('openreview-malformed.handmade.html')).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
  });

  test('without embedded data, an explicit "Readers: Everyone" label is enough', () => {
    expect(read('openreview-label-only.handmade.html')).toEqual({ title: 'Label Only Paper', forumId: 'abc123XYZ', visibility: 'public' });
  });
});

describe('readOpenReviewPage: hostile pages', () => {
  test('decoy notes and text that say "everyone" do not make a restricted forum note public', () => {
    const result = read('openreview-hostile-decoys.handmade.html', 'hostile789');
    expect(result).toEqual({ forumId: 'hostile789', visibility: 'confidential' });
  });

  test('markup in a title comes back as text, squashed', () => {
    const result = read('openreview-hostile-title.handmade.html', 'pubhost01');
    expect(result.visibility).toBe('public');
    expect(result.title).toBe('<img src=x onerror=alert(1)> Title &amp; <script>alert(2)</script> with odd spacing');
  });

  test('the title is bounded', () => {
    const result = readOpenReviewPage(withNextData(pageProps(note({ content: { title: { value: 'T'.repeat(100_000) } } }))));
    expect(result.title?.length).toBeLessThanOrEqual(500);
  });
});

describe('readOpenReviewPage: embedded data', () => {
  test('older note shape: title is a plain string', () => {
    const result = readOpenReviewPage(withNextData(pageProps(note({ content: { title: 'Old Shape' } }))));
    expect(result).toEqual({ title: 'Old Shape', forumId: 'abc123XYZ', visibility: 'public' });
  });

  test('the forum note is found when it is not at the usual place', () => {
    const result = readOpenReviewPage(withNextData({ props: { pageProps: { other: [{ x: 1 }, { deep: { forumData: note() } }] } } }));
    expect(result).toMatchObject({ visibility: 'public', forumId: 'abc123XYZ' });
  });

  test.each([
    ['readers missing', note({ readers: undefined })],
    ['readers not an array', note({ readers: 'everyone' })],
    ['readers empty', note({ readers: [] })],
    ['readers holds non-strings', note({ readers: [1, null, { a: 'everyone' }] })],
    ['"Everyone" with other capitalisation', note({ readers: ['Everyone'] })],
    ['"everyone" only as a substring', note({ readers: ['not-everyone', 'everyone@example.com'] })],
  ])('%s is not public', (_name, forumNote) => {
    expect(readOpenReviewPage(withNextData(pageProps(forumNote))).visibility).not.toBe('public');
  });

  test('a readers list that holds "everyone" among others is public', () => {
    expect(readOpenReviewPage(withNextData(pageProps(note({ readers: ['everyone', 'ICLR.cc/2027/Conference'] })))).visibility).toBe('public');
  });

  test('an explicit restricted list is confidential, an unreadable shape is unclear', () => {
    expect(readOpenReviewPage(withNextData(pageProps(note({ readers: ['ICLR.cc/2027/Conference/Program_Chairs'] })))).visibility).toBe('confidential');
    expect(readOpenReviewPage(withNextData(pageProps(note({ readers: 'oops' })))).visibility).toBe('unclear');
  });

  test.each([
    ['null', 'null'],
    ['a number', '42'],
    ['an array', '[1,2,3]'],
    ['empty text', ''],
    ['a string', '"everyone"'],
    ['an object with no note', '{"props":{"pageProps":{}}}'],
    ['trailing junk', '{"props":{"pageProps":{"forumNote":{"id":"abc123XYZ","forum":"abc123XYZ","readers":["everyone"]}}}} junk'],
  ])('embedded data that is %s is unclear', (_name, json) => {
    expect(readOpenReviewPage(withNextData(json)).visibility).toBe('unclear');
  });

  test('a reply that is readable by everyone does not make a restricted forum note public', () => {
    const data = {
      props: { pageProps: { forumNote: note({ readers: ['restricted/group'] }), replies: [note({ id: 'reply0001', replyto: 'abc123XYZ', readers: ['everyone'] })] } },
    };
    expect(readOpenReviewPage(withNextData(data)).visibility).toBe('confidential');
  });

  test('when forum-note candidates disagree the page is not public', () => {
    const data = { props: { pageProps: { a: note(), b: note({ readers: ['restricted/group'] }) } } };
    expect(readOpenReviewPage(withNextData(data)).visibility).toBe('confidential');
  });

  test('two different forum notes make the page unclear', () => {
    const data = { props: { pageProps: { a: note(), b: note({ id: 'zzz999QQQ', forum: 'zzz999QQQ' }) } } };
    expect(readOpenReviewPage(withNextData(data)).visibility).toBe('unclear');
  });

  test('a note whose id is not a valid forum id is ignored', () => {
    expect(readOpenReviewPage(withNextData(pageProps(note({ id: 'bad id!', forum: 'bad id!' })))).visibility).toBe('unclear');
  });

  test('the address must agree with the page data', () => {
    const doc = withNextData(pageProps(note()));
    Object.defineProperty(doc, 'URL', { value: 'https://openreview.net/forum?id=otherId99' });
    expect(readOpenReviewPage(doc)).toEqual({ forumId: 'otherId99', visibility: 'unclear' });

    const same = withNextData(pageProps(note()));
    Object.defineProperty(same, 'URL', { value: 'https://openreview.net/forum?id=abc123XYZ&noteId=r1' });
    expect(readOpenReviewPage(same)).toMatchObject({ forumId: 'abc123XYZ', visibility: 'public' });
  });

  test('page data and label that disagree are not public', () => {
    const restrictedLabel = withNextData(pageProps(note()), '<div class="readers">Readers: Program Chairs</div>');
    expect(readOpenReviewPage(restrictedLabel).visibility).toBe('unclear');
    const everyoneLabel = withNextData(pageProps(note({ readers: ['restricted/group'] })), '<div class="readers">Readers: Everyone</div>');
    expect(readOpenReviewPage(everyoneLabel).visibility).toBe('confidential');
  });

  test('hostile keys do not change the outcome', () => {
    const json = '{"__proto__":{"readers":["everyone"]},"constructor":{"readers":["everyone"]},"props":{"pageProps":{"forumNote":{"id":"abc123XYZ","forum":"abc123XYZ","readers":["x"]}}}}';
    expect(readOpenReviewPage(withNextData(json)).visibility).toBe('confidential');
    expect(({} as { readers?: unknown }).readers).toBeUndefined();
  });

  test('very large or deeply nested data is handled within bounds', () => {
    let deep: unknown = note();
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    expect(readOpenReviewPage(withNextData(JSON.stringify({ props: { pageProps: deep } }))).visibility).toBe('unclear');
    const wide = { props: { pageProps: { list: Array.from({ length: 300_000 }, (_, i) => ({ i })) } } };
    expect(readOpenReviewPage(withNextData(JSON.stringify(wide))).visibility).toBe('unclear');
    const huge = `{"props":{"pageProps":{"pad":"${'x'.repeat(11 * 1024 * 1024)}"}}}`;
    expect(readOpenReviewPage(withNextData(huge)).visibility).toBe('unclear');
  });
});

describe('readOpenReviewPage: fail closed', () => {
  const EVERYONE_LABEL = '<div class="readers">Readers: Everyone</div>';

  test('a restricted note for this forum id wins over another public note and an "Everyone" label', () => {
    // No pageProps.forumNote: the notes sit elsewhere, one of them is for another forum and public.
    const data = {
      props: {
        pageProps: {
          notes: [
            note({ readers: ['ICLR.cc/Reviewers'], content: { title: { value: 'Confidential Title' } } }),
            note({ id: 'zzz999QQQ', forum: 'zzz999QQQ', readers: ['everyone'], content: { title: { value: 'Someone Else' } } }),
          ],
        },
      },
    };
    const result = readOpenReviewPage(withNextData(data, EVERYONE_LABEL));
    expect(result).toEqual({ forumId: 'abc123XYZ', visibility: 'confidential' });
  });

  test('the same holds when the public note comes first', () => {
    const data = { props: { pageProps: { a: note({ id: 'zzz999QQQ', forum: 'zzz999QQQ' }), b: note({ readers: ['ICLR.cc/Reviewers'] }) } } };
    expect(readOpenReviewPage(withNextData(data, EVERYONE_LABEL)).visibility).toBe('confidential');
  });

  test.each([
    ['null', null],
    ['the string "everyone"', 'everyone'],
    ['an empty list', []],
    ['a list with a non-string', ['everyone', 5]],
    ['an object', { 0: 'everyone' }],
  ])('readers that are %s is unclear, and the label cannot make it public', (_name, readers) => {
    const result = readOpenReviewPage(withNextData(pageProps(note({ readers })), EVERYONE_LABEL));
    expect(result).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
  });

  test('data that says public needs a label that is not restricted', () => {
    expect(readOpenReviewPage(withNextData(pageProps(note()), EVERYONE_LABEL)).visibility).toBe('public');
    expect(readOpenReviewPage(withNextData(pageProps(note()))).visibility).toBe('public');
    expect(readOpenReviewPage(withNextData(pageProps(note()), '<div class="readers">Readers: Reviewers</div>')).visibility).toBe('unclear');
  });

  test('the label alone cannot make a page public once forum-note data was found for another paper', () => {
    const other = pageProps(note({ id: 'zzz999QQQ', forum: 'zzz999QQQ' }));
    expect(readOpenReviewPage(withNextData(other, EVERYONE_LABEL))).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
  });

  test('the label alone makes a page public only when no forum-note data exists at all', () => {
    expect(readOpenReviewPage(withNextData({ props: { pageProps: { nothing: 1 } } }, EVERYONE_LABEL)).visibility).toBe('public');
  });

  test('no title is returned unless the page is public', () => {
    const restricted = note({ readers: ['ICLR.cc/Reviewers'], content: { title: { value: 'Secret' } } });
    for (const label of ['', EVERYONE_LABEL]) {
      const result = readOpenReviewPage(withNextData(pageProps(restricted), label));
      expect(result).not.toHaveProperty('title');
    }
    const unreadable = note({ readers: null, content: { title: { value: 'Secret' } } });
    expect(readOpenReviewPage(withNextData(pageProps(unreadable), EVERYONE_LABEL))).not.toHaveProperty('title');
  });

  test('a title restricted by its own readers is not returned, even from the page title or meta tags', () => {
    const html = '<meta name="citation_title" content="Meta Title">';
    for (const titleReaders of [['ICLR.cc/Reviewers'], [], 'everyone', null]) {
      const data = pageProps(note({ content: { title: { value: 'Field Title', readers: titleReaders } } }));
      const json = JSON.stringify(data);
      const doc = parseHtml(`<html><head><title>Page Title | OpenReview</title>${html}</head><body><script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`);
      const result = readOpenReviewPage(doc);
      expect(result.visibility).toBe('public');
      expect(result).not.toHaveProperty('title');
    }
  });

  test('a title whose own readers include everyone is returned', () => {
    const data = pageProps(note({ content: { title: { value: 'Field Title', readers: ['everyone'] } } }));
    expect(readOpenReviewPage(withNextData(data)).title).toBe('Field Title');
  });

  test.each([
    ['no address (parsed document)', undefined],
    ['about:blank', 'about:blank'],
    ['an arXiv page', 'https://arxiv.org/abs/1706.03762'],
    ['an OpenReview group page', 'https://openreview.net/group?id=ICLR.cc/2025/Conference'],
    ['a look-alike host', 'https://openreview.net.evil.com/forum?id=abc123XYZ'],
    ['plain http', 'http://openreview.net/forum?id=abc123XYZ'],
    ['a forum page without an id', 'https://openreview.net/forum'],
  ])('a document at %s is unclear, whatever it says', (_name, url) => {
    const doc = withNextData(pageProps(note()), EVERYONE_LABEL);
    if (url === undefined) Object.defineProperty(doc, 'URL', { value: undefined, configurable: true });
    else Object.defineProperty(doc, 'URL', { value: url, configurable: true });
    const result = readOpenReviewPage(doc);
    expect(result.visibility).toBe('unclear');
    expect(result).not.toHaveProperty('title');
  });

  test('an OpenReview pdf address is accepted like a forum address', () => {
    const doc = withNextData(pageProps(note()));
    Object.defineProperty(doc, 'URL', { value: 'https://openreview.net/pdf?id=abc123XYZ', configurable: true });
    expect(readOpenReviewPage(doc).visibility).toBe('public');
  });
});

// Probes from the second review: every way the visibility could still come out public.
describe('readOpenReviewPage: public only if every copy of the note is public and the search finished', () => {
  const LABEL = '<div class="readers">Readers: Everyone</div>';
  const R = ['ICLR.cc/Reviewers'];
  const META = '<meta name="citation_title" content="META LEAK">';
  const withHead = (data: unknown, body = LABEL, head = META): Document => {
    const json = typeof data === 'string' ? data : JSON.stringify(data).replace(/</g, '\\u003c');
    return parseHtml(`<html><head><title>TITLELEAK | OpenReview</title>${head}</head><body>${body}<script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`);
  };
  const read2 = (data: unknown, body = LABEL) => readOpenReviewPage(withHead(data, body));
  const other = () => note({ id: 'zzz999QQQ', forum: 'zzz999QQQ' });
  const nest = (inner: unknown, levels: number): unknown => {
    let o = inner;
    for (let i = 0; i < levels; i++) o = { n: o };
    return o;
  };

  test.each([
    ['restricted copy and another forum note', { props: { pageProps: {} }, x: [note({ readers: R }), other()] }],
    ['public copy then restricted copy', { a: [note(), note({ readers: R })] }],
    ['a restricted copy with no forum field', { props: { pageProps: { forumNote: { id: 'abc123XYZ', readers: R, content: { title: { value: 'SECRET' } } } } } }],
    ['a restricted copy whose forum field names another forum', { props: { pageProps: { forumNote: { id: 'abc123XYZ', forum: 'other1234', readers: R } } } }],
    ['a restricted copy at depth 12', { props: { pageProps: { forumNote: note(), x: nest(note({ readers: R }), 8) } } }],
    ['a restricted copy past a very large filler array', { a: note(), filler: Array.from({ length: 300_000 }, () => ({})), z: note({ readers: R }) }],
  ])('%s is not public and has no title', (_name, data) => {
    const result = read2(data);
    expect(result.visibility).not.toBe('public');
    expect(result).not.toHaveProperty('title');
  });

  test('copies that are restricted are confidential, as far as the search saw them', () => {
    expect(read2({ x: [note({ readers: R }), other()] }).visibility).toBe('confidential');
    expect(read2({ a: [note(), note({ readers: R })] }).visibility).toBe('confidential');
    expect(read2({ forumNote: { id: 'abc123XYZ', forum: 'other1234', readers: R } }).visibility).toBe('confidential');
  });

  test('a copy with unreadable readers is unclear even when another copy is public', () => {
    expect(read2({ a: [note(), { id: 'abc123XYZ', content: { title: { value: 'T' } } }] }).visibility).toBe('unclear');
    expect(read2({ a: [note(), note({ readers: 'everyone' })] }).visibility).toBe('unclear');
  });

  test('an object that only carries the id (such as the query) is not a copy of the note', () => {
    expect(read2({ query: { id: 'abc123XYZ' }, props: { pageProps: { forumNote: note() } } }).visibility).toBe('public');
  });

  describe('every cap on the search makes the result unclear, never public', () => {
    test('the candidate cap', () => {
      const result = read2({ a: [...Array.from({ length: 30 }, () => note()), note({ readers: R })] });
      expect(result.visibility).toBe('unclear');
      expect(result).not.toHaveProperty('title');
    });
    test('the depth cap', () => {
      expect(read2({ a: note(), deep: nest(note({ readers: R }), 40) }).visibility).toBe('unclear');
    });
    test('the node budget', () => {
      expect(read2({ a: note(), filler: Array.from({ length: 600_000 }, () => ({})) }).visibility).toBe('unclear');
    });
    test('the size limit, even with an "Everyone" label', () => {
      const huge = `{"props":{"pageProps":{"pad":"${'x'.repeat(11 * 1024 * 1024)}"}}}`;
      expect(read2(huge)).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
    });
    test('a normal page well inside the caps is still public', () => {
      expect(read2({ props: { pageProps: { forumNote: note(), replies: Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}abcdef`, forum: 'abc123XYZ', readers: ['everyone'] })) } } }).visibility).toBe('public');
    });
  });

  describe('data that cannot be read', () => {
    const broken = '{"props":{"pageProps":{"forumNote":{"id":"abc123XYZ","forum":"abc123XYZ","readers":["ICLR.cc/Reviewers"]}}}';
    test('malformed data with an "Everyone" label is unclear and gives no title', () => {
      expect(read2(broken)).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
    });
    test('malformed data with a restricted label is confidential', () => {
      expect(read2(broken, '<div class="readers">Readers: Program Chairs</div>').visibility).toBe('confidential');
    });
    test('data that is empty text is unclear even with the label', () => {
      expect(read2('').visibility).toBe('unclear');
    });
    test('data that cannot be parsed because it is nested too deeply is unclear', () => {
      const json = '['.repeat(2_000_000) + ']'.repeat(2_000_000);
      expect(read2(json).visibility).toBe('unclear');
    });
  });

  describe('the title', () => {
    const titled = (value: string, readers?: unknown) => note({ content: { title: { value, ...(readers !== undefined && { readers }) } } });

    test('a title is returned only when every copy that has one agrees after normalisation', () => {
      expect(read2({ a: [titled('A  Study  of Things'), titled('a study of things')] }).title).toBe('A Study of Things');
      const differ = read2({ a: [titled('A Study'), titled('Another Study')] });
      expect(differ.visibility).toBe('public');
      expect(differ).not.toHaveProperty('title');
    });

    test('a copy without a title does not stop the others from supplying it', () => {
      expect(read2({ a: [note({ content: {} }), titled('Shared Title')] }).title).toBe('Shared Title');
    });

    test.each([
      ['restricted first', [titled('X', R), titled('OPEN?')]],
      ['restricted last', [titled('OPEN?'), titled('X', R)]],
      ['restricted copy has no title text', [note({ content: { title: { readers: R } } }), titled('OPEN?')]],
      ['a copy with no content next to a restricted one', [note({ content: {} }), titled('X', R)]],
    ])('no title when any copy restricts it: %s', (_name, copies) => {
      const result = read2({ a: copies });
      expect(result.visibility).toBe('public');
      expect(result).not.toHaveProperty('title');
    });

    test('a restricted title on the usual note and an open copy elsewhere gives no title', () => {
      const data = { props: { pageProps: { forumNote: titled('SECRET', R) } }, cache: [titled('SECRET')] };
      expect(read2(data)).not.toHaveProperty('title');
    });

    test('the meta tag is never used when the page has forum-note data', () => {
      const result = read2({ props: { pageProps: { forumNote: note({ content: {} }) } } });
      expect(result.visibility).toBe('public');
      expect(result).not.toHaveProperty('title');
    });

    test('the meta tag is used only when no forum-note data exists and the label alone made the page public', () => {
      expect(read2({ props: { pageProps: { nothing: 1 } } }).title).toBe('META LEAK');
      const noScript = parseHtml(`<html><head><title>TITLELEAK | OpenReview</title>${META}</head><body>${LABEL}</body></html>`);
      expect(readOpenReviewPage(noScript)).toEqual({ title: 'META LEAK', forumId: 'abc123XYZ', visibility: 'public' });
      // The page <title> and og:title are not read at all.
      const titleOnly = parseHtml(`<html><head><title>TITLELEAK | OpenReview</title><meta property="og:title" content="OG LEAK"></head><body>${LABEL}</body></html>`);
      expect(readOpenReviewPage(titleOnly)).toEqual({ forumId: 'abc123XYZ', visibility: 'public' });
    });
  });
});

describe('readOpenReviewPage: label fallback', () => {
  const labelled = (label: string) => parseHtml(`<html><body><div class="readers">${label}</div></body></html>`);

  test.each(['Readers: Everyone', 'readers:  everyone ', 'Readers:\u00a0Everyone'])('%j is public', (label) => {
    expect(readOpenReviewPage(labelled(label)).visibility).toBe('public');
  });

  test.each(['Readers: Everyone, Program Chairs', 'Readers: Program Chairs', 'Everyone', 'Readers: Not everyone', ''])(
    '%j is not public',
    (label) => {
      expect(readOpenReviewPage(labelled(label)).visibility).not.toBe('public');
    },
  );

  test('a label outside an element that is marked as the readers line is ignored', () => {
    expect(readOpenReviewPage(parseHtml('<html><body><p>Readers: Everyone</p></body></html>')).visibility).toBe('unclear');
  });

  test('only the first readers line counts (the note itself, not a later reply)', () => {
    const doc = parseHtml('<html><body><div class="readers">Readers: Program Chairs</div><div class="readers">Readers: Everyone</div></body></html>');
    expect(readOpenReviewPage(doc).visibility).toBe('confidential');
  });
});

describe('readOpenReviewPage: no page', () => {
  test('an empty document is unclear', () => {
    expect(readOpenReviewPage(parseHtml(''))).toEqual({ forumId: 'abc123XYZ', visibility: 'unclear' });
  });
});
