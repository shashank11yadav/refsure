import { describe, expect, test } from 'vitest';
import { RATE } from '../../../src/config';
import { REQUIRED_SOURCES, type SourceName } from '../../../src/core/types';

const ALL_SOURCES: Record<SourceName, true> = { crossref: true, openalex: true, arxiv: true, openreview: true, dblp: true };

describe('SourceName', () => {
  test('matches the sources that have a rate limit in config', () => {
    expect(Object.keys(ALL_SOURCES).sort()).toEqual(Object.keys(RATE).sort());
  });

  test('dblp is best-effort, so it is not required', () => {
    expect([...REQUIRED_SOURCES].sort()).toEqual(['arxiv', 'crossref', 'openalex', 'openreview']);
  });
});
