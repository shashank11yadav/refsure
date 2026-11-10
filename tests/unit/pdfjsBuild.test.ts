import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
  EXPECTED_PDFJS_VERSION,
  assertNoNetworkIdentifiers,
  pdfjsTextOnly,
  rewritePdfjs,
  stripPdfjsNetwork,
  stripPdfjsNodePath,
  verifyPdfjsSources,
} from '../../scripts/pdfjsBuild';
import { networkViolations } from './helpers/builtNetwork';

const PDFJS = join(process.cwd(), 'node_modules/pdfjs-dist');
const read = (rel: string) => readFileSync(join(PDFJS, rel), 'utf8');

describe('stripPdfjsNodePath', () => {
  test('turns the Node check into a constant', () => {
    const code = 'const a = 1;\nconst isNodeJS = typeof process === "object" && process + "" === "[object process]";\nif (isNodeJS) { x(); }';
    expect(stripPdfjsNodePath(code)).toBe('const a = 1;\nconst isNodeJS = false;\nif (isNodeJS) { x(); }');
  });

  test.each([['no declaration', 'const a = 1;'], ['two declarations', 'const isNodeJS = 1;\nconst isNodeJS = 2;']])('%s fails the build', (_n, code) => {
    expect(() => stripPdfjsNodePath(code)).toThrow(/isNodeJS/);
  });
});

describe('stripPdfjsNetwork', () => {
  test('renames fetch calls and XMLHttpRequest, but not look-alike names', () => {
    const code = 'await fetch(url); xref.fetch(ref); async fetch({kind}) {} a._fetch(x); fetchAsync(y); refetch(z); new XMLHttpRequest(); XMLHttpRequest.DONE; MyXMLHttpRequest(); const fetch2 = 1;';
    expect(stripPdfjsNetwork(code)).toBe(
      'await fetchDisabledByRefSure(url); xref.fetchDisabledByRefSure(ref); async fetchDisabledByRefSure({kind}) {} a._fetch(x); fetchAsync(y); refetch(z); new XMLHttpRequestDisabledByRefSure(); XMLHttpRequestDisabledByRefSure.DONE; MyXMLHttpRequest(); const fetch2 = 1;',
    );
  });

  test('code with no fetch calls fails the build (pdf.js changed)', () => {
    expect(() => stripPdfjsNetwork('const a = 1;')).toThrow(/pdf\.js code has changed/);
  });

  test.each(['build/pdf.mjs', 'build/pdf.worker.mjs', 'build/pdf.worker.min.mjs', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'])(
    'the real %s passes the built-bundle network rule once rewritten',
    (file) => {
      const original = read(file);
      expect(networkViolations(original)).not.toEqual([]);
      expect(networkViolations(stripPdfjsNetwork(original))).toEqual([]);
    },
  );

  test('the rewritten main module no longer holds Node-only code', () => {
    const code = stripPdfjsNodePath(read('build/pdf.mjs'));
    expect(code).toContain('const isNodeJS = false;');
  });
});

describe('verifyPdfjsSources: a pdf.js upgrade must be checked again', () => {
  const real = (rel: string): Buffer => readFileSync(join(PDFJS, rel));

  test('the installed pdf.js is the reviewed version', () => {
    expect(EXPECTED_PDFJS_VERSION).toBe('6.4.299');
    expect(() => verifyPdfjsSources(real)).not.toThrow();
  });

  test('another version fails', () => {
    const other = (rel: string): Buffer =>
      rel === 'package.json' ? Buffer.from(JSON.stringify({ version: '6.4.300' })) : real(rel);
    expect(() => verifyPdfjsSources(other)).toThrow(/6\.4\.300.*6\.4\.299/s);
  });

  test.each(['build/pdf.mjs', 'build/pdf.worker.mjs', 'build/pdf.worker.min.mjs'])('a changed byte in %s fails', (file) => {
    const tampered = (rel: string): Buffer => {
      const bytes = Buffer.from(real(rel));
      if (rel === file) bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] ?? 0) ^ 1;
      return bytes;
    };
    expect(() => verifyPdfjsSources(tampered)).toThrow(new RegExp(file.replace(/\./g, '\\.')));
  });

  test('a missing file fails', () => {
    const missing = (rel: string): Buffer => {
      if (rel === 'build/pdf.worker.mjs') throw new Error('ENOENT');
      return real(rel);
    };
    expect(() => verifyPdfjsSources(missing)).toThrow(/pdf\.worker\.mjs/);
  });
});

