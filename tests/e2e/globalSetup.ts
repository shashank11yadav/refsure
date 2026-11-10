import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'wxt';

// The e2e tests load `.output/chrome-mv3`. Build it first when it is missing or older than any file
// that goes into it, so `npm run test:e2e` never runs against a stale extension.
const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT = join(ROOT, '.output/chrome-mv3');
const INPUTS = ['src', 'public', 'wxt.config.ts', 'package.json', 'scripts'];

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return readdirSync(path).reduce((newest, name) => Math.max(newest, newestMtime(join(path, name))), stat.mtimeMs);
}

export default async function globalSetup(): Promise<void> {
  const manifest = join(OUTPUT, 'manifest.json');
  const builtAt = existsSync(manifest) ? statSync(manifest).mtimeMs : 0;
  const changedAt = Math.max(...INPUTS.map((input) => newestMtime(join(ROOT, input))));
  if (builtAt > changedAt) return;
  console.log('[e2e] building the Chrome extension...');
  const noop = (): undefined => undefined;
  await build({
    browser: 'chrome',
    root: ROOT,
    logger: { debug: noop, log: noop, info: noop, success: noop, warn: noop, error: console.error, fatal: console.error, level: 0 },
  });
}
