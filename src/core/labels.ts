// Labels that some styles leave at the very start of a reference's text: a bare number ("1 Smith J, ..." in BMJ,
// Lancet and RSC lists), a number glued to an initial ("1J. Roe"), a supplementary or appendix label ("S1. ",
// "A12. ") and superscript digits ("¹", "²³"). None of them is part of the author list or the title.

// A bare number is a label only when a name follows it: an initial ("J. Roe"), a surname and its initials
// ("Smith J,", "Roe, J."). A title that starts with a number ("100 Years of ...", "10 Things I ...") and a year
// ("2020 J. Roe", four digits) are left alone.
const NAME_AHEAD = String.raw`(?=\p{Lu}\.|\p{Lu}[\p{L}'’-]+,?\s+\p{Lu}{1,3}[,.;])`;
const LEADING_EXTRA_LABEL = new RegExp(String.raw`^(?:[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,4}\s*|\p{Lu}\d{1,3}[.)]\s+|\d{1,3}(?=\p{Lu}\.)|\d{1,3}\s+${NAME_AHEAD})`, 'u');

// A list label: "[12]", "[Roe20]", "(3)", "4.".
const LIST_LABEL = /^\s*(?:\[[^\]]{1,24}\]|\(\s*\d{1,4}\s*\)|\d{1,4}[.)])\s*/;

/** The text without a leading list label. */
export function withoutListLabel(text: string): string {
  return text.replace(LIST_LABEL, '');
}

/** The text without one leading label of the kinds above. Anchored and without nested quantifiers: linear. */
export function withoutLeadingLabel(text: string): string {
  return text.replace(LEADING_EXTRA_LABEL, '');
}
