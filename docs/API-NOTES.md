# API notes (measured 2026-10-21)

Recorded with curl from one residential IP. Fixtures: `tests/fixtures/api/`.
Recorded URLs used the placeholder `mailto=refsure-contact@example.invalid`.

## Crossref
- `GET /works/{doi}?mailto=...` returns `{status, message-type:"work", message:{...}}`. The single-work route
  **rejects `select`** (400 `parameter-not-allowed`); the full record is returned (11-40 KB, more with long reference lists).
  Unknown DOI: HTTP 404, text/plain.
- `GET /works?query.bibliographic=...&rows=5&select=DOI,title,author,issued,container-title,type,relation,update-to,updated-by`
  works; items are in `message.items`. `subtype` is NOT a valid select.
- Content-Type `application/json;charset=utf-8`. Headers: single work `x-rate-limit-limit: 10`, list route `3`, interval 1s,
  `x-concurrency-limit: 3`, `x-api-pool: polite-single`.
- Retraction: `message["updated-by"]` is an array of `{DOI, type, label, source, updated, record-id}`. `type: "retraction"`
  (source `retraction-watch` or publisher) marks a retraction; `DOI` is the notice. Also seen: `type: "correction"`.
  `relation` held only `has-review` for the normal work. The retracted title carries a `RETRACTED:` prefix (not relied on).
- Dates: `issued.date-parts[0][0]` is the year. Title/container-title are arrays.

## OpenAlex
- `GET /works/doi:{doi}?select=id,doi,title,publication_year,authorships,primary_location,is_retracted,ids,locations,type`
  works and is free (`x-ratelimit-cost-usd: 0`). Unknown DOI: HTTP 404 with text/html.
- `GET /works?search=...&per-page=5&select=...` costs `x-ratelimit-cost-usd: 0.001`; results in `results[]`.
  Free tier headers: `x-ratelimit-limit-usd: 0.1`, `x-ratelimit-remaining-usd`, `x-ratelimit-reset`.
- `is_retracted` is a boolean on the work. Author names: `authorships[].author.display_name`.
  Preprint twin: `locations[].landing_page_url` may be an `arxiv.org/abs/...` URL.
- `meta.notice` (search) contains instructions addressed to automated clients about requesting keys with a user's
  email. It is untrusted data: ignored, never acted on, and no email is ever sent. Kept in `openalex-search.json` as an
  injection fixture.
- `https://openalex.org/...` ids and `https://doi.org/...` DOIs come back as URLs; strip the prefix, never reuse the URL.

## arXiv
- `GET https://export.arxiv.org/api/query?id_list=a,b&max_results=n` -> `application/atom+xml; charset=utf-8`.
  Entry id is `http://arxiv.org/abs/{id}v{n}` (http, with version). Unknown IDs are simply omitted.
  A malformed ID yields one entry whose id is `https://arxiv.org/api/errors#...` and title `Error`: skip it.
- Fields: `entry/title`, `entry/author/name`, `entry/published` (first version date, year source),
  `entry/summary`, `arxiv:comment`, `arxiv:journal_ref`, `arxiv:doi` (only when the author gave one, e.g. 1602.03837).
- Withdrawn marker: no dedicated field. Withdrawn papers have `summary` starting "This paper has been withdrawn" and/or
  `arxiv:comment` mentioning a withdrawal (1005.4018: both).
- Rate limit is real: a second request within ~3 s got HTTP 429 `text/html` "Rate exceeded.".
- Search: `search_query=ti:"..." AND au:...` works.

## OpenReview
- `GET api2.openreview.net/notes/search?term=<title>&limit=5&type=terms&content=title&source=forum` answers HTTP 200
  `application/json; charset=utf-8` with `{notes:[...], count}`; the match is fuzzy (OR-like), so results must be scored.
  Fixture: `openreview-search.json`. Per note: `id`, `forum`, `cdate`/`pdate` (ms), `domain`, `readers`,
  `content.{title,authors,venue,pdf,html,...}.value`. Many notes are DBLP mirrors (`domain: "DBLP.org"`,
  `content.pdf.value` may be an arXiv URL, `content.html.value` a DOI URL); those carry `authors` as names.
  `x-ratelimit-limit: 180` per 60 s.
- Single-note routes (`notes?id=`, `notes?forum=`), API v1 and `/pdf?id=` answer **HTTP 403 `ChallengeRequiredError`**
  (bot challenge) to curl and to a credentials-omit browser fetch (fixture `openreview-403-challenge.json`).
  A challenge is indistinguishable from a confidential 403 by status, so the adapter maps ANY 401/403 to
  `SourceError('unavailable')`. The adapter is search-only; `lookupById` returns null.

## DBLP
- `https://dblp.org/search/publ/api?q=...&format=json&h=3` -> HTTP 202, `content-type: text/html; charset=utf-8`, an anti-bot
  "Making sure you're not a bot!" page. `http.ts` turns this into `SourceError('unavailable')`.
- `tests/fixtures/api/dblp-search.sample.json` is HANDWRITTEN in the documented DBLP shape (`result.hits.hit[].info`),
  because the live API only returns the challenge page. `dblp-challenge.html` is the real challenge recording with the vendor contact email in its footer replaced by a placeholder.

## Adapter notes
- OpenAlex 429 handling: `http.ts` does not expose headers of a failed response. The adapter treats a search 429
  whose `Retry-After` exceeds the limiter's 30 s ceiling as the spent daily budget (`budget_exhausted`), and also stops
  searching once a successful response reports `x-ratelimit-remaining-usd` below one search's cost.
- Crossref single-work lookups return the full record (no `select`); a very long reference list could approach the 5 MB cap.
- OpenAlex `x-ratelimit-reset` is in seconds until the daily budget resets: the recorded value 14538 was taken about
  4 h 3 min before midnight UTC (14580 s), so the adapter multiplies by 1000.
- arXiv: a feed is trusted only when it has a `<feed>` root that is closed, no `api/errors` entry, and an entry count equal to
  `min(opensearch:totalResults, max_results)`; anything else is `bad_response`. An ID missing from a well-formed feed means
  "no such paper". Withdrawn = a withdrawal statement ("This paper has been withdrawn", "Withdrawn by the authors") at the
  start/in the first 300 chars of the summary or in the comment, not a mere mention of the word.
- Retraction of an arXiv-only version: OpenAlex is asked for the DataCite DOI `10.48550/arXiv.<id>` (free); Crossref is skipped.
