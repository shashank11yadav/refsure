# Third-party papers in the fixtures

The fixtures hold copies or parts of the papers below, as test data for reading reference lists. Each is kept under
the licence its authors chose on arXiv (shown on the paper's abstract page). Where a file differs from what arXiv
serves, "Changes" says how.

Licences: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

## Openly licensed papers

| Files | Paper | Authors | arXiv | Licence | Changes |
|---|---|---|---|---|---|
| `pages/arxiv-2402.03664v5.html`, `pages/arxiv-2402.03664v5-numeric.pdf` | Partial Gromov-Wasserstein Metric | Yikun Bai, Rocio Diaz Martin, Abihith Kothapalli, Hengrong Du, Xinran Liu, Soheil Kolouri | [2402.03664v5](https://arxiv.org/abs/2402.03664v5) | CC BY 4.0 | HTML: trimmed (sections 2 to 5 and the appendices removed, with their table-of-contents entries). PDF: trimmed to pages 1 to 3 and 10 to 14 of 56 |
| `pages/arxiv-2503.00258.html`, `pages/arxiv-2503.00258-twocol-authoryear.pdf` | Decoupling Content and Expression: Two-Dimensional Detection of AI-Generated Text | Guangsheng Bao, Lihua Rong, Yanbin Zhao, Qiji Zhou, Yue Zhang | [2503.00258v1](https://arxiv.org/abs/2503.00258v1) | CC BY 4.0 | none |
| `pages/arxiv-2401.00036.html`, `pages/iclr-2401.00036-authoryear.pdf` | Discrete Distribution Networks | Lei Yang | [2401.00036v3](https://arxiv.org/abs/2401.00036v3) | CC0 1.0 | PDF: trimmed to pages 1, 3, 5 and 10 to 14 of 24; pictures replaced by a blank one-pixel image |
| `pages/arxiv-2503.00260-twocol-numeric.pdf` | Seeing A 3D World in A Grain of Sand | Yufan Zhang, Yu Ji, Yu Guo, Jinwei Ye | [2503.00260v2](https://arxiv.org/abs/2503.00260v2) | CC BY 4.0 | trimmed to pages 1, 2, 9, 10, 12 and 13 of 13; pictures replaced by a blank one-pixel image; the figures' embedded editing data (never displayed) removed |
| `pages/arxiv-2610.39097-authoryear.pdf` | Measuring Longer-Horizon Leveraged ETF Performance | Chris Murray, Marco Sammon | [2610.39097v1](https://arxiv.org/abs/2610.39097v1) | CC BY 4.0 | trimmed to pages 1, 2 and 32 to 35 of 35; pictures replaced by a blank one-pixel image |
| `pages/arxiv-2312.11805.html` | Gemini: A Family of Highly Capable Multimodal Models | Gemini Team, Google | [2312.11805v5](https://arxiv.org/abs/2312.11805v5) | CC BY 4.0 | none |
| `pages/arxiv-2610.28627.html` | Matrix Multiplication from Polynomial Packings: A Constructive and Elementary Proof of ω ≤ 9/4 | Rafael Pass | [2610.28627v1](https://arxiv.org/abs/2610.28627v1) | CC BY 4.0 | none |
| `pdf-text/ligo-1602.03837-last-pages.json`, `pdf-text/ligo-1602.03837-page-11.json` | Observation of Gravitational Waves from a Binary Black Hole Merger | B. P. Abbott et al. (LIGO Scientific Collaboration and Virgo Collaboration) | [1602.03837](https://arxiv.org/abs/1602.03837) | CC BY 4.0 | only the text runs (with positions) of pages 9 to 11 of 16, as read by pdf.js |
| `pdf-text/revtex-2610.28399-pages-23-24.json` | Fano formula for resonance poles in the Jost–random-phase approximation: Breit–Wigner-type peaks, Fano dips, and Fano-type peaks in ¹⁶O and ²⁰⁸Pb | Kazuhito Mizuyama | [2610.28399](https://arxiv.org/abs/2610.28399) | CC BY 4.0 | only the text runs (with positions) of pages 23 and 24 of 24, as read by pdf.js |

## Reference lists of other papers

These papers are under arXiv's non-exclusive licence, which does not let anyone else redistribute them. Only their
reference lists are kept, as bibliographic data; nothing else of the papers is.

| Files | Paper | Authors | arXiv | Changes |
|---|---|---|---|---|
| `pdf-text/nature-1803.00255-last-pages.json` | Ultrafast jamming of electrons into an amorphous entangled state | Yaroslav Gerasimenko, Igor Vaskivskyi, Jan Ravnik, Jaka Vodeb, Viktor V. Kabanov, Dragan Mihailovic | [1803.00255](https://arxiv.org/abs/1803.00255) | the text runs of pages 7 and 8 of 12, with the figure caption replaced by placeholder words of the same length |
| `pdf-text/revtex-2610.31730-page-13.json` | Newtonian I-Love-Q relations: An enthalpy-based approach | Athul Kunjipurayil, J. Piekarewicz | [2610.31730](https://arxiv.org/abs/2610.31730) | the text runs of page 13 of 13, with the closing paragraph and the acknowledgements replaced by placeholder words of the same length |

`citations.json` quotes single entries from the reference lists of several papers (its `source` field names each).

## No paper text

- `api/`: responses recorded from the lookup services (bibliographic metadata, no paper text).
- `pages/openreview-*.html`: real OpenReview forum pages with every name, abstract and reply replaced by placeholders
  (`pages/README.md`); the `*.handmade.html` pages are written by hand.
- `pages/arxiv-invented-screenshots.handmade.html`: an invented paper; every name, title, venue and identifier in it
  is made up.
