# RefSure privacy policy

Effective date: 2026-11-09

RefSure is a browser extension that checks the references of arXiv and public OpenReview papers against public scholarly databases. This page says what it sends, to whom, and what it keeps.

## The short version

- The developer receives nothing. RefSure has no server, no account, no analytics, no crash reporting and no ads. Nothing is sold or shared for any purpose other than the lookup you asked for.
- When you run a check, the reference details of that paper are sent to public databases. That is what the extension is for. Those details are website content, so the Firefox build declares website content as data it sends.
- Settings, history and a lookup cache stay on your device.

## What is sent, and to whom

RefSure sends data only when you click the toolbar button to check a paper, or after you turn on automatic checking in the panel settings. Automatic checking is off by default. Nothing is sent when you only browse.

What is sent:

- **Reference text fragments from the paper you are checking:** titles, author names, years, DOIs and arXiv IDs. For a citation without a title, such as a physics journal citation, the journal, volume and first page are sent instead.
- **The paper's own identifier,** its arXiv ID, to fetch the paper's HTML or PDF from arXiv. For a public OpenReview paper, the paper's title is sent to arXiv to find its arXiv version.
- **The project's contact address,** sent to Crossref as a `mailto` parameter, which Crossref's rules ask for. It is the project's address (see Contact below). It is never your address.
- **Your own OpenAlex API key,** only if you chose to enter one. It is sent to OpenAlex only.

Where it goes:

| Service | Address | What it receives |
|---|---|---|
| Crossref | api.crossref.org | Reference text fragments, and the project contact address |
| arXiv | arxiv.org, export.arxiv.org | The paper's arXiv ID, reference text fragments, and an OpenReview paper's title |
| OpenReview | api2.openreview.net | Reference text fragments (title search) |
| OpenAlex | api.openalex.org | Reference text fragments, and your key if you entered one |
| DBLP | dblp.org | Reference text fragments (optional, best-effort) |

Every request is sent without cookies and without a referrer. RefSure does not send your name, your browser history, your other tabs or anything about you. It does not use your OpenReview login.

Like any website, these services can see your network address when they answer a request, and they have their own privacy policies. RefSure sends the requests directly from your browser. No request passes through a server run by the developer.

If an OpenReview page is confidential, or RefSure cannot tell that it is public, nothing is sent: not the references and not the title. RefSure does not run in private or incognito windows.

## What is stored on your device

RefSure keeps this in the browser's extension storage, on your device only. Nothing is synced to any account.

- **Settings:** your choices for automatic checking and history, and your OpenAlex key if you entered one.
- **History:** the latest results for up to 50 papers you checked, with each paper's title and address, so reopening a paper shows them at once.
- **Lookup cache:** answers from the databases, kept for a few days up to two weeks, so repeat checks are faster and use fewer requests.

You can turn history off in the panel settings. Doing so deletes saved checks and stops the cache too. "Clear history" deletes saved checks and the cache. "Remove key" deletes your OpenAlex key. Removing the extension deletes everything it stored.

## What RefSure does not do

- It does not collect, send or store anything for the developer.
- It does not use analytics, telemetry, advertising or tracking of any kind.
- It does not sell or rent data, and it does not use data for anything but the lookup you asked for.
- It does not run remote code. All its code ships inside the extension.

## Permissions

RefSure asks for access only to the sites it needs: arxiv.org, export.arxiv.org, openreview.net, api2.openreview.net, api.crossref.org, api.openalex.org and dblp.org, and the browser permissions `storage`, `activeTab`, the side panel (a sidebar in Firefox) and, in Chrome and Edge, `offscreen`. The reasons are in `docs/STORE-LISTING.md`.

## Changes

If this policy changes, the effective date above changes with it.

## Contact

Questions about this policy: yshashank7575@gmail.com
