// Export CSV and Export JSON each start a real browser download (a blob behind a temporary link, no
// `downloads` permission), and what is in the files matches the results.
import { readFileSync } from 'node:fs';
import { PAPER_HTML, expect, panelRows, test, withSession } from './harness';

const PAPER = 'https://arxiv.org/html/2402.03664v5';

test('Export CSV and Export JSON download files that match the results', async () => {
  await withSession(async (s) => {
    s.serveFile(PAPER, PAPER_HTML, 'text/html; charset=utf-8');
    const paper = await s.openPaper(PAPER);
    const panel = await s.openPanel(paper);
    await s.runCheck(panel);
    const rows = await panelRows(panel);

    const csvDownload = panel.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export CSV' }).click();
    const csv = await csvDownload;
    expect(csv.suggestedFilename()).toBe('refsure-arxiv-2402.03664.csv');
    const csvText = readFileSync(await csv.path(), 'utf8');
    expect(csvText.startsWith('﻿"Number","Label","Status","Reason"')).toBe(true);
    // One line per reference plus the header (cells with line breaks would add more, so count the numbered starts).
    expect(csvText.split('\r\n').filter((line) => /^"\d+",/.test(line))).toHaveLength(rows.length);
    expect(csvText).toContain(',"Retracted",');
    expect(csvText).toContain(',"Not found",');

    const jsonDownload = panel.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export JSON' }).click();
    const json = await jsonDownload;
    expect(json.suggestedFilename()).toBe('refsure-arxiv-2402.03664.json');
    const report = JSON.parse(readFileSync(await json.path(), 'utf8')) as {
      tool: string;
      paper: { key: string; title: string };
      total: number;
      counts: Record<string, number>;
      results: { index: number; status: string }[];
    };
    expect(report.tool).toBe('RefSure');
    expect(report.paper.key).toBe('arxiv:2402.03664');
    expect(report.total).toBe(rows.length);
    expect(report.results.map((r) => [r.index, r.status])).toEqual([...rows].sort((a, b) => a.index - b.index).map((r) => [r.index, r.status]));
    // Nothing from the settings (such as an API key) is in an export.
    expect(JSON.stringify(report).toLowerCase()).not.toContain('apikey');
    expect(s.leaks).toEqual([]);
  });
});
