// A journal citation with no title and one named author ("P. Astone et al., Phys. Rev. D 82, 022003 (2010).") is a
// weak query: Crossref ranks short errata of the same volume above the article. When its first answers hold no match,
// one more request is made with what the locator itself gives (crossref.searchLocatorAgain): the DOI that APS and IOP
// build from journal, volume and page, or else the first author's surname. Either only adds candidates; a record is
// still taken only when it carries every part of the locator (matchesLocator), so a built DOI that names another
// article, or none, is dropped.
import { zoneNamesSomeone } from './authorZone';
import { type JournalLocator, locatorQuery } from './journalLocator';
import { normalizeTitle, surnamesFrom } from './normalize';
import type { ParsedCitation } from './types';

interface DoiRule {
  /** Journal names as normalised words ("phys rev d"); the text in front of the volume must end with one of them. */
  names: readonly string[];
  /** The DOI for this volume and page as written, or undefined when the journal did not build it that way then. */
  build: (volume: number, page: string) => string | undefined;
}

const PLAIN_PAGE = /^\d{1,6}$/;
const ARTICLE_NUMBER = /^\d{6}$/;

/** APS: "10.1103/PhysRevD.82.022003", the page or article number as printed, leading zeros kept. */
function aps(code: string, names: readonly string[], maxVolume = Infinity): DoiRule {
  return { names, build: (volume, page) => (PLAIN_PAGE.test(page) && volume <= maxVolume ? `10.1103/${code}.${volume}.${page}` : undefined) };
}

/**
 * IOP, while its journals had six-digit article numbers and before the DOIs of 2017 on ("10.1088/1361-6382/aa556f"):
 * "10.1088/0264-9381/29/23/235004", the issue being the first two digits of the article number.
 */
function iop(issn: string, names: readonly string[], first: number, last: number): DoiRule {
  return {
    names,
    build: (volume, page) => {
      const issue = Number(page.slice(0, 2));
      return ARTICLE_NUMBER.test(page) && issue > 0 && volume >= first && volume <= last ? `10.1088/${issn}/${volume}/${issue}/${page}` : undefined;
    },
  };
}

const series = (letter: string): string[] => [`phys rev ${letter}`, `physical review ${letter}`, `pr${letter}`];

// Checked against Crossref's records: APS for every journal below; IOP for the volumes given.
const RULES: readonly DoiRule[] = [
  aps('PhysRevLett', ['phys rev lett', 'physical review letters', 'prl']),
  aps('RevModPhys', ['rev mod phys', 'reviews of modern physics']),
  ...['a', 'b', 'c', 'd', 'e', 'x'].map((letter) => aps(`PhysRev${letter.toUpperCase()}`, series(letter))),
  aps('PhysRevApplied', ['phys rev applied', 'phys rev appl', 'physical review applied']),
  aps('PhysRevResearch', ['phys rev research', 'phys rev res', 'physical review research']),
  aps('PhysRevFluids', ['phys rev fluids', 'physical review fluids']),
  aps('PhysRevMaterials', ['phys rev materials', 'phys rev mater', 'physical review materials']),
  aps('PRXQuantum', ['prx quantum']),
  aps('PhysRevAccelBeams', ['phys rev accel beams', 'physical review accelerators and beams']),
  aps('PhysRevSTAB', ['phys rev st accel beams', 'physical review special topics accelerators and beams']),
  // The Physical Review itself ran to volume 188 (1969).
  aps('PhysRev', ['phys rev', 'physical review'], 188),
  iop('0264-9381', ['class quantum grav', 'class quant grav', 'classical quantum gravity', 'classical and quantum gravity'], 25, 33),
  iop('1367-2630', ['new j phys', 'new journal of physics'], 10, 18),
  iop('0953-8984', ['j phys condens matter', 'journal of physics condensed matter'], 19, 28),
  iop('1751-8113', ['j phys a', 'j phys a math theor', 'journal of physics a', 'journal of physics a mathematical and theoretical'], 41, 49),
];

// A short dotted word in front of the name makes it part of a longer one: "Chin. Phys. Rev." is not "Phys. Rev.".
const DOTTED_ABBREVIATION = /^\p{Lu}\p{Ll}{1,4}\.$/u;

/** Does the text in front of the volume end with this journal name, and not with a longer name that ends like it? */
function endsWithName(before: string, name: string): boolean {
  const tokens = before.split(/\s+/).filter((t) => t !== '');
  const words: { word: string; token: number }[] = [];
  tokens.forEach((token, i) => {
    for (const word of normalizeTitle(token).split(' ')) if (word !== '') words.push({ word, token: i });
  });
  const wanted = name.split(' ');
  if (wanted.length > words.length) return false;
  const tail = words.slice(words.length - wanted.length);
  if (!tail.every((w, i) => w.word === wanted[i])) return false;
  const start = tail[0]?.token ?? 0;
  // The name must start a token of its own ("Rev." from "Phys.Rev." is not the start of "Rev. Mod. Phys.").
  if (words.some((w) => w.token === start && words.indexOf(w) < words.length - wanted.length)) return false;
  return !DOTTED_ABBREVIATION.test(tokens[start - 1] ?? '');
}

/** The page or article number as the reference prints it ("022003", where the locator keeps "22003"). */
function writtenPage(c: ParsedCitation, loc: JournalLocator): string | undefined {
  if (!/^\d+$/.test(loc.page)) return undefined;
  const text = locatorQuery(c);
  const page = new RegExp(String.raw`(?<![\p{L}\d])0*${loc.page}(?!\d)`, 'gu');
  page.lastIndex = Math.max(0, loc.before.length - 2);
  return page.exec(text)?.[0];
}

/** The DOI the publisher gave the article at this locator, for publishers that build it from journal, volume and page. */
export function publisherDoi(c: ParsedCitation, loc: JournalLocator): string | undefined {
  const rule = RULES.find((r) => r.names.some((name) => endsWithName(loc.before, name)));
  const page = rule === undefined ? undefined : writtenPage(c, loc);
  return rule === undefined || page === undefined ? undefined : rule.build(Number(loc.volume), page);
}

/** The first author's surname, from the names in front of the journal; undefined when they name no person. */
export function locatorFirstSurname(c: ParsedCitation, loc: JournalLocator): string | undefined {
  // The journal follows the last comma: "P. Astone et al., Phys. Rev. D".
  const cut = loc.before.lastIndexOf(',');
  if (cut <= 0) return undefined;
  const authorText = loc.before.slice(0, cut);
  if (!zoneNamesSomeone({ raw: authorText, authors: [], kind: c.kind, confidence: c.confidence })) return undefined;
  const [first] = surnamesFrom(authorText);
  return first !== undefined && /\p{L}{2,}/u.test(first) ? first : undefined;
}
