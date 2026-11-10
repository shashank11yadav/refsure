import { defineConfig } from 'wxt';
import { ALLOWED_HOST_PATTERNS, extensionPagesCsp, FIREFOX_PDF_WORKER } from './src/config';
import { pdfjsTextOnly } from './scripts/pdfjsBuild';

// Permissions and host list are pinned by tests/unit/manifest.test.ts and
// SECURITY.md section 3. Do not add to them without the maintainer's approval.
const GECKO_ID = '{d5793b66-7905-49f1-93d5-48f456578f2d}';

export default defineConfig({
  srcDir: 'src',
  // WXT builds Firefox as MV2 unless told otherwise; all three targets are MV3.
  manifestVersion: 3,
  // Build for Chrome, Edge and Firefox with `npm run build` (see package.json).
  manifest: ({ browser, command }) => ({
    name: 'RefSure',
    description:
      'Checks the references on public arXiv and OpenReview papers against public databases. The developer receives nothing.',
    // `sidePanel` (Chrome/Edge) is added by WXT from the sidepanel entrypoint;
    // Firefox gets `sidebar_action` instead and has no offscreen documents.
    permissions: browser === 'firefox' ? ['storage', 'activeTab'] : ['storage', 'activeTab', 'offscreen'],
    host_permissions: [...ALLOWED_HOST_PATTERNS],
    // No private windows: nothing the user reads there should be looked up, cached or listed in history.
    // The same key disables private windows in Chrome, Edge and Firefox.
    incognito: 'not_allowed',
    content_security_policy: { extension_pages: extensionPagesCsp(command) },
    // The toolbar button opens the side panel and starts a check (src/background/hub.ts).
    action: {
      default_title: 'Check references with RefSure',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    },
    // Chrome and Edge: the side panel needs 116, and the bundled pdf.js calls Uint8Array.prototype.toHex
    // (Chrome 140) on every PDF it opens. Firefox has had toHex since 133; its floor is set below.
    ...(browser !== 'firefox' && { minimum_chrome_version: '140' }),
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: GECKO_ID,
          // data_collection_permissions is understood from Firefox 140 on (desktop).
          strict_min_version: '140.0',
          // Reference text from the page is sent to the lookup services on Check.
          data_collection_permissions: { required: ['websiteContent'], optional: [] },
        },
        // Firefox for Android has no sidebar, so RefSure is not offered there (leave Android
        // unticked on AMO). Android learned data_collection_permissions in 142.
        gecko_android: { strict_min_version: '142.0' },
      },
    }),
  }),
  // Production builds ship no source maps (SECURITY.md section 6).
  // The module-preload polyfill would add a stray fetch() to every page bundle
  // (the network belongs to src/sources/http.ts alone); extension pages load from disk.
  // pdf.js is made text-only at build time (scripts/pdfjsBuild.ts); its worker must always ship
  // as a file inside the package, never inlined as a data: URL. Chrome and Edge import it as an
  // asset in the offscreen build; Firefox has it emitted at a fixed path for the background page.
  // The Firefox sources ZIP (for AMO review) carries only what builds the extension, plus the readme,
  // privacy and security notes and the licence (the third-party notices are in public/): no tests, fixtures,
  // eval tooling or planning notes.
  zip: {
    includeSources: ['src/**', 'public/**', 'scripts/pdfjsBuild.ts', 'package.json', 'package-lock.json', 'tsconfig.json', 'wxt.config.ts', 'README.md', 'PRIVACY.md', 'SECURITY.md', 'LICENSE', '.nvmrc'],
  },
  vite: ({ browser }) => ({
    plugins: [pdfjsTextOnly({ emitWorkerAt: browser === 'firefox' ? FIREFOX_PDF_WORKER : undefined })],
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    build: { sourcemap: false, modulePreload: { polyfill: false }, assetsInlineLimit: 0 },
  }),
});
