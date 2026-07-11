import themes from 'xterm-theme';

/** Themes we hide from the picker entirely. Two flavors, both objective:
 *
 *  1. Unreadable — WCAG contrast(fg, bg) < 3:1 at the terminal's default
 *     font size. Any font size below the WCAG "large text" threshold (~18pt
 *     regular / 14pt bold) needs 4.5:1 to pass AA; terminals run at ~13px,
 *     so we're already below "large" and 3:1 is the strict floor. The four
 *     entries below sit at 2.3–2.8:1 — reviewers had to squint to see any
 *     text at all.
 *
 *  2. Duplicates — either a name variant (`Parasio_Dark` is a typo copy of
 *     `Paraiso_Dark`, both in the upstream package) or a theme whose fg/bg
 *     is byte-identical to a canonical one (`Violet_Light` matches
 *     `Solarized_Light`, `Solarized_Dark_Patched` matches
 *     `Solarized_Dark` at the visible-text level). Users who click one
 *     would see the same terminal as clicking the other, which is
 *     "list noise" the picker cannot afford at 150+ entries.
 *
 *  `default` is xterm-theme's placeholder entry with no fg/bg set — it
 *  renders as a bright empty pane and has no business in the picker.
 *
 *  If a browser has this name persisted from an older version, the picker
 *  won't offer it back; `resolveThemeName` maps stale values to the
 *  default so the terminal doesn't fall through to a colorless render. */
export const HIDDEN_THEMES = new Set<string>([
  'default',
  // Contrast < 3:1 — unreadable at terminal font sizes.
  'C64',            // 2.26  purple-on-purple
  'Royal',          // 2.34  dark purple text on nearly-black purple
  'Shaman',         // 2.44  dark teal on near-black teal
  'CrayonPonyFish', // 2.76  dim brown on near-black red
  // Duplicates of canonical themes.
  'Parasio_Dark',            // typo copy of Paraiso_Dark
  'Solarized_Dark_Patched',  // visual duplicate of Solarized_Dark
  'Violet_Light',            // fg/bg identical to Solarized_Light
]);

/** Themes shown at the top of the picker under the "Popular" heading —
 *  the ones a typical developer has heard of and would try first. Ordered
 *  so the light-mode picks are near the top (matching the default), then
 *  the dark-mode picks. Every entry MUST exist in xterm-theme and must NOT
 *  appear in HIDDEN_THEMES; the spec asserts both to catch a rename in
 *  the upstream package before it ships.
 *
 *  This is a curation, not an algorithm — the "which one is popular" call
 *  is opinionated. When we add or drop entries, edit the list; do not
 *  add heuristics. Twenty is roughly the largest number a user will scan
 *  without giving up; adding a twenty-first entry means dropping one. */
export const POPULAR_THEMES: readonly string[] = [
  // Light
  'OneHalfLight',
  'Solarized_Light',
  'Github',
  'Man_Page',
  'Novel',
  'PencilLight',
  // Dark
  'OneHalfDark',
  // Solarized_Dark intentionally omitted from Popular. xterm-theme's port
  // measures at 4.29:1 fg/bg contrast — below WCAG AA normal-text (4.5:1)
  // — so it's an actively-uncomfortable pick for a spotlighted default.
  // It's still available under "More" for users who know they want it;
  // the higher-contrast variant covers the "I want Solarized" case here.
  'Solarized_Dark_Higher_Contrast',
  'Gruvbox_Dark',
  'Dracula',
  'Tomorrow_Night',
  'Tomorrow_Night_Bright',
  'Monokai_Vivid',
  'IR_Black',
  'Cobalt2',
  'Material',
  'Argonaut',
  'Dark_Pastel',
  'Zenburn',
];

/** Fallback theme when a persisted name has since been hidden, or when the
 *  storage entry is missing. Chosen to match the default the terminal
 *  ships with so a new browser and a "reset" browser render the same. */
export const DEFAULT_THEME_NAME = 'OneHalfLight';

/** Split every offered theme into two ordered lists — Popular first
 *  (curation order) and Others second (alphabetical). Neither list
 *  contains a HIDDEN_THEMES entry; the two lists are disjoint. */
export function getThemeCatalog(): { popular: string[]; others: string[] } {
  const all = new Set(Object.keys(themes as Record<string, unknown>));
  // Keep only popular entries that actually exist in the shipped package
  // and aren't hidden — protects against a typo in POPULAR_THEMES silently
  // introducing a dead <option>.
  const popular = POPULAR_THEMES.filter(n => all.has(n) && !HIDDEN_THEMES.has(n));
  const popSet = new Set(popular);
  const others = [...all]
    .filter(n => !popSet.has(n) && !HIDDEN_THEMES.has(n))
    .sort((a, b) => a.localeCompare(b));
  return { popular, others };
}

/** Resolve a possibly-stale theme name to one the app will actually
 *  render. Accepts null/undefined for the "no storage" case; returns
 *  DEFAULT_THEME_NAME for any hidden name or unknown key. */
export function resolveThemeName(name: string | null | undefined): string {
  if (name && (themes as Record<string, unknown>)[name] && !HIDDEN_THEMES.has(name)) {
    return name;
  }
  return DEFAULT_THEME_NAME;
}
