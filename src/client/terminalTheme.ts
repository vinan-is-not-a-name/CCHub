/** Take a theme from `xterm-theme` and force cursor + cursorAccent to a
 * transparent hex (`#00000000`, alpha 0). The colour survives xterm's
 * `parseColor` (both the `#rrggbbaa` fast path in Color.ts and its downstream
 * uses), so the outline / bar / block CSS rules all end up painting with a
 * transparent stroke — the cursor decoration becomes invisible on every
 * theme, not just light ones.
 *
 * Historical note: this used to pass the CSS keyword `'transparent'`. That
 * appears to work in isolation but xterm's `parseColor` validates via canvas
 * and REJECTS zero-alpha CSS colours — the rejected value silently falls back
 * to `DEFAULT_CURSOR = '#ffffff'` (see ThemeService.ts). Light themes hid
 * the resulting white outline against a near-white background; dark themes
 * exposed it as a bright ring following cc's spinner around the pane. The
 * hex form skips the canvas check entirely because it matches xterm's
 * `#[\da-f]{3,8}` fast-path regex first.
 *
 * Must be applied _every time_ the theme is swapped at runtime — otherwise
 * `term.options.theme = newTheme` reinstates the raw theme's cursor colour.
 *
 * Split into its own module (no xterm import) so the unit-test harness can
 * import it in a Node context without pulling xterm's DOM-only deps. */
export function withHiddenCursor(theme: any): any {
  return { ...theme, cursor: '#00000000', cursorAccent: '#00000000' };
}

/** Companion to withHiddenCursor for CC versions that manage cursor visibility
 * themselves via DECTCEM (CSI ?25l/?25h). Local CC v2.1.139 paints its own
 * caret as reverse-video (CSI 7m/27m) and never sends DECTCEM, so the terminal
 * cursor must stay hidden. Remote CC v2.1.206 emits ?25l/?25h assuming the
 * terminal will draw a real caret whose visibility they toggle — in that mode
 * withHiddenCursor leaves the user with no visible caret at all. The runtime
 * in terminal.ts detects DECTCEM usage and swaps to this variant so xterm
 * draws a visible bar following the show/hide state cc requests.
 *
 * Uses theme.foreground (not theme.cursor): most xterm-theme entries assign
 * a subtle tint like #bfceff for cursor that is too pale against a light
 * background to see reliably. Foreground is guaranteed contrast-safe against
 * background — that's the theme designer's whole job for text. */
export function withVisibleCursor(theme: any): any {
  const cursor = theme.foreground ?? '#000000';
  const cursorAccent = theme.background ?? '#ffffff';
  return { ...theme, cursor, cursorAccent };
}
