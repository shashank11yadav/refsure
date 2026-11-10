// The one error type for a paper that could not be read. The message is safe to show: it never
// quotes the file. Kept in its own small module so code that must not load pdf.js (the Chrome
// service worker) can still use it.

export const PDF_READ_REASONS = ['invalid', 'password', 'timeout'] as const;
export type PdfReadReason = (typeof PDF_READ_REASONS)[number];

export class PdfReadError extends Error {
  constructor(
    message: string,
    readonly reason: PdfReadReason,
  ) {
    super(message);
    this.name = 'PdfReadError';
  }
}
