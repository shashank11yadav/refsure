// Turning titles and author lists from messy bibliography text, LaTeX source and
// API records into comparable forms.

// Common LaTeX accent macros as combining marks, so NFKD + mark stripping folds them.
const SYMBOL_ACCENTS: Record<string, string> = {
  '"': '̈',
  "'": '́',
  '`': '̀',
  '^': '̂',
  '~': '̃',
  '=': '̄',
  '.': '̇',
};
const LETTER_ACCENTS: Record<string, string> = {
  c: '̧',
  v: '̌',
  u: '̆',
  H: '̋',
  r: '̊',
  k: '̨',
};
const LATEX_LETTERS: Record<string, string> = {
  ss: 'ss',
  ae: 'ae',
  AE: 'AE',
  oe: 'oe',
  OE: 'OE',
  o: 'o',
  O: 'O',
  l: 'l',
  L: 'L',
  i: 'i',
  j: 'j',
  ell: 'l',
};
// Letters that Unicode decomposition leaves alone.
const NON_DECOMPOSING: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

// Macros whose name is a word of the title even when braces follow it ("$\\alpha{}$-divergence", "$O(\\log{n})$"): Greek
// letters, the names of functions and the TeX logos.
const WORD_MACROS = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'max', 'min', 'sup', 'inf', 'lim', 'liminf', 'limsup', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'Pr', 'hom',
  'TeX', 'LaTeX', 'BibTeX',
]);

// Greek letters: TeX's name (and its variant forms) and the letter a database prints. In a comparison key every one is
// its name ("\\nu", "ν" and "nu" are one word); in a search phrase every TeX name is the letter (GREEK_LETTERS).
const GREEK_LETTERS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const GREEK_NAMES: Record<string, string> = { ο: 'omicron', ς: 'sigma', ϵ: 'epsilon', ϑ: 'theta', ϖ: 'pi', ϱ: 'rho', ϕ: 'phi', ϰ: 'kappa' };
for (const [name, letter] of Object.entries(GREEK_LETTERS)) GREEK_NAMES[letter.toLowerCase()] = name.toLowerCase();
// "\\varphi" is a form of "\\phi".
const VARIANT_GREEK = /\\var(epsilon|theta|pi|rho|sigma|phi)(?![a-zA-Z])/g;
// A lone Greek letter, as in mathematics ("ν=2+4/9", "α-stable"); a word written in Greek is left as it is.
const LONE_GREEK_LETTER = /(?<!\p{Script=Greek})\p{Script=Greek}(?!\p{Script=Greek})/gu;

