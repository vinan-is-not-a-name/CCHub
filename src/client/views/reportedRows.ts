// Pure, DOM-free helper. xterm.js follows the DEC standard: after writing to
// the last column, the cursor holds "pending wrap" state; a subsequent `\r\n`
// runs `\r` (clears pending) then `\n` (advances a row — which scrolls when
// already on the bottom row). Real Windows terminals (conhost, Windows
// Terminal) are more forgiving in the same edge and do NOT scroll. cc
// regularly draws a bottom-row `─` filler when it renders an interstitial
// hint (e.g. the external-editor overlay); the next redraw then leads with
// `\r\n` and desynchronises with the cursor position cc believes it's at —
// leaving a row of hint text stranded one row above the position cc later
// tries to erase. To avoid ever putting the cursor on xterm's last row we
// report rows - 1 to the PTY. The visible bottom row of the pane stays
// reserved as blank canvas; cc treats the terminal as one row shorter.
// Trade-off documented on #261.
export function reportedRows(xtermRows: number): number {
  return Math.max(1, xtermRows - 1);
}
