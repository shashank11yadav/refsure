import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

// Proves the safety rails in eslint.config.js actually fire (SECURITY.md section 4).
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

describe('dynamic code is banned everywhere', () => {
  test.each([
    ['eval', 'eval("1");', 'no-eval'],
    ['Function constructor', 'new Function("return 1");', 'no-new-func'],
    ['setTimeout with a string', 'setTimeout("alert(1)", 10);', 'no-implied-eval'],
  ])('%s', async (_name, code, rule) => {
    expect(await ruleIdsFor(code, 'src/core/x.ts')).toContain(rule);
  });
});

describe('DOM string sinks are banned', () => {
  test.each([
    'el.innerHTML = value;',
    'el.outerHTML = value;',
    'el.insertAdjacentHTML("beforeend", value);',
    'document.write(value);',
    'document.writeln(value);',
  ])('%s', async (code) => {
    const full = `declare const el: HTMLElement; declare const value: string;\n${code}`;
    expect(await ruleIdsFor(full, 'src/ui/x.ts')).toContain('no-restricted-properties');
    expect(await ruleIdsFor(full, 'tests/unit/x.test.ts')).toContain('no-restricted-properties');
  });
});

describe('direct network access is banned outside src/sources/http.ts', () => {
  test.each([
    ['fetch(url);', 'no-restricted-globals'],
    ['new XMLHttpRequest();', 'no-restricted-globals'],
    ['new WebSocket(url);', 'no-restricted-globals'],
    ['globalThis.fetch(url);', 'no-restricted-properties'],
    ['window.fetch(url);', 'no-restricted-properties'],
    ['navigator.sendBeacon(url, data);', 'no-restricted-properties'],
  ])('%s', async (code, rule) => {
    const full = `declare const url: string; declare const data: string;\n${code}`;
    expect(await ruleIdsFor(full, 'src/engine/x.ts')).toContain(rule);
  });

  test('http.ts may call fetch', async () => {
    const ids = await ruleIdsFor('declare const url: string;\nawait fetch(url);', 'src/sources/http.ts');
    expect(ids).not.toContain('no-restricted-globals');
  });

  test('http.ts still may not use DOM string sinks', async () => {
    const ids = await ruleIdsFor('declare const el: HTMLElement;\nel.innerHTML = "x";', 'src/sources/http.ts');
    expect(ids).toContain('no-restricted-properties');
  });

  test('tests may stub fetch', async () => {
    const ids = await ruleIdsFor('globalThis.fetch = (() => Promise.reject(new Error("x"))) as typeof fetch;', 'tests/unit/x.test.ts');
    expect(ids).not.toContain('no-restricted-properties');
  });
});

describe('rails cannot be sidestepped', () => {
  test.each(['src/ui/x.tsx', 'src/ui/x.jsx', 'src/ui/x.mjs', 'src/ui/x.cjs', 'src/ui/x.js'])(
    'network and DOM bans also cover %s',
    async (filePath) => {
      const ids = await ruleIdsFor('const url = String(1);\nfetch(url);\ndocument.body.innerHTML = url;', filePath);
      expect(ids).toContain('no-restricted-globals');
      expect(ids).toContain('no-restricted-properties');
    },
  );

  test.each([
    ['// eslint-disable-next-line no-restricted-globals\nfetch(url);', 'no-restricted-globals'],
    ['/* eslint-disable */\nfetch(url);', 'no-restricted-globals'],
    ['fetch(url); // eslint-disable-line no-restricted-globals', 'no-restricted-globals'],
    ['// eslint-disable-next-line no-eval\neval("1");', 'no-eval'],
  ])('an eslint-disable comment does not silence the rule: %s', async (code, rule) => {
    const full = `declare const url: string;\n${code}`;
    expect(await ruleIdsFor(full, 'src/engine/x.ts')).toContain(rule);
  });

  test('inline config comments are themselves reported', async () => {
    const [result] = await eslint.lintText('// eslint-disable-next-line no-eval\neval("1");', { filePath: 'src/engine/x.ts' });
    expect(result?.messages.some((m) => /inline config|disable/i.test(m.message) && m.ruleId === null)).toBe(true);
  });

  test.each([
    'range.createContextualFragment(html);',
    'el.setHTMLUnsafe(html);',
    'Document.parseHTMLUnsafe(html);',
    'window.eval(html);',
    'globalThis.eval(html);',
    'self.eval(html);',
  ])('%s is banned', async (code) => {
    const full = `declare const range: Range; declare const el: HTMLElement; declare const html: string;\n${code}`;
    expect(await ruleIdsFor(full, 'src/ui/x.ts')).toContain('no-restricted-properties');
    expect(await ruleIdsFor(full, 'src/sources/http.ts')).toContain('no-restricted-properties');
  });
});
