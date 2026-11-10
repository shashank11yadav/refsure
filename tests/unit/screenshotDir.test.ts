import { describe, expect, test } from 'vitest';
import { screenshotDir } from '../e2e/screenshotDir';

describe('where the e2e screenshots are written', () => {
  test('into test-results (not tracked) by default', () => {
    expect(screenshotDir('/repo', {})).toBe('/repo/test-results/screenshots');
    expect(screenshotDir('/repo', { REFSURE_UPDATE_SCREENSHOTS: '0' })).toBe('/repo/test-results/screenshots');
    expect(screenshotDir('/repo', { REFSURE_UPDATE_SCREENSHOTS: '' })).toBe('/repo/test-results/screenshots');
  });

  test('into docs/screenshots only when REFSURE_UPDATE_SCREENSHOTS=1', () => {
    expect(screenshotDir('/repo', { REFSURE_UPDATE_SCREENSHOTS: '1' })).toBe('/repo/docs/screenshots');
  });
});
