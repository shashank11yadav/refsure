// A paper's title as a browser tab or a page names it, tidied. The background keeps it with the check and the panel
// shows it before a check starts; both use this, so they say the same thing.

const MAX_TITLE_CHARS = 300;

/** "[1706.03762] Title" and "Title | OpenReview" become "Title"; undefined when nothing is left. */
export function cleanTabTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const title = raw
    .replace(/\s+/g, ' ')
    .replace(/^\[[^\]]{1,40}\]\s*/, '') // arXiv abstract tabs: "[1706.03762] Title"
    .replace(/\s*\|\s*OpenReview$/i, '')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
  return title === '' ? undefined : title;
}