describe('assertNoNetworkIdentifiers and rewritePdfjs', () => {
  test('a clean rewrite passes, and names inside strings and comments are not counted', () => {
    const code = 'const note = "fetch( and XMLHttpRequest"; // fetch(x)\nconst t = `fetch(${1})`;\nclass A { fetchDisabledByRefSure() {} }';
    expect(() => assertNoNetworkIdentifiers(code)).not.toThrow();
  });

  test.each([
    ['a bound reference the call rewrite misses', 'const f = xref.fetch.bind(xref);'],
    ['a bare reference', 'const f = fetch;'],
    ['a global lookup', 'const f = globalThis.fetch;'],
    ['XMLHttpRequest passed around', 'const X = XMLHttpRequest;'],
    ['a destructured name', 'const { fetch } = window;'],
  ])('%s fails the build', (_name, code) => {
    expect(() => assertNoNetworkIdentifiers(code)).toThrow(/fetch|XMLHttpRequest/);
  });

  test('rewritePdfjs renames, then checks: a partial rename is an error', () => {
    expect(rewritePdfjs('await fetch(u); const x = 1;', { nodePath: false })).toContain('fetchDisabledByRefSure(u)');
    expect(() => rewritePdfjs('await fetch(u); const f = xref.fetch.bind(xref);', { nodePath: false })).toThrow(/fetch/);
  });

  test('rewritePdfjs strips the Node path when asked', () => {
    const out = rewritePdfjs('const isNodeJS = typeof process === "object";\nawait fetch(u);', { nodePath: true });
    expect(out).toContain('const isNodeJS = false;');
  });

  test.each(['build/pdf.mjs', 'build/pdf.worker.mjs', 'build/pdf.worker.min.mjs'])('the real %s passes after rewriting', (file) => {
    expect(() => rewritePdfjs(read(file), { nodePath: file === 'build/pdf.mjs' })).not.toThrow();
  });
});

describe('pdfjsTextOnly (Vite plugin)', () => {
  type Hooks = {
    buildStart: () => void;
    transform: (code: string, id: string) => { code: string } | null;
    generateBundle: (options: unknown, bundle: Record<string, { type: string; source?: string | Uint8Array }>) => void;
  };
  const plugin = pdfjsTextOnly() as unknown as Hooks;
  const source = 'const isNodeJS = false;\nawait fetch(u);';

  test('checks the installed pdf.js when a build starts', () => {
    expect(() => plugin.buildStart()).not.toThrow();
  });

  test('rewrites only pdf.js modules', () => {
    expect(plugin.transform(source, '/x/node_modules/pdfjs-dist/build/pdf.mjs')?.code).toContain('fetchDisabledByRefSure');
    expect(plugin.transform(source, '/x/node_modules/pdfjs-dist/build/pdf.worker.mjs?v=1')?.code).toContain('fetchDisabledByRefSure');
    expect(plugin.transform(source, '/x/node_modules/pdfjs-dist/build/pdf.sandbox.mjs')).toBeNull();
    expect(plugin.transform(source, '/x/src/extract/pdfText.ts')).toBeNull();
    expect(plugin.transform(source, '/x/node_modules/other/pdf.mjs')).toBeNull();
  });

  test('rewrites the emitted worker asset, whatever its form, and leaves other files alone', () => {
    const bundle: Record<string, { type: string; source?: string | Uint8Array }> = {
      'assets/pdf.worker.min-AbC123_-.mjs': { type: 'asset', source: new TextEncoder().encode('xref.fetch(a)') },
      'assets/other-1.mjs': { type: 'asset', source: 'fetch(a)' },
      'chunks/offscreen-1.js': { type: 'chunk' },
    };
    plugin.generateBundle({}, bundle);
    expect(bundle['assets/pdf.worker.min-AbC123_-.mjs']?.source).toBe('xref.fetchDisabledByRefSure(a)');
    expect(bundle['assets/other-1.mjs']?.source).toBe('fetch(a)');
  });
});

