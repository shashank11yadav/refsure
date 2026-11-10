// Addresses of files in the extension's own package.

import { browser } from 'wxt/browser';

/**
 * The full address of a file in the package, from its path ("/welcome.html"). WXT types `getURL` with the public
 * files it knows of, which leaves out our pages, the offscreen document and the pdf.js worker the build copies in,
 * so the path goes through untyped here, in one place.
 */
export function extensionUrl(path: string): string {
  return browser.runtime.getURL(path as never);
}
