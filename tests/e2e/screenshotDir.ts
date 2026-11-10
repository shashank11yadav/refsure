import { join } from 'node:path';

/**
 * Where the screenshot spec writes. The tracked files in docs/screenshots are replaced only on purpose
 * (`REFSURE_UPDATE_SCREENSHOTS=1 npm run test:e2e`); an ordinary run writes under test-results, which git ignores.
 */
export function screenshotDir(root: string, env: Record<string, string | undefined>): string {
  return env['REFSURE_UPDATE_SCREENSHOTS'] === '1' ? join(root, 'docs/screenshots') : join(root, 'test-results/screenshots');
}
