import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'wxt';
import type { TestProject } from 'vitest/node';

// One production build of each browser target for the whole run, made before any test file starts.
// WXT rewrites generated files under .wxt on every build; building from several test files at once
// raced on them (and could corrupt .wxt/tsconfig.json), so the builds are made here, one after the
// other, and tests that inspect the output (manifest.test.ts, pdfjsBundle.test.ts) read from it.
const noop = () => undefined;
const quietLogger = {
  debug: noop,
  log: noop,
  info: noop,
  success: noop,
  warn: noop,
  error: (...args: unknown[]) => console.error(...args),
  fatal: (...args: unknown[]) => console.error(...args),
  level: 0,
};

declare module 'vitest' {
  export interface ProvidedContext {
    /** Folder holding `<browser>/<browser>-mv3` for chrome, edge and firefox. */
    builtRoot: string;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const root = mkdtempSync(join(tmpdir(), 'refsure-built-'));
  for (const browser of ['chrome', 'edge', 'firefox'] as const) {
    await build({ browser, outDir: join(root, browser), logger: quietLogger });
  }
  project.provide('builtRoot', root);
  return () => rmSync(root, { recursive: true, force: true });
}
