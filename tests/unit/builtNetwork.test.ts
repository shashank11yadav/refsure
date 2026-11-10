import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import { networkViolations, scanBundle } from './helpers/builtNetwork';

// The built-bundle rule: in every emitted JS file, each fetch() call must be
// paired with a request-options block that only src/sources/http.ts writes
// (`credentials:"omit",referrerPolicy:"no-referrer"`), and the other network
// APIs must not appear at all. This file proves the rule bites, on synthetic
// text and on real minified bundles that import the real http.ts.

const GUARDED = 'fetch(u,{method:"GET",credentials:"omit",referrerPolicy:"no-referrer",redirect:"follow"})';

describe('scanBundle on synthetic text', () => {
  test('a fetch with the guarded options is accepted', () => {
    expect(networkViolations(`async function f(u){return ${GUARDED}}`)).toEqual([]);
  });

  test('the same options written with other quotes and spacing still count', () => {
    const text = 'fetch(u, { credentials: `omit`, referrerPolicy : \'no-referrer\' })';
    expect(scanBundle(text)).toMatchObject({ fetchCalls: 1, guardedSites: 1 });
  });

  test('a stray fetch next to the guarded one is a violation', () => {
    const text = `${GUARDED};fetch(u);`;
    expect(scanBundle(text)).toMatchObject({ fetchCalls: 2, guardedSites: 1 });
    expect(networkViolations(text).join(' ')).toMatch(/fetch/);
  });

  test('the old Vite preload polyfill shape is a violation', () => {
    const polyfill = 'let e=document.createElement("link");fetch(t.href,r)';
    expect(networkViolations(polyfill).join(' ')).toMatch(/fetch/);
  });

  test('a fetch whose options lack no-referrer is a violation', () => {
    expect(networkViolations('fetch(u,{credentials:"omit"})')).not.toEqual([]);
  });

  test.each(['new XMLHttpRequest()', 'new WebSocket(u)', 'new EventSource(u)', 'navigator.sendBeacon(u,d)'])(
    '%s is a violation wherever it appears',
    (code) => {
      expect(networkViolations(`${GUARDED};${code}`)).not.toEqual([]);
    },
  );

  test('no network code at all is fine', () => {
    expect(networkViolations('console.log(1)')).toEqual([]);
  });
});

describe('scanBundle on real minified bundles that include src/sources/http.ts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refsure-bundle-'));
  const httpPath = resolve(__dirname, '../../src/sources/http.ts');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function bundle(name: string, source: string): Promise<string> {
    const entry = join(dir, `${name}.ts`);
    writeFileSync(entry, source);
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      root: dir,
      build: {
        write: false,
        minify: true,
        sourcemap: false,
        lib: { entry, formats: ['es'], fileName: name },
        rollupOptions: { output: { codeSplitting: false } },
      },
    });
    const outputs = Array.isArray(output) ? output : [output];
    return outputs
      .flatMap((o) => ('output' in o ? o.output : []))
      .map((chunk) => ('code' in chunk ? chunk.code : ''))
      .join('\n');
  }

  test('the real http.ts passes the rule and its fetch site is recognised', async () => {
    const code = await bundle('clean', `import { fetchJson } from ${JSON.stringify(httpPath)};\nexport const run = () => fetchJson('https://api.crossref.org/works', { source: 'crossref' });\n`);
    const scan = scanBundle(code);
    expect(scan.fetchCalls).toBeGreaterThanOrEqual(1);
    expect(scan.guardedSites).toBeGreaterThanOrEqual(scan.fetchCalls);
    expect(networkViolations(code)).toEqual([]);
  }, 60_000);

  test('a stray fetch bundled into the same chunk is caught', async () => {
    const code = await bundle(
      'stray',
      `import { fetchJson } from ${JSON.stringify(httpPath)};\nexport const run = () => fetchJson('https://api.crossref.org/works', { source: 'crossref' });\nexport const leak = (u: string) => globalThis['fetch'](u);\nexport const leak2 = (u: string, body: string) => fetch(u, { method: 'POST', body });\n`,
    );
    expect(networkViolations(code).join(' ')).toMatch(/fetch/);
  }, 60_000);

  test('XMLHttpRequest bundled next to http.ts is caught', async () => {
    const code = await bundle(
      'xhr',
      `import { fetchJson } from ${JSON.stringify(httpPath)};\nexport const run = () => fetchJson('https://api.crossref.org/works', { source: 'crossref' });\nexport const x = () => new XMLHttpRequest();\n`,
    );
    expect(networkViolations(code).join(' ')).toMatch(/XMLHttpRequest/);
  }, 60_000);
});
