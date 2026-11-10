import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as viteBuild } from 'vite';
import { afterAll, describe, expect, inject, test } from 'vitest';
import { pdfjsTextOnly } from '../../scripts/pdfjsBuild';
import { networkViolations } from './helpers/builtNetwork';

// What actually ships. pdf.js must arrive text-only: none of its Node code path (the
// `@napi-rs/canvas` require, file and stream access), none of its own network code, its
// worker as a file inside the package, and only in the pages that run it (the offscreen
// document on Chrome/Edge, the background page on Firefox, which starts the worker file as a module worker).


// Strings that only the Node path, the network code or generated code leave behind.
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['@napi-rs/canvas', /napi-rs/],
  ['a native canvas module', /canvas\.node/],
  ['process.getBuiltinModule', /getBuiltinModule/],
  ['createRequire', /createRequire/],
  ['require()', /(?<![\w$.])require\s*\(/],
  ['an import of a Node built-in', /from\s*["'](?:node:)?(?:fs|path|url|stream|module|http|https|os|child_process|worker_threads)["']/],
  ['eval', /(?<![\w$.])eval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
];

// Strings that exist only in pdf.js's worker (font and image decoders), so a bundle holding them carries the worker.
const WORKER_ONLY_CODE = /XRefParseException|Jbig2/;

function scripts(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(js|mjs)$/.test(f));
}

describe('built extension (WXT)', () => {
  // Built once for the whole run (tests/globalSetup.ts).
  const root = inject('builtRoot');
  const dirs = { chrome: join(root, 'chrome', 'chrome-mv3'), edge: join(root, 'edge', 'edge-mv3'), firefox: join(root, 'firefox', 'firefox-mv3') };

  test.each(['chrome', 'edge'] as const)('%s: the offscreen page and its worker ship inside the package', (browser) => {
    const dir = dirs[browser];
    expect(existsSync(join(dir, 'offscreen.html'))).toBe(true);
    const html = readFileSync(join(dir, 'offscreen.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    const files = scripts(dir);
    const worker = files.filter((f) => /^assets\/pdf\.worker/.test(f));
    expect(worker).toHaveLength(1);
    // A tiny module holds the worker's address ("/assets/pdf.worker...mjs"), a path inside the package.
    const address = files.find((f) => /^chunks\/pdf\.worker/.test(f)) ?? '';
    expect(readFileSync(join(dir, address), 'utf8')).toContain(`/${worker[0]}`);
  });

  test.each(['chrome', 'edge'] as const)('%s: the worker is not inlined as a data: or blob: URL', (browser) => {
    const dir = dirs[browser];
    const offscreen = readFileSync(join(dir, scripts(dir).find((f) => /offscreen-/.test(f)) ?? ''), 'utf8');
    expect(offscreen).not.toMatch(/data:(?:text|application)\/javascript/);
  });

  test('firefox: no offscreen page is built (the background page parses)', () => {
    expect(existsSync(join(dirs.firefox, 'offscreen.html'))).toBe(false);
  });

  test('firefox: the worker is one file at a fixed path in the package, rewritten, and the background does not carry it', () => {
    const worker = join(dirs.firefox, 'pdf.worker.mjs');
    expect(existsSync(worker)).toBe(true);
    const text = readFileSync(worker, 'utf8');
    expect(text).toContain('fetchDisabledByRefSure');
    expect(networkViolations(text)).toEqual([]);
    // The page that starts it (the background) names that path and nothing else: no hashed name, no data: or blob: worker.
    const background = readFileSync(join(dirs.firefox, 'background.js'), 'utf8');
    expect(background).toContain('pdf.worker.mjs');
    expect(background).not.toMatch(WORKER_ONLY_CODE);
    expect(background).not.toMatch(/data:(?:text|application)\/javascript|blob:/);
    expect(scripts(dirs.firefox).filter((f) => /pdf\.worker/.test(f))).toEqual(['pdf.worker.mjs']);
  });

  test.each(['chrome', 'edge'] as const)('%s: no fixed-path worker; the worker stays the hashed asset of the offscreen build', (browser) => {
    expect(existsSync(join(dirs[browser], 'pdf.worker.mjs'))).toBe(false);
  });

  test.each(['chrome', 'edge', 'firefox'] as const)('%s: no Node-only code, eval or native canvas in any script', (browser) => {
    const files = scripts(dirs[browser]);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(dirs[browser], file), 'utf8');
      for (const [name, pattern] of FORBIDDEN) expect(pattern.test(text), `${browser}/${file} contains ${name}`).toBe(false);
    }
  });

  test.each(['chrome', 'edge'] as const)('%s: pdf.js is in the offscreen page only, not in the service worker', (browser) => {
    const dir = dirs[browser];
    const background = readFileSync(join(dir, 'background.js'), 'utf8');
    expect(background).not.toMatch(/getTextContent|GlobalWorkerOptions|PDFWorker/);
    // The regex above is the real check. The size is a backstop: pdf.js alone is megabytes (its minified build
    // about 450 KB), while the background carries the checker, the lookup adapters and the message hub (about
    // 150 KB).
    expect(background.length).toBeLessThan(200_000);
  });
});

describe('pdf.js placement by browser (parseHost bundled as the background would)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refsure-placement-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const parseHost = resolve(__dirname, '../../src/extract/parseHost.ts');

  async function bundleAll(firefox: boolean): Promise<{ code: string; assets: string[] }> {
    const entry = join(dir, `entry-${firefox ? 'firefox' : 'chrome'}.ts`);
    writeFileSync(entry, `import { parseInHost } from ${JSON.stringify(parseHost)};\nexport const run = () => parseInHost({ kind: 'arxiv-html-text', html: '' });\n`);
    const output = await viteBuild({
      configFile: false,
      logLevel: 'silent',
      root: dir,
      plugins: [pdfjsTextOnly({ emitWorkerAt: firefox ? 'pdf.worker.mjs' : undefined })],
      define: { 'import.meta.env.FIREFOX': JSON.stringify(firefox) },
      build: {
        write: false,
        minify: true,
        sourcemap: false,
        assetsInlineLimit: 0,
        lib: { entry, formats: ['es'], fileName: 'out' },
        rollupOptions: { output: { codeSplitting: false } },
      },
    });
    const outputs = Array.isArray(output) ? output : [output];
    const files = outputs.flatMap((o) => ('output' in o ? o.output : []));
    return { code: files.map((c) => ('code' in c ? c.code : '')).join('\n'), assets: files.filter((c) => c.type === 'asset').map((c) => c.fileName) };
  }
  const bundle = async (firefox: boolean): Promise<string> => (await bundleAll(firefox)).code;

  test('Chrome and Edge background code does not include pdf.js', async () => {
    const code = await bundle(false);
    expect(code).not.toMatch(/getTextContent|GlobalWorkerOptions/);
    expect(code.length).toBeLessThan(50_000);
  }, 120_000);

  test('Firefox background code includes pdf.js but not its worker, which is emitted as a file at a fixed path', async () => {
    const { code, assets } = await bundleAll(true);
    expect(code).toMatch(/getTextContent/);
    expect(code).not.toMatch(WORKER_ONLY_CODE);
    expect(code).toContain('pdf.worker.mjs');
    expect(assets).toEqual(['pdf.worker.mjs']);
    for (const [name, pattern] of FORBIDDEN) expect(pattern.test(code), `contains ${name}`).toBe(false);
    // No http.ts in this bundle, so any fetch() or XMLHttpRequest left in pdf.js would show up here.
    expect(networkViolations(code)).toEqual([]);
    expect(code).not.toMatch(/data:(?:text|application)\/javascript/);
  }, 120_000);

  test('Chrome and Edge builds emit no fixed-path worker', async () => {
    expect((await bundleAll(false)).assets).toEqual([]);
  }, 120_000);
});
