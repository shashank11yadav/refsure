// A "Note: ..." field (BibTeX's note, which LaTeXML renders as its own block at the end of an entry) says something
// about a reference: where its data is, that it is a working paper, an erratum, a gazette or a product code. It says
// nothing about where the work itself was published, so it never counts as the venue that lets a reference be Not found.

// From "Note:" to the end of the entry: a note is the last field of a rendered entry.
export const NOTE_FIELD = /(?:^|\s)Note:\s[\s\S]*$/;

/** The text without its note field. */
export function withoutNoteField(text: string): string {
  return text.replace(NOTE_FIELD, ' ');
}
