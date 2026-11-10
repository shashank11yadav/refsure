# PDF text fixtures

Positioned text runs (what `readPdfPages` returns: `{ width, height, runs: [{ str, x, y, width, height }] }`) of the
last pages of real arXiv papers, extracted with the bundled pdf.js on 2026-10-26 from `https://arxiv.org/pdf/<id>`.
Only the text and its positions are kept, not the PDFs. Used by `tests/unit/extract/pdfReferences.test.ts`.

Two of the papers are under arXiv's non-exclusive licence, which does not let anyone else redistribute them. Their
files keep only the reference list as extracted; every other word on those pages (a figure caption, a closing
paragraph, the acknowledgements) is replaced by a placeholder word of the same length, so positions, widths, line
ends and punctuation are unchanged and the list reads exactly as before. Sources and licences: `../ATTRIBUTION.md`.

| File | Paper | Pages kept | Why it is here |
|---|---|---|---|
| `ligo-1602.03837-last-pages.json` | Observation of Gravitational Waves from a Binary Black Hole Merger (PRL style) | 9 and 10 of 16 | `[n]` list in two columns straight after the text, with **no "References" heading**; 111 entries, followed by the author affiliations |
| `ligo-1602.03837-page-11.json` | the same paper (read on 2026-10-29 from the evaluation's cached copy of the same PDF, positions rounded to 0.1 pt as above) | 11 of 16 | the end of the list, **[112]–[118] in two short columns above the full-width author list**: read after the two pages above, 118 entries |
| `nature-1803.00255-last-pages.json` | a Nature-style letter on 1T-TaS2 | 7 and 8 of 12 | `n.` list with continuation lines, **no heading**; 32 entries, followed by figures. The figure caption above the list is placeholder words |
| `revtex-2610.31730-page-13.json` | Newtonian I-Love-Q relations: An enthalpy-based approach (RevTeX two-column; read on 2026-11-03 from the evaluation's cached copy, positions rounded to 0.1 pt) | 13 of 13 | `[n]` list with **no heading**, starting halfway down the page under the closing paragraph, which fills the top of both columns: read column by column, the right half of that paragraph falls between [22] and [23]; 40 entries. The paragraph and the acknowledgements are placeholder words |
| `revtex-2610.28399-pages-23-24.json` | Fano formula for resonance poles in the Jost random-phase approximation (RevTeX two-column; read the same way) | 23 and 24 of 24 | the same layout with **equations** above the list in the right column, which used to end the list at [21]; 65 entries |
