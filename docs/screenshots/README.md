# Screenshots

Taken by `tests/e2e/screenshots.spec.ts` (`REFSURE_UPDATE_SCREENSHOTS=1 npm run test:e2e`) from a real Chromium with
the built extension.

The paper in them is invented (`tests/fixtures/pages/arxiv-invented-screenshots.handmade.html`): its authors, title,
references, venues and identifiers are all made up, so no real person or paper is shown with a status. The lookup
services in that run are the test doubles in `tests/e2e/fakeApi.ts`, set up so every status appears at least once
(Verified, Details differ, Wrong ID, Retracted, Not found, Can't check).

| File | Shows |
|---|---|
| `panel-light-360.png`, `panel-dark-360.png` | Side panel at 360 px wide, light and dark |
| `panel-light-480.png`, `panel-dark-480.png` | Side panel at 480 px wide, light and dark |
| `panel-details-light-360.png` | A "Details differ" row expanded, cited and found side by side |
| `page-badges-light.png`, `page-badges-dark.png` | Inline badges on the paper's reference list, light and dark |
| `store-light-1280.png`, `store-dark-1280.png` | The side panel (360 px) beside the paper with its badges, at 1280 x 800 (the store listings' size), light and dark |
| `store-details-light-1280.png` | The same at 1280 x 800 with the "Details differ" row expanded |
| `settings-light-1280.png`, `settings-dark-1280.png` | The settings page at 1280 x 800, light and dark: the default switches, Advanced open, no OpenAlex key. It shows no reference data |

A headless browser cannot open the real side panel, so the `store-*` images put a screenshot of the panel page next to
a screenshot of the paper, with a one-pixel divider where Chrome draws the panel's edge.