function resolveLatex(s: string, greek: 'name' | 'letter' = 'name'): string {
  return s
    .replace(VARIANT_GREEK, '\\$1')
    .replace(/\\(["'`^~=.])(?:\{\s*\\?([a-zA-Z]+)\s*\}|\\?([a-zA-Z]))/g, (_m, accent: string, braced?: string, bare?: string) => (braced ?? bare ?? '') + (SYMBOL_ACCENTS[accent] ?? ''))
    .replace(/\\([cvuHrk])(?:\s*\{\s*([a-zA-Z])\s*\}|\s+([a-zA-Z]))/g, (_m, accent: string, braced?: string, bare?: string) => (braced ?? bare ?? '') + (LETTER_ACCENTS[accent] ?? ''))
    .replace(/\\(ss|ae|AE|oe|OE|o|O|l|L|i|j|ell)(?![a-zA-Z])/g, (_m, name: string) => LATEX_LETTERS[name] ?? '')
    // Operators and spacing of mathematics: a database writes them as symbols ("K3×Cn", "∑"), which fold to nothing.
    .replace(/\\(?:times|cdot|cdots|ldots|dots|vdots|ddots|sum|prod|frac|dfrac|tfrac|int|oint|to|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|Leftrightarrow|uparrow|downarrow|gets|mapsto|infty|leq?|geq?|neq?|ll|gg|approx|sim|simeq|equiv|propto|pm|mp|otimes|oplus|circ|in|notin|subset|subseteq|supset|cup|cap|setminus|wedge|vee|land|lor|perp|parallel|left|right|bigl|bigr|big|Big|mid|vert|langle|rangle|quad|qquad)(?![a-zA-Z])/g, ' ')
    // Symbols and spacing that a database prints as a symbol or not at all ("⋆-product", "†-categories").
    .replace(/\\(?:star|ast|dagger|ddagger|bullet|prime|sharp|flat|natural|heartsuit|spadesuit|clubsuit|diamondsuit|neg|lnot|forall|exists|nexists|nabla|partial|emptyset|varnothing|displaystyle|textstyle|scriptstyle|limits|nolimits|thinspace|enspace|space|relax|strut|mathstrut|noindent)(?![a-zA-Z])/g, ' ')
    // A macro with an argument ("\\widetilde{O}", "\\mathcal{X}", "\\textit{word}") is its argument, as a database prints it
    // ("Õ", "X", "word"), unless it is a word (WORD_MACROS: "\\log{n}" is "log n"). Any other macro keeps its name as a
    // word: Greek letters ("alpha"), functions ("log") and an author's own macros ("\\NP", "\\PSPACE"), which may be the
    // one word that tells two titles apart.
    .replace(/\\([a-zA-Z]+)(\s*\{)?/g, (_m, name: string, brace?: string) => {
      const word = greek === 'letter' ? (GREEK_LETTERS[name] ?? name) : name;
      return brace === undefined ? word : WORD_MACROS.has(name) ? `${word} {` : brace;
    })
    .replace(/~/g, ' ')
    .replace(/[\\{}$_^]/g, '');
}

// A title holds TeX when it has a macro, a dollar sign or a braced sub- or superscript.
const HAS_TEX = /\\[a-zA-Z]|\$|[_^]\{/;

/**
 * A title as text for a search service: TeX resolved the way normalizeTitle resolves it ("\\widetilde{O}(T^{-1})" is
 * "O(T-1)"), except that a Greek letter is the letter the databases print ("\\nu=2+4/9" is "ν=2+4/9"), case and
 * punctuation kept. A title without TeX is returned as it is.
 */
export function plainQueryText(title: string): string {
  if (!HAS_TEX.test(title)) return title;
  return resolveLatex(title, 'letter').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** A word hyphenated at a line end ("pre-\ntraining") is one word. */
export function joinLineEndHyphens(s: string): string {
  return s.replace(/(\p{L})-[ \t]*\r?\n\s*(?=\p{Ll})/gu, '$1');
}

/**
 * A comparison key for a title or a name: LaTeX resolved, accents and ligatures
 * folded, lower-case, punctuation and dashes turned into single spaces. A hyphen
 * at the end of a line followed by a lower-case letter is a word break and is
 * joined ("pre-\ntraining" gives "pretraining").
 */
export function normalizeTitle(s: string): string {
  let t = resolveLatex(s.replace(/­/g, ''));
  t = t.replace(/([\p{L}\p{N}])[-‐‑][ \t]*\r?\n\s*(?=\p{Ll})/gu, '$1');
  t = t.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  t = t.replace(LONE_GREEK_LETTER, (c) => ` ${GREEK_NAMES[c] ?? c} `);
  t = t.replace(/[ßæœøłđðþı]/g, (c) => NON_DECOMPOSING[c] ?? c);
  t = t.replace(/['’‘`´ʼ]/g, ''); // "don't" and "don’t" both become "dont"
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Similarity blends two views of a title. Character-level edit distance (on the
// text without spaces, so a stray or missing space costs nothing) carries most of
// the weight: it forgives typos and OCR damage and moves smoothly. Word-set overlap
// adds a little protection against titles that share letters but not words, but it
// is blunt on short titles (one typo in a 3-word title halves it), so it stays small.
const CHAR_WEIGHT = 0.8;
const WORD_WEIGHT = 0.2;
// Real titles are far shorter; the cap keeps edit distance cheap on junk input.
const MAX_COMPARE_CHARS = 400;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

function plainSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a).slice(0, MAX_COMPARE_CHARS);
  const nb = normalizeTitle(b).slice(0, MAX_COMPARE_CHARS);
  if (na === '' || nb === '') return 0;
  const ca = na.replace(/ /g, '');
  const cb = nb.replace(/ /g, '');
  if (ca === cb) return 1;
  const charScore = 1 - editDistance(ca, cb) / Math.max(ca.length, cb.length);
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const wordScore = shared / (wa.size + wb.size - shared);
  return CHAR_WEIGHT * charScore + WORD_WEIGHT * wordScore;
}

// Citations often drop a subtitle ("X: a study of Y" cited as "X"), a leading name
// ("BERT: Pre-training ..." cited without "BERT:"), or cut a long title short.
// Fewer words than this is too generic to count as the same title.
const MIN_SHARED_WORDS = 3;
// A matching main title is strong evidence but not proof, so it never reaches 1.
const MAIN_TITLE_CAP = 0.95;
// A contained span starts at the "candidate" level. After a dropped prefix it rises
// with coverage to "verified" (9 of 10 words matches). A truncated title (the
// cited text stops early) must never verify, so its range ends below 0.9.
const CONTAINED_BASE = 0.75;
const PREFIX_DROPPED_RANGE = 0.2;
const TRUNCATED_RANGE = 0.14;
const TRUNCATED_CEILING = 0.89;

const SUBTITLE_SEPARATOR = /:|\s[-\u2013\u2014]\s|\u2014/;

/** The part before the first colon or spaced dash, if it is long enough to be a title. */
function mainTitle(s: string): string | undefined {
  const cut = s.search(SUBTITLE_SEPARATOR);
  if (cut <= 0) return undefined;
  const head = s.slice(0, cut);
  return titleWords(head).length >= MIN_SHARED_WORDS ? head : undefined;
}

/** The words of a text as the title comparison sees them. */
export function titleWords(s: string): string[] {
  const n = normalizeTitle(s);
  return n === '' ? [] : n.split(' ');
}

interface SpanMatch {
  score: number;
  truncated: boolean;
}

/** How a title relates to the other when it is a whole-word contiguous span of it. */
function containedSpan(a: string, b: string): SpanMatch | undefined {
  const wa = titleWords(a);
  const wb = titleWords(b);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length < MIN_SHARED_WORDS || short.length === long.length) return undefined;
  const padded = ` ${long.join(' ')} `;
  const at = padded.indexOf(` ${short.join(' ')} `);
  if (at < 0) return undefined;
  const coverage = short.length / long.length;
  // Words before the match = spaces before it in the padded string.
  const wordsBefore = padded.slice(0, at).split(' ').length - 1;
  // Ends where the longer title ends: only a leading part (such as "BERT:") was dropped.
  const endsAtEnd = wordsBefore + short.length === long.length;
  return endsAtEnd
    ? { score: CONTAINED_BASE + PREFIX_DROPPED_RANGE * coverage, truncated: false }
    : { score: CONTAINED_BASE + TRUNCATED_RANGE * coverage, truncated: true };
}

/**
 * 0 (nothing in common) to 1 (same title once normalised). The best of: the whole
 * titles compared directly, one title being a span of the other, and, when only
 * one side has a subtitle, its main title (before a colon or dash) matching the
 * other side. Two titles that both have subtitles are never matched on the main
 * title alone: "X: A Survey" and "X: Applications" are different papers. A title
 * cut short is capped below 0.9 so it is reported as close, never verified.
 */
export function titleSimilarity(first: string, second: string): number {
  const a = withGreekLookAlikes(first, second);
  const b = withGreekLookAlikes(second, first);
  const best = bestSimilarity(a, b);
  // "Addendum to X", "Erratum: X", "Comment on X", "Reply to X" are works of their own about X: close to X, never X.
  if (isNoticeOf(a) !== isNoticeOf(b)) return Math.min(best, NOTICE_CEILING);
  // "tensionless critical strings" is not "tensionless noncritical strings", nor "supervised" "unsupervised": a few
  // letters apart, the opposite claim.
  return best >= NOTICE_CEILING && best < 1 && negationApart(a, b) ? Math.min(best, NOTICE_CEILING) : best;
}

// The Latin letters a title typed without Greek may write for a Greek letter: the one it is spelled with, or one it looks
// like ("u" for "μ", "p" for "ρ", "w" for "ω").
const LATIN_LOOK_ALIKES: Readonly<Record<string, string>> = {
  alpha: 'a', beta: 'b', gamma: 'gy', delta: 'd', epsilon: 'e', zeta: 'z', eta: 'hn', iota: 'i', kappa: 'k', lambda: 'l', mu: 'mu', nu: 'nv', xi: 'x', omicron: 'o', pi: 'p', rho: 'pr', sigma: 's', tau: 't', upsilon: 'uvy', phi: 'f', chi: 'x', omega: 'w',
};
// A one-letter word joined by a hyphen to the next word ("a-stable", "(b-VAE"), after any opening punctuation.
const HYPHENED_LETTER = /^([^\p{L}\p{N}]*)([A-Za-z])-(?=\p{L})/u;
const LONE_LETTER = /^([^\p{L}\p{N}]*)([A-Za-z])(?=[^\p{L}\p{N}]*$)/u;

/**
 * `title` with each one-letter Latin word that stands for a Greek letter of `other` written as that letter: the Latin
 * letter is the Greek one's look-alike, and it is joined by a hyphen to the word that follows the Greek letter in
 * `other` ("a-stable" against "α-stable"), or stands alone between the same two words as the Greek letter does ("the k
 * parameter" against "the κ parameter"). The article "a" standing alone is never "α". Any other title is returned as it is.
 */
function withGreekLookAlikes(title: string, other: string): string {
  // Only the part of a title that is compared is worth reading, and a long hostile one costs nothing then.
  if (title.length > MAX_COMPARE_CHARS || other.length > MAX_COMPARE_CHARS) return title;
  const otherWords = titleWords(other);
  if (!otherWords.some((w) => LATIN_LOOK_ALIKES[w] !== undefined)) return title;
  const pieces = title.split(/(\s+)/);
  const words: { word: string; piece: number; hyphened: boolean; alone: boolean }[] = [];
  pieces.forEach((piece, i) => {
    if (i % 2 === 1) return;
    const own = titleWords(piece);
    own.forEach((word, k) => words.push({ word, piece: i, hyphened: k === 0 && HYPHENED_LETTER.test(piece), alone: own.length === 1 && LONE_LETTER.test(piece) }));
  });
  // Read piece by piece, the title must give the same words as read whole (TeX across a space would not).
  if (words.map((w) => w.word).join(' ') !== titleWords(title).join(' ')) return title;
  words.forEach(({ word, piece, hyphened, alone }, i) => {
    if (word.length !== 1 || !(hyphened || (alone && word !== 'a'))) return;
    const next = words[i + 1]?.word;
    const previous = words[i - 1]?.word;
    const at = otherWords.findIndex((w, j) => LATIN_LOOK_ALIKES[w]?.includes(word) === true && otherWords[j + 1] === next && (hyphened || otherWords[j - 1] === previous));
    const name = otherWords[at];
    if (name === undefined) return;
    pieces[piece] = (pieces[piece] ?? '').replace(hyphened ? HYPHENED_LETTER : LONE_LETTER, (_m, before: string) => `${before}${name}${hyphened ? '-' : ''}`);
  });
  return pieces.join('');
}

/**
 * titleSimilarity for a cited title against a record's. A citation may drop a subtitle the record has ("X" for "X: a
 * study of Y"), but one that adds a subtitle the record lacks ("X: Part II", "X: a follow-up", "X: revisited") names
 * another work, or an invented one: then the score stays below the Verified threshold, so it is Details differ at most
 * and never a strong match (no other work's retraction).
 */
export function citedTitleSimilarity(cited: string, record: string): number {
  const score = titleSimilarity(cited, record);
  return score > NOTICE_CEILING && addsSubtitle(cited, record) ? NOTICE_CEILING : score;
}

/** Most words a main title may have to count as short ("MapReduce", "Deep Speech"): too generic on its own. */
const SHORT_MAIN_TITLE_WORDS = 2;

/**
 * The cited title is the record's main title alone, and that main title is short (one or two words): "MapReduce" for
 * "MapReduce: simplified data processing on large clusters". titleSimilarity does not count it (a word or two names
 * many works); the caller may, when other details agree.
 */
export function dropsShortSubtitle(cited: string, record: string): boolean {
  if (SUBTITLE_SEPARATOR.test(cited)) return false;
  const cut = record.search(SUBTITLE_SEPARATOR);
  if (cut <= 0) return false;
  const head = titleWords(record.slice(0, cut));
  return head.length > 0 && head.length <= SHORT_MAIN_TITLE_WORDS && head.join(' ') === titleWords(cited).join(' ');
}

/** The cited title is the record's title with a subtitle after a colon or dash that the record does not have. */
function addsSubtitle(cited: string, record: string): boolean {
  const head = mainTitle(cited);
  return head !== undefined && !SUBTITLE_SEPARATOR.test(record) && plainSimilarity(head, record) >= ADDED_SUBTITLE_HEAD;
}

/** How close the cited main title must be to the whole record title to call the rest an added subtitle. */
const ADDED_SUBTITLE_HEAD = 0.9;

const NEGATION_PREFIX = /^(?:non|un|in|im|ir|il|dis|anti)/;
const MIN_NEGATED_WORD = 4;

/** The words of a title, with a separate "non" joined to the next word ("non critical" is "noncritical"). */
function joinedWords(s: string): string[] {
  const out: string[] = [];
  for (const w of titleWords(s)) {
    if (out.at(-1) === 'non') out[out.length - 1] = `non${w}`;
    else out.push(w);
  }
  return out;
}

/** Does one title carry a word that the other carries negated ("critical" and "noncritical", "convex" and "nonconvex")? */
function negationApart(a: string, b: string): boolean {
  const wa = joinedWords(a);
  const wb = joinedWords(b);
  const onlyA = wa.filter((w) => !wb.includes(w));
  const onlyB = wb.filter((w) => !wa.includes(w));
  const negates = (x: string, y: string): boolean => y.length >= MIN_NEGATED_WORD && x.length > y.length && x.endsWith(y) && NEGATION_PREFIX.exec(x)?.[0].length === x.length - y.length;
  return onlyA.some((x) => onlyB.some((y) => negates(x, y) || negates(y, x)));
}

// Notes that amend, comment on or answer another work, named by their opening words.
const NOTICE_OPENING = /^(?:addend(?:um|a)|errat(?:um|a)|corrigend(?:um|a)|corrections?\s+(?:to|of)|comments?\s+on|repl(?:y|ies)\s+to|responses?\s+to|retraction\s+(?:of|note)|expression\s+of\s+concern)\b/;
const NOTICE_CEILING = 0.89;

function isNoticeOf(title: string): boolean {
  return NOTICE_OPENING.test(normalizeTitle(title));
}

function bestSimilarity(a: string, b: string): number {
  const plain = plainSimilarity(a, b);
  const span = containedSpan(a, b);
  let best = span === undefined ? plain : span.truncated ? Math.min(Math.max(plain, span.score), TRUNCATED_CEILING) : Math.max(plain, span.score);
  const headA = mainTitle(a);
  const headB = mainTitle(b);
  const aHasSubtitle = SUBTITLE_SEPARATOR.test(a);
  const bHasSubtitle = SUBTITLE_SEPARATOR.test(b);
  if (headA !== undefined && !bHasSubtitle) best = Math.max(best, Math.min(MAIN_TITLE_CAP, plainSimilarity(headA, b)));
  if (headB !== undefined && !aHasSubtitle) best = Math.max(best, Math.min(MAIN_TITLE_CAP, plainSimilarity(headB, a)));
  return best;
}

const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ter', 'ten', 'dos', 'das', 'do', 'bin', 'ibn', 'al', 'el']);

const INITIAL_TOKEN = /^(?:\p{Lu}\.?-?){1,3}$/u;

function isInitialsOnly(part: string): boolean {
  const tokens = part.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => INITIAL_TOKEN.test(t));
}

// "Cho" or "van Merrienboer": one word, optionally preceded by particles.
function looksLikeSurname(part: string): boolean {
  const tokens = part.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.slice(0, -1).every((t) => PARTICLES.has(t.toLowerCase()));
}

function surnameFromGivenFirst(part: string): string {
  let tokens = part.split(/\s+/).filter(Boolean);
  const leading = tokens.findIndex((t) => !INITIAL_TOKEN.test(t));
  const hadLeadingInitials = leading > 0;
  if (hadLeadingInitials) tokens = tokens.slice(leading);
  // Vancouver style puts initials last: "Vaswani AN".
  while (tokens.length > 1 && INITIAL_TOKEN.test(tokens[tokens.length - 1] ?? '')) tokens.pop();
  // Keep at least one given-name token in front, unless initials already stand there.
  const minStart = hadLeadingInitials ? 0 : 1;
  let start = tokens.length - 1;
  while (start - 1 >= minStart && PARTICLES.has((tokens[start - 1] ?? '').toLowerCase())) start--;
  return tokens.slice(Math.max(start, 0)).join(' ');
}

const MAX_AUTHOR_TEXT = 6000;

/**
 * Surnames, lower-case and ASCII-folded, from an author string in any of the
 * usual bibliography styles ("A. Vaswani, N. Shazeer", "Vaswani, A., Shazeer, N.",
 * "Bengio, Yoshua and Courville, Aaron", "Vaswani AN, Shazeer N").
 */
export function surnamesFrom(authorText: string): string[] {
  // Real author lists are far shorter; the cap and the whitespace collapse keep the
  // regexes below linear on hostile text (runs of spaces made them quadratic).
  const cleaned = authorText
    .slice(0, MAX_AUTHOR_TEXT)
    .replace(/\s+/g, ' ')
    .replace(/,?\s*\bet\.?\s+al\b\.?/gi, '')
    .replace(/,?\s*\band\s+others\b/gi, '')
    .replace(/(?:\.{3}|…)/g, '');
  const chunks = cleaned
    .split(/\s*;\s*|\s*&\s*|\s+\band\b\s+/i)
    .map((c) => c.split(',').map((p) => p.trim()).filter(Boolean))
    .filter((parts) => parts.length > 0);

  // "Last, First" pairs (BibTeX style) are only recognised when every author is
  // one; otherwise a comma separates authors.
  const lastFirst = chunks.every((parts) => parts.length === 2 && looksLikeSurname(parts[0] ?? ''));

  const surnames: string[] = [];
  for (const parts of chunks) {
    if (lastFirst) {
      surnames.push(parts[0] ?? '');
      continue;
    }
    parts.forEach((part, i) => {
      // Initials standing alone are the given names of the previous "Last, F." entry.
      if (isInitialsOnly(part)) return;
      const next = parts[i + 1];
      surnames.push(next !== undefined && isInitialsOnly(next) ? part : surnameFromGivenFirst(part));
    });
  }
  return surnames.map(normalizeTitle).filter((s) => s !== '');
}

function withoutParticles(surname: string): string {
  const tokens = surname.split(' ');
  let i = 0;
  while (i < tokens.length - 1 && PARTICLES.has(tokens[i] ?? '')) i++;
  return tokens.slice(i).join(' ');
}

/**
 * German umlauts are written either way ("Müller", "Mueller"); folding has already turned "ü" into "u", so
 * "ue", "oe" and "ae" are folded too. Applied to both sides of a comparison, it only ever adds matches.
 */
export function foldGermanSpelling(s: string): string {
  return s.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
}

// Words of an institutional or compound name that say nothing about who wrote the paper.
const FILLER_WORDS = new Set(['the', 'of', 'and', 'for', 'on', 'in', 'at', 'a', 'an', 'to']);

/**
 * The forms a normalised surname from a record may take in a reference: the whole name, the name without
 * leading particles ("da silva" cited as "Silva"), and each word of a multi-word name ("garcia perez" cited
 * as "García"), all with German spellings folded. Particles and filler words are never forms on their own.
 */
export function surnameForms(surname: string): string[] {
  const forms = new Set<string>();
  const add = (form: string): void => {
    if (form.length >= 2) forms.add(foldGermanSpelling(form));
  };
  add(surname);
  add(withoutParticles(surname));
  const words = surname.split(' ');
  if (words.length > 1) for (const w of words) if (!PARTICLES.has(w) && !FILLER_WORDS.has(w)) add(w);
  return [...forms];
}

/**
 * Fraction of the first three cited surnames that appear among the actual ones,
 * ignoring surname particles ("van", "de"...). 1 when nothing was cited.
 */
export function authorOverlap(cited: string[], actual: string[]): number {
  const firstThree = cited.slice(0, 3);
  if (firstThree.length === 0) return 1;
  // A record's surname also counts in the other forms a reference may write it in: German spellings folded
  // ("Mueller-Groeling" cited as "Muller-Groeling"), or one word of a compound ("Rangarajan Sridhar" cited as "Sridhar").
  const known = new Set(actual.flatMap((a) => [withoutParticles(a), ...surnameForms(a)]));
  return firstThree.filter((s) => known.has(withoutParticles(s)) || known.has(foldGermanSpelling(withoutParticles(s)))).length / firstThree.length;
}