describe('pdfjsTextOnly: worker emitted at a fixed path (Firefox)', () => {
  type Emitted = { type: string; fileName: string; source: string };
  type Hooks = {
    buildStart: () => void;
    transform: (code: string, id: string) => unknown;
    generateBundle: (this: { emitFile: (file: Emitted) => void }, options: unknown, bundle: Record<string, unknown>) => void;
  };
  const RUNTIME = '/x/src/extract/pdfjsRuntime.ts';

  function run(options: { emitWorkerAt?: string } | undefined, modules: string[]): Emitted[] {
    const emitted: Emitted[] = [];
    const plugin = pdfjsTextOnly(options) as unknown as Hooks;
    plugin.buildStart();
    for (const id of modules) plugin.transform('', id);
    plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) }, {}, {});
    return emitted;
  }

  test('a build that contains the pdf.js runtime emits the rewritten worker at that exact path', () => {
    const [file, ...rest] = run({ emitWorkerAt: 'pdf.worker.mjs' }, [RUNTIME]);
    expect(rest).toEqual([]);
    expect(file).toMatchObject({ type: 'asset', fileName: 'pdf.worker.mjs' });
    expect(file?.source).toContain('fetchDisabledByRefSure');
    expect(() => assertNoNetworkIdentifiers(file?.source ?? '')).not.toThrow();
    // The minified worker, not the main-thread one.
    expect(file?.source).toBe(rewritePdfjs(read('build/pdf.worker.min.mjs'), { nodePath: false }));
  });

  test('builds that do not contain the runtime, or were not asked to, emit nothing', () => {
    expect(run({ emitWorkerAt: 'pdf.worker.mjs' }, ['/x/src/extract/pdfText.ts'])).toEqual([]);
    expect(run(undefined, [RUNTIME])).toEqual([]);
    expect(run({}, [RUNTIME])).toEqual([]);
  });

  test('the choice of one build does not leak into the next (a build starts clean)', () => {
    const plugin = pdfjsTextOnly({ emitWorkerAt: 'pdf.worker.mjs' }) as unknown as Hooks;
    const emitted: Emitted[] = [];
    const bundle = { emitFile: (file: Emitted) => void emitted.push(file) };
    plugin.buildStart();
    plugin.transform('', RUNTIME);
    plugin.buildStart();
    plugin.generateBundle.call(bundle, {}, {});
    expect(emitted).toEqual([]);
  });
});

// The rewrite must not change what pdf.js reads: patch a copy of the legacy build (main and
// worker), run it in plain Node (a child process, so Vite does not rewrite its imports) on real
// PDFs, and compare the text with the unpatched build's.
describe('a rewritten pdf.js reads the same text', () => {
  const patchedDir = mkdtempSync(join(tmpdir(), 'refsure-pdfjs-patched-'));
  const scriptDir = mkdtempSync(join(tmpdir(), 'refsure-pdfjs-script-'));
  afterAll(() => {
    rmSync(patchedDir, { recursive: true, force: true });
    rmSync(scriptDir, { recursive: true, force: true });
  });
  const script = join(scriptDir, 'read.mjs');
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
const [entry, file] = process.argv.slice(2);
const lib = await import(entry);
const data = new Uint8Array(readFileSync(file));
const doc = await lib.getDocument({ data, useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, verbosity: 0 }).promise;
const pages = [];
for (let n = 1; n <= doc.numPages; n++) {
  const content = await (await doc.getPage(n)).getTextContent();
  pages.push(content.items.map((i) => ('str' in i ? i.str : '')).join('|'));
}
process.stdout.write(JSON.stringify(pages));
`,
  );
  const run = (entry: string, name: string): string[] => {
    const file = join(process.cwd(), 'tests/fixtures/pages', name);
    const out = execFileSync(process.execPath, [script, pathToFileURL(entry).href, file], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out) as string[];
  };

  test.each(['arxiv-2402.03664v5-numeric.pdf', 'arxiv-2503.00258-twocol-authoryear.pdf', 'iclr-2401.00036-authoryear.pdf'])('%s', (name) => {
    writeFileSync(join(patchedDir, 'pdf.mjs'), stripPdfjsNetwork(read('legacy/build/pdf.mjs')));
    writeFileSync(join(patchedDir, 'pdf.worker.mjs'), stripPdfjsNetwork(read('legacy/build/pdf.worker.mjs')));
    const patched = run(join(patchedDir, 'pdf.mjs'), name);
    const original = run(join(PDFJS, 'legacy/build/pdf.mjs'), name);
    expect(patched.length).toBeGreaterThan(5);
    expect(patched).toEqual(original);
  }, 60_000);
});
