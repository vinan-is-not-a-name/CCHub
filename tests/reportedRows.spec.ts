import { test, expect } from '@playwright/test';
import { reportedRows } from '../src/client/views/reportedRows.js';

// reportedRows shrinks the rows count we tell the PTY by 1 relative to what
// xterm.js shows locally, to sidestep the pending-wrap-at-last-row + \r\n =
// scroll edge that leaves cc's overlay hints (e.g. "Save and close editor
// to continue..." after Ctrl+G) stranded one row above where cc later tries
// to erase them. See views/terminal.ts:reportedRows for the full mechanism
// write-up. This spec pins the shrink so a future refactor can't quietly
// stop reserving that last row without failing a test first.
test.describe('reportedRows', () => {
  test('typical rows: xtermRows - 1', () => {
    expect(reportedRows(38)).toBe(37);
    expect(reportedRows(24)).toBe(23);
    expect(reportedRows(2)).toBe(1);
  });

  test('degenerate small rows are clamped to at least 1', () => {
    // A pane so small the fit produces rows=1 (or 0 briefly during mount)
    // shouldn't be reported as 0 or negative — cc would refuse to start.
    expect(reportedRows(1)).toBe(1);
    expect(reportedRows(0)).toBe(1);
  });
});
