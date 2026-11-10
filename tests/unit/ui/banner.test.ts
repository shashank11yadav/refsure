import { describe, expect, test, vi } from 'vitest';
import type { CheckErrorCode } from '../../../src/messaging';
import { bannerFor, INTERRUPTED_TEXT, renderBanner, SERVICES_DOWN_TEXT, unreachableNotice } from '../../../src/ui/banner';
import { byText, click, makeDom, text } from '../helpers/dom';

const { doc } = makeDom();

describe('banner wording', () => {
  test('confidential uses the DESIGN wording', () => {
    expect(bannerFor('confidential').text).toBe("This submission isn't public, so RefSure didn't check it. Nothing was sent anywhere.");
  });

  test.each([
    ['visibility-unclear', "RefSure couldn't confirm this paper is public, so it didn't check it. Nothing was sent anywhere."],
    ['no-arxiv-version', "RefSure reads OpenReview papers through their arXiv version, and this paper doesn't have one it can find yet."],
    ['open-forum-page', "Open the paper's OpenReview page (not the PDF) to check it."],
    ['offline', 'You appear to be offline. Connect and press Try again.'],
    ['no-references', "RefSure couldn't find a reference list in this paper."],
  ] as const)('%s', (code, expected) => {
    expect(bannerFor(code).text).toBe(expected);
  });

  test('unsupported says where RefSure works', () => {
    expect(bannerFor('unsupported').text).toMatch(/arXiv/);
    expect(bannerFor('unsupported').text).toMatch(/OpenReview/);
  });

  test("a failed read shows the background's own calm message, or a default", () => {
    expect(bannerFor('fetch-failed', 'Reading this paper took too long').text).toBe('Reading this paper took too long');
    expect(bannerFor('fetch-failed').text).toMatch(/couldn't read/);
  });

  test('nothing accuses', () => {
    const codes: CheckErrorCode[] = ['unsupported', 'confidential', 'visibility-unclear', 'no-arxiv-version', 'open-forum-page', 'no-references', 'offline', 'fetch-failed'];
    for (const code of codes) expect(bannerFor(code).text).not.toMatch(/fake|hallucinat/i);
  });

  test('only the errors that can pass offer a retry', () => {
    expect(bannerFor('offline').retry).toBe(true);
    expect(bannerFor('fetch-failed').retry).toBe(true);
    expect(bannerFor('confidential').retry).toBe(false);
    expect(bannerFor('unsupported').retry).toBe(false);
  });

  test('the interrupted text names the one button that is there', () => {
    expect(INTERRUPTED_TEXT).toBe('Check interrupted. Press Re-check to start again.');
  });

  test('the services-down text does not read as a clean bill for the paper', () => {
    expect(SERVICES_DOWN_TEXT).toBe("The databases RefSure uses aren't answering right now. This isn't a problem with the paper. Try again in a few minutes.");
  });

  test('a failed read does not say "Try again later" right above a Try again button', () => {
    const text = bannerFor('fetch-failed').text;
    expect(text).toBe("RefSure couldn't read this paper's references.");
    expect(text).not.toMatch(/try again/i);
  });

  test('the notice for a source that did not answer for some references', () => {
    expect(unreachableNotice('crossref')).toEqual({ tone: 'info', text: "Couldn't reach Crossref for some references, so they show as Can't check. Re-check later to try them again." });
    expect(unreachableNotice('openreview').text).toContain("Couldn't reach OpenReview for some references");
  });
});

describe('renderBanner', () => {
  test('shows the text and its buttons', () => {
    const onClick = vi.fn();
    const banner = renderBanner(doc, { tone: 'warn', text: 'Something' }, [{ label: 'Re-check', onClick }]);
    expect(text(banner)).toContain('Something');
    click(byText(banner, 'button', 'Re-check'));
    expect(onClick).toHaveBeenCalled();
  });

  test('every notice is announced politely, as a status', () => {
    expect(renderBanner(doc, { tone: 'warn', text: 'x' }, []).getAttribute('role')).toBe('status');
    expect(renderBanner(doc, { tone: 'info', text: 'x' }, []).getAttribute('role')).toBe('status');
  });

  test('markup in the text stays text', () => {
    const banner = renderBanner(doc, { tone: 'info', text: '<b>bold</b>' }, []);
    expect(banner.querySelector('b')).toBeNull();
    expect(banner.textContent).toContain('<b>bold</b>');
  });
});
