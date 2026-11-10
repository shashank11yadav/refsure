import { describe, expect, test } from 'vitest';
import { OPENALEX_KEY_MAX, OPENALEX_KEY_MIN, validateOpenAlexKey } from '../../../src/core/apiKey';

describe('validateOpenAlexKey', () => {
  test('trims, then accepts 8 to 200 printable ASCII characters', () => {
    expect(validateOpenAlexKey('  abcdefgh  ')).toEqual({ ok: true, key: 'abcdefgh' });
    expect(validateOpenAlexKey('a'.repeat(OPENALEX_KEY_MAX))).toEqual({ ok: true, key: 'a'.repeat(OPENALEX_KEY_MAX) });
    expect(OPENALEX_KEY_MIN).toBe(8);
    expect(OPENALEX_KEY_MAX).toBe(200);
  });

  test.each([
    ['too short', 'abcdefg', 'length'],
    ['empty', '   ', 'length'],
    ['too long', 'a'.repeat(201), 'length'],
    ['a space inside', 'abcd efgh1234', 'space'],
    ['a tab inside', 'abcd\tefgh', 'space'],
    ['a line break inside', 'abcdefgh\n12345678', 'space'],
    ['a non-ASCII letter', 'abcdefgh12é45678', 'ascii'],
    ['an emoji', 'abcdefgh😀1234', 'ascii'],
    ['a control character', 'abcdefgh\u00001234', 'ascii'],
  ])('refuses a key that is %s', (_name, raw, reason) => {
    expect(validateOpenAlexKey(raw)).toEqual({ ok: false, reason });
  });
});
