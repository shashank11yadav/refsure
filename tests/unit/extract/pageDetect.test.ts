import { describe, expect, test } from 'vitest';
import { detectPage } from '../../../src/extract/pageDetect';

describe('detectPage: arXiv', () => {
  test('HTML paper keeps the version in arxivId and drops it from paperKey', () => {
    expect(detectPage('https://arxiv.org/html/1706.03762v7')).toEqual({
      kind: 'arxiv-html',
      paperKey: 'arxiv:1706.03762',
      arxivId: '1706.03762v7',
    });
  });

  test('abstract page', () => {
    expect(detectPage('https://arxiv.org/abs/1706.03762').kind).toBe('arxiv-abs');
    expect(detectPage('https://arxiv.org/abs/1706.03762')).toEqual({
      kind: 'arxiv-abs',
      paperKey: 'arxiv:1706.03762',
      arxivId: '1706.03762',
    });
  });

  test.each([
    ['https://arxiv.org/pdf/1706.03762', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v2', '1706.03762v2'],
    ['https://arxiv.org/pdf/1706.03762v2.pdf', '1706.03762v2'],
  ])('PDF %s', (url, arxivId) => {
    expect(detectPage(url)).toMatchObject({ kind: 'arxiv-pdf', paperKey: 'arxiv:1706.03762', arxivId });
  });

  test('old-style identifiers contain a slash', () => {
    expect(detectPage('https://arxiv.org/abs/hep-th/9901001v1')).toEqual({
      kind: 'arxiv-abs',
      paperKey: 'arxiv:hep-th/9901001',
      arxivId: 'hep-th/9901001v1',
    });
  });

  test('query strings, fragments and a trailing slash do not matter', () => {
    expect(detectPage('https://arxiv.org/html/2401.04088v1/#S3.SS1').arxivId).toBe('2401.04088v1');
    expect(detectPage('https://arxiv.org/abs/2401.04088?context=cs').arxivId).toBe('2401.04088');
  });

  test.each([
    'https://arxiv.org/html/not-an-id',
    'https://arxiv.org/html/',
    'https://arxiv.org/abs/1706.03762/extra',
    'https://arxiv.org/abs/1706.03762%2F..%2Fx',
    'https://arxiv.org/list/cs.CL/recent',
    'https://arxiv.org/',
    'https://arxiv.org/html/1706.03762v7/../../x',
  ])('%s is unsupported', (url) => {
    expect(detectPage(url)).toEqual({ kind: 'unsupported' });
  });
});

describe('detectPage: OpenReview', () => {
  test('forum page', () => {
    expect(detectPage('https://openreview.net/forum?id=abc123XYZ')).toEqual({
      kind: 'openreview',
      paperKey: 'openreview:abc123XYZ',
      forumId: 'abc123XYZ',
    });
  });

  test('a forum link to one comment still names the paper', () => {
    expect(detectPage('https://openreview.net/forum?id=abc123XYZ&noteId=zzzzzz9').forumId).toBe('abc123XYZ');
  });

  test('pdf page counts as an OpenReview paper', () => {
    expect(detectPage('https://openreview.net/pdf?id=abc123XYZ')).toEqual({
      kind: 'openreview',
      paperKey: 'openreview:abc123XYZ',
      forumId: 'abc123XYZ',
    });
  });

  test.each([
    'https://openreview.net/forum',
    'https://openreview.net/forum?id=',
    'https://openreview.net/forum?id=a',
    'https://openreview.net/forum?id=has space here',
    'https://openreview.net/forum?id=abc123XYZ&id=def456UVW',
    'https://openreview.net/forum?id=abc<script>alert(1)',
    'https://openreview.net/group?id=ICLR.cc/2025/Conference',
    'https://openreview.net/profile?id=~Some_Person1',
  ])('%s is unsupported', (url) => {
    expect(detectPage(url)).toEqual({ kind: 'unsupported' });
  });
});

describe('detectPage: look-alikes and bad input', () => {
  test.each([
    'https://arxiv.org.evil.com/html/1706.03762',
    'https://evil.com/arxiv.org/html/1706.03762',
    'https://evil.com/html/1706.03762#https://arxiv.org/html/1706.03762',
    'https://arxiv.org@evil.com/html/1706.03762',
    'https://user:pw@arxiv.org/html/1706.03762',
    'https://arxiv.org:8443/html/1706.03762',
    'http://arxiv.org/html/1706.03762',
    'https://export.arxiv.org/abs/1706.03762',
    'https://www.arxiv.org/abs/1706.03762',
    'https://openreview.net.evil.com/forum?id=abc123XYZ',
    'https://api2.openreview.net/forum?id=abc123XYZ',
    'http://openreview.net/forum?id=abc123XYZ',
    'ftp://arxiv.org/html/1706.03762',
    'javascript:alert(1)',
    'data:text/html,<p>x</p>',
    'blob:https://arxiv.org/1234',
    'chrome-extension://abc/page.html',
    'not a url',
    '',
  ])('%s is unsupported', (url) => {
    expect(detectPage(url)).toEqual({ kind: 'unsupported' });
  });

  test('an HTTPS URL with the default port written out is still arXiv', () => {
    expect(detectPage('https://arxiv.org:443/abs/1706.03762').kind).toBe('arxiv-abs');
  });

  test('a very long URL is handled without trouble', () => {
    expect(detectPage(`https://arxiv.org/abs/${'1'.repeat(100_000)}`)).toEqual({ kind: 'unsupported' });
  });
});
