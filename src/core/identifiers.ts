// Finding and validating DOIs, arXiv IDs and OpenReview IDs, and building links
// from them (and from OpenAlex work ids and DBLP record keys, which are never found in text). Every URL here is assembled from a validated identifier and a fixed
// base (SECURITY.md section 4); nothing from a page or API response is used as a URL.

import { API } from '../config';

const DOI_BASE = 'https://doi.org/';

// Registrant code is 4 to 9 digits (SECURITY.md section 4). The suffix may hold
// almost anything but whitespace and control characters.
// \p{Cf} covers zero-width and bidi-control characters (U+200B-200F, U+202A-202E,
// U+2066-2069, U+FEFF) that could make a link look different from what it opens.
// \p{Cs} (lone surrogates) would make encodeURIComponent throw a URIError.
const DOI_PATTERN = /^10\.\d{4,9}\/[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u;
const MAX_DOI_LENGTH = 256;
// A little above MAX_DOI_LENGTH so a valid DOI followed by trailing punctuation is
// still found, while hostile text cannot make the trimming work on megabytes.
const MAX_CANDIDATE_LENGTH = 300;

const NEW_ARXIV = String.raw`\d{4}\.\d{4,5}`;
const OLD_ARXIV = String.raw`[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7}`;
const ARXIV_ID = `(?:${NEW_ARXIV}|${OLD_ARXIV})(?:v\\d+)?(?!\\d)`;

const ARXIV_VALID = new RegExp(`^${ARXIV_ID}$`);
const OPENREVIEW_VALID = /^[A-Za-z0-9_-]{6,64}$/;
// An OpenAlex work: "W" and digits (W2626778328). Other entity kinds (A authors, I institutions) are not papers.
const OPENALEX_WORK_VALID = /^W\d{1,15}$/;
// A DBLP publication key: its kind, then two or three ASCII segments ("conf/nips/VaswaniSPUJGKP17",
// "journals/corr/abs-1706-03762", "books/sp/16/Smith16"). No dot, so no "." or ".." segment can leave /rec/.
const DBLP_KEY_VALID = /^(?:journals|conf|books|series|reference|phd|tr|ms)(?:\/[A-Za-z0-9_-]{1,64}){2,3}$/;
// The work's web page; the bare id URI `https://openalex.org/W…` is an identifier, not the page.
const OPENALEX_SITE = 'https://openalex.org/works/';
const DBLP_RECORD_BASE = 'https://dblp.org/rec/';

// A bare "1234.56789" is too easily a page range or a volume, so a new-style ID
// is only accepted after "arXiv" (including arxiv.org/abs/, arxiv.org/pdf/ and the
// 10.48550/arXiv.* DOI form) or after the "abs/" that DBLP prints for CoRR entries.
const ARXIV_PREFIXED = new RegExp(String.raw`\barxiv(?:\.org)?(?:\s*[:/.]\s*|\s+)(?:(?:abs|pdf)\/)?(${ARXIV_ID})`, 'i');
const ARXIV_ABS = new RegExp(String.raw`\babs\/(${ARXIV_ID})`);
// Old-style IDs ("hep-th/9901001") are distinctive enough to stand alone.
const ARXIV_OLD_BARE = new RegExp(String.raw`(?<![\w/.-])(${OLD_ARXIV}(?:v\d+)?)(?!\d)`);
// INSPIRE and JHEP styles print the eprint alone in square brackets: "JHEP 03 (2022) 054 [2201.04634]". Inside brackets,
// with a real year and month (YYMM) in front, it is not a page range or a volume.
// Only when the entry prints one such id: a multi-part entry ("...; Erratum: ... [2203.00001]", a companion paper)
// carries several, and which one is the cited work's cannot be told.
const ARXIV_BRACKETED = /\[\s*(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?)\s*\]/g;

const DOI_CANDIDATE = new RegExp(String.raw`(?<![\w.])10\.\d{4,9}\/[^\s"]{1,${MAX_CANDIDATE_LENGTH}}`);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', "'", ']', '}', '>']);

// One pass over the candidate: drop trailing punctuation, and a closing parenthesis
// unless it balances one inside the DOI.
function trimDoiTail(candidate: string): string {
  let opens = 0;
  let closes = 0;
  for (const ch of candidate) {
    if (ch === '(') opens++;
    else if (ch === ')') closes++;
  }
  let end = candidate.length;
  while (end > 0) {
    const ch = candidate.charAt(end - 1);
    if (TRAILING_PUNCTUATION.has(ch)) end--;
    else if (ch === ')' && closes > opens) {
      closes--;
      end--;
    } else break;
  }
  return candidate.slice(0, end);
}

export function findDoi(text: string): string | undefined {
  const candidate = DOI_CANDIDATE.exec(text)?.[0];
  if (candidate === undefined) return undefined;
  const doi = trimDoiTail(candidate);
  return isValidDoi(doi) ? doi : undefined;
}

export function findArxivId(text: string): string | undefined {
  return (ARXIV_PREFIXED.exec(text) ?? ARXIV_ABS.exec(text) ?? ARXIV_OLD_BARE.exec(text))?.[1] ?? bracketedArxivId(text);
}

function bracketedArxivId(text: string): string | undefined {
  const ids = new Set([...text.matchAll(ARXIV_BRACKETED)].map((m) => stripArxivVersion(m[1] ?? '')));
  return ids.size === 1 ? [...text.matchAll(ARXIV_BRACKETED)][0]?.[1] : undefined;
}

export function stripArxivVersion(id: string): string {
  return id.replace(/v\d+$/, '');
}

export function isValidDoi(s: string): boolean {
  if (s.length > MAX_DOI_LENGTH || !DOI_PATTERN.test(s)) return false;
  // "." and ".." segments would be resolved by the browser and leave doi.org's path.
  return !s.split('/').some((segment) => segment === '.' || segment === '..');
}

export function isValidArxivId(s: string): boolean {
  return ARXIV_VALID.test(s);
}

export function isValidOpenReviewId(s: string): boolean {
  return OPENREVIEW_VALID.test(s);
}

export function doiUrl(doi: string): string {
  if (!isValidDoi(doi)) throw new Error('Invalid DOI');
  // DOIs may contain ? # and similar; escape each path segment so they cannot
  // change the structure of the URL.
  return DOI_BASE + doi.split('/').map(encodeURIComponent).join('/');
}

export function arxivUrl(id: string): string {
  if (!isValidArxivId(id)) throw new Error('Invalid arXiv ID');
  return `${API.arxivSite}/abs/${id}`;
}

export function openreviewUrl(id: string): string {
  if (!isValidOpenReviewId(id)) throw new Error('Invalid OpenReview ID');
  return `${API.openreviewSite}/forum?id=${id}`;
}

export function isValidOpenAlexWorkId(s: string): boolean {
  return OPENALEX_WORK_VALID.test(s);
}

export function isValidDblpKey(s: string): boolean {
  return DBLP_KEY_VALID.test(s);
}

/** The work's public page on openalex.org, for a reader's click; nothing is ever fetched from it. */
export function openalexWorkUrl(id: string): string {
  if (!isValidOpenAlexWorkId(id)) throw new Error('Invalid OpenAlex work id');
  return OPENALEX_SITE + id;
}

/** The record's public page on dblp.org, for a reader's click. */
export function dblpRecordUrl(key: string): string {
  if (!isValidDblpKey(key)) throw new Error('Invalid DBLP key');
  return DBLP_RECORD_BASE + key;
}
