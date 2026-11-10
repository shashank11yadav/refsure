import { describe, expect, test } from 'vitest';
import { decodeXmlEntities, MAX_ATOM_CHARS, parseAtomFeed } from '../../../src/sources/atom';
import { SourceError } from '../../../src/sources/http';
import { fixtureText } from '../helpers/fixtures';

const wrap = (entries: string): string => `<?xml version='1.0'?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entries}</feed>`;

describe('decodeXmlEntities', () => {
  test('decodes the five XML entities and numeric references', () => {
    expect(decodeXmlEntities('a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42;&#x1F600;')).toBe('a <b> & "c" \'d\' AB😀');
  });

  test('decodes one level only and leaves unknown entities alone', () => {
    expect(decodeXmlEntities('&amp;lt; &nbsp; &bogus; &#xZZ; &amp')).toBe('&lt; &nbsp; &bogus; &#xZZ; &amp');
  });

  test('replaces impossible code points and control characters', () => {
    expect(decodeXmlEntities('x&#0;y&#xD800;z&#x110000;w&#1;')).toBe('x�y�z�w�');
  });
});

const parseAtomEntries = (xml: string) => parseAtomFeed(xml).entries;

describe('parseAtomEntries', () => {
  test('reads the fields of a recorded arXiv entry', () => {
    const [entry, ...rest] = parseAtomEntries(fixtureText('arxiv-1706.03762.atom.xml'));
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      id: 'http://arxiv.org/abs/1706.03762v7',
      title: 'Attention Is All You Need',
      published: '2017-06-12T17:57:34Z',
      comment: '15 pages, 5 figures',
    });
    expect(entry?.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin']);
    expect(entry?.summary).toMatch(/^The dominant sequence transduction models/);
  });

  test('reads arxiv:doi and arxiv:journal_ref', () => {
    const [entry] = parseAtomEntries(fixtureText('arxiv-with-doi-1602.03837.atom.xml'));
    expect(entry?.doi).toBe('10.1103/PhysRevLett.116.061102');
    expect(entry?.journalRef).toBe('Phys. Rev. Lett. 116, 061102 (2016)');
  });

  test('does not mistake the feed-level title or id for an entry', () => {
    expect(parseAtomEntries(wrap(''))).toEqual([]);
    expect(parseAtomEntries('<feed><id>x</id><title>Feed</title></feed>')).toEqual([]);
  });

  test('handles CDATA, comments, entities, attributes with > and self-closing tags', () => {
    const xml = wrap(
      `<entry><!-- <title>ignored</title> --><id>http://arxiv.org/abs/1</id>
         <title><![CDATA[Fish &amp; <b>Chips</b>]]></title>
         <link href="https://x.example/?a=b>c" rel="alternate"/>
         <summary>1 &lt; 2 &#38; 3</summary>
         <author><name>A &amp; B</name></author><author><name/></author></entry>`,
    );
    const [entry] = parseAtomEntries(xml);
    expect(entry?.title).toBe('Fish &amp; <b>Chips</b>');
    expect(entry?.summary).toBe('1 < 2 & 3');
    expect(entry?.authors).toEqual(['A & B']);
  });

  test('first occurrence of a field wins and tags in text never become structure', () => {
    const [entry] = parseAtomEntries(wrap('<entry><title>One</title><title>Two</title><summary>&lt;entry&gt;&lt;title&gt;X&lt;/title&gt;&lt;/entry&gt;</summary></entry>'));
    expect(entry?.title).toBe('One');
    expect(entry?.summary).toBe('<entry><title>X</title></entry>');
  });

  test('ignores unknown elements and unbalanced closing tags', () => {
    const entries = parseAtomEntries(wrap('</oops><entry><weird><title>Kept</title></weird></oops></entry><entry><title>Second</title></entry>'));
    expect(entries.map((e) => e.title)).toEqual(['Kept', 'Second']);
  });

  test('refuses a document type declaration, so no entity can be defined', () => {
    expect(() => parseAtomEntries('<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "boom">]><feed><entry><title>&x;</title></entry></feed>')).toThrow(/DOCTYPE/);
  });

  test('refuses an oversized document', () => {
    expect(() => parseAtomEntries('x'.repeat(MAX_ATOM_CHARS + 1))).toThrow(/too large/i);
  });

  test('a truncated document is a bad_response, not a partial answer', () => {
    const whole = wrap('<entry><title>Done</title></entry><entry><title>Cut off</title></entry>');
    expect(() => parseAtomEntries(whole.slice(0, -20))).toThrow(SourceError);
    expect(() => parseAtomEntries(whole.slice(0, -20))).toThrow(expect.objectContaining({ kind: 'bad_response', source: 'arxiv' }));
    expect(() => parseAtomEntries(whole.slice(0, whole.indexOf('<entry><title>Cut') + 10))).toThrow(SourceError);
  });

  test.each(['', '   ', '<html>Rate exceeded</html>', 'Rate exceeded.', '<?xml version="1.0"?><rss><entry/></rss>', '<entry><title>x</title></entry>'])(
    'refuses %j: not an Atom feed',
    (xml) => {
      expect(() => parseAtomEntries(xml)).toThrow(expect.objectContaining({ kind: 'bad_response', source: 'arxiv' }));
    },
  );

  test('an empty but complete feed is simply empty', () => {
    expect(parseAtomEntries(wrap(''))).toEqual([]);
    expect(parseAtomEntries('<feed></feed>')).toEqual([]);
  });

  test('reads opensearch:totalResults from the feed, not from entries', () => {
    expect(parseAtomFeed(fixtureText('arxiv-1706.03762.atom.xml')).totalResults).toBe(1);
    expect(parseAtomFeed(wrap('<opensearch:totalResults>12</opensearch:totalResults><entry><title>t</title></entry>')).totalResults).toBe(12);
    expect(parseAtomFeed(wrap('<entry><opensearch:totalResults>99</opensearch:totalResults></entry>')).totalResults).toBeUndefined();
    expect(parseAtomFeed(wrap('<opensearch:totalResults>lots</opensearch:totalResults>')).totalResults).toBeUndefined();
    expect(parseAtomFeed(wrap('')).totalResults).toBeUndefined();
  });

  test('refuses a feed with an absurd number of entries', () => {
    expect(() => parseAtomEntries(wrap('<entry><title>t</title></entry>'.repeat(1000)))).toThrow(/too many/i);
  });

  test('stays linear on hostile input (and rejects it)', () => {
    const started = Date.now();
    const hostile = [
      wrap('<entry>' + '<a '.repeat(200_000) + '</entry>'),
      wrap('<entry><title>' + '&'.repeat(1_000_000) + '</title></entry>'),
      wrap('<entry>' + '<!--'.repeat(200_000) + '</entry>'),
      wrap('<entry>' + '<![CDATA['.repeat(100_000) + '</entry>'),
    ];
    for (const xml of hostile) {
      try {
        parseAtomEntries(xml);
      } catch (error) {
        expect(error).toBeInstanceOf(SourceError);
      }
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
