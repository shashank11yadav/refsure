// Reading the bibliography of an arXiv HTML paper (LaTeXML output). Every string comes
// from the page text and is returned as inert text; nothing here builds markup.

import type { RawReference } from '../core/types';
import { ANCHOR_ID, squashSpace, textOf } from './domText';

const MAX_REFERENCES = 2000;
const MAX_REFERENCE_CHARS = 5000;
const MAX_LABEL_CHARS = 100;
const ISBN = /\bISBN[\s:]*[\dXx][\dXx -]{8,20}[\dXx]/;

function childrenWithClass(parent: Element, className: string): Element[] {
  return Array.from(parent.children).filter((child) => child.classList.contains(className));
}

function readReference(item: Element, position: number): RawReference | undefined {
  const tag = childrenWithClass(item, 'ltx_tag_bibitem')[0];
  // The tag is read whole, as the page shows it ("[5]", "[DGV+19]", "Vaswani et al. (2017)"):
  // never matched with a pattern, so no label can be cut short or run into the authors.
  const label = (tag ? textOf([tag], MAX_LABEL_CHARS) : '') || `[${position}]`;

  // LaTeXML adds "External Links: ..." and "Cited by: §2" to the entry; neither is part of the reference. The one
  // thing in the links that says what the entry is, an ISBN (a book), is kept as a block of its own.
  const blocks: string[] = [];
  for (const block of childrenWithClass(item, 'ltx_bibblock')) {
    if (block.classList.contains('ltx_bib_cited')) continue;
    const text = textOf([block], MAX_REFERENCE_CHARS);
    if (block.querySelector('.ltx_bib_external, .ltx_bib_links') === null) {
      if (text !== '') blocks.push(text);
      continue;
    }
    const isbn = ISBN.exec(text)?.[0];
    if (isbn !== undefined) blocks.push(isbn);
  }
  const text =
    blocks.length > 0
      ? squashSpace(blocks.join(' ')).slice(0, MAX_REFERENCE_CHARS)
      : textOf(Array.from(item.childNodes).filter((node) => node !== tag), MAX_REFERENCE_CHARS);
  if (text === '') return undefined;

  const id = item.getAttribute('id');
  return {
    index: position,
    label,
    text,
    ...(blocks.length > 0 && { blocks }),
    ...(id !== null && ANCHOR_ID.test(id) && { anchorId: id }),
  };
}

/** The references of an arXiv HTML paper, in page order, numbered from 1. */
export function extractArxivReferences(doc: Document): RawReference[] {
  const refs: RawReference[] = [];
  for (const item of Array.from(doc.querySelectorAll('li.ltx_bibitem'))) {
    if (refs.length >= MAX_REFERENCES) break;
    const ref = readReference(item, refs.length + 1);
    if (ref) refs.push(ref);
  }
  return refs;
}
