import { describe, expect, test } from 'vitest';
import { zoneNamesSomeone } from '../../../src/core/authorZone';
import type { ParsedCitation } from '../../../src/core/types';

const citation = (raw: string): ParsedCitation => ({ raw, authors: [], kind: 'paper', confidence: 1 });

describe('zoneNamesSomeone: linear on hostile text', () => {
  test.each([' y.', '! y', '_', '*', ' y. Sparse attention for video transformers at scale.'])('a 20k-character letter run followed by %j finishes in under 20 ms', (odd) => {
    // Kept under the zone's 20k-character cap, so the odd character is part of the zone.
    const raw = `${'Roe'.repeat(6_600)}x${odd}`;
    const t0 = performance.now();
    zoneNamesSomeone(citation(raw));
    expect(performance.now() - t0).toBeLessThan(20);
  });

  test('a single capitalised word ending the zone is still an organisation; a person beside it still counts', () => {
    expect(zoneNamesSomeone(citation('OpenAI. doi:10.1/x'))).toBe(false);
    expect(zoneNamesSomeone(citation('Smith Lab. doi:10.1/x'))).toBe(false);
    expect(zoneNamesSomeone(citation('J. Roe and DeepMind. doi:10.1/x'))).toBe(true);
  });
});
