import { test, expect } from '@playwright/test';
import { sessionLabel, sessionLabelParts, sessionTooltip, sessionShortName } from '../src/client/views/sessionLabel.js';
import { setLocale } from '../src/client/i18n.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// Pin the locale so the reveal `title` string and "New session" fallback
// are deterministic across machines — chromium's navigator.language would
// otherwise pick zh on a zh-CN system and en elsewhere.
test.beforeAll(() => { setLocale('en'); });

// sessionLabel is the single source of the tab/pane display name (the rail
// tabs and the grid-pane chips both call it). Shape is `presetName (label)`:
// the launch preset name first, `server:cwd` detail in parens. Sessions
// launched without a preset show a localized "New session" placeholder — we
// deliberately do NOT reuse the cwd basename as the primary name — that
// makes every session in the same folder look like it was named after the
// folder. The cwd surfaces in the paren detail and on the rail
// meta line, so no identity is lost.
function info(partial: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'abcdef123456',
    state: 'idle',
    cwd: '/home/u/project',
    createdAt: 0,
    target: 'local',
    label: '',
    ...partial,
  };
}

test.describe('sessionLabel', () => {
  test('uses the preset name as the primary handle and the server:cwd detail in parens', () => {
    expect(sessionLabel(info({ presetName: 'Default', label: 'Local:/home/u/project' })))
      .toBe('Default (Local:/home/u/project)');
  });

  test('falls back to "New session" when no preset was chosen', () => {
    expect(sessionLabel(info({ label: 'Local:/home/u/project' })))
      .toBe('New session (Local:/home/u/project)');
  });

  test('drops the parens when there is no detail label to add', () => {
    expect(sessionLabel(info({ presetName: 'Default', label: '' }))).toBe('Default');
  });

  test('shows the bare fallback when both preset and label are missing', () => {
    expect(sessionLabel(info({ label: '', cwd: '' }))).toBe('New session');
  });
});

test.describe('sessionShortName', () => {
  test('returns the preset name when present', () => {
    expect(sessionShortName(info({ presetName: 'API prod' }))).toBe('API prod');
  });

  test('returns the localized fallback when no preset was chosen', () => {
    expect(sessionShortName(info({}))).toBe('New session');
  });
});

// sessionTooltip drives the `title` attribute on rail tabs and grid pane heads.
// A user hovering a truncated label must see the full path + server identity,
// otherwise long cwds get truncated with no way to recover the full path.
test.describe('sessionTooltip', () => {
  test('stacks label / target / cwd on separate lines for a bare local session', () => {
    const tip = sessionTooltip(info({ label: '', cwd: 'C:\\work\\app' }));
    expect(tip.split('\n')).toEqual(['New session', 'local', 'C:\\work\\app']);
  });

  test('includes server / profile / preset names when present', () => {
    const tip = sessionTooltip(info({
      label: 'demo', cwd: '/srv/x', target: 'ssh',
      serverName: 'edge-1', profileName: 'prod', presetName: 'cchub ssh',
    }));
    // Line 1 mirrors what the tab shows (sessionLabel), so `presetName (label)`.
    // The full absolute cwd still appears on the last line for truncated hovers.
    expect(tip).toBe(['cchub ssh (demo)', 'ssh · edge-1', 'profile: prod', 'preset: cchub ssh', '/srv/x'].join('\n'));
  });

  test('always ends with the absolute cwd so hover surfaces the full path', () => {
    const tip = sessionTooltip(info({ cwd: '/very/long/absolute/path/to/project' }));
    expect(tip.endsWith('/very/long/absolute/path/to/project')).toBe(true);
  });
});

// sessionLabelParts is the pure model behind renderSessionLabel — the DOM
// adapter just materializes these parts into text nodes and `<a>` elements.
// Concatenating every part's `text` must round-trip back to sessionLabel().
test.describe('sessionLabelParts', () => {
  test('splits `presetName (label)` into three parts with the detail as a reveal link when revealable', () => {
    const parts = sessionLabelParts(info({ presetName: 'Default', label: 'Local:C:\\work\\app', cwd: 'C:\\work\\app' }), true);
    expect(parts).toEqual([
      { kind: 'text', text: 'Default (' },
      { kind: 'reveal', text: 'Local:C:\\work\\app', title: 'Open C:\\work\\app' },
      { kind: 'text', text: ')' },
    ]);
  });

  test('substitutes a plain text detail when the target is not revealable', () => {
    const parts = sessionLabelParts(info({ presetName: 'Default', label: 'ssh:/srv', cwd: '/srv' }), false);
    expect(parts).toEqual([
      { kind: 'text', text: 'Default (' },
      { kind: 'text', text: 'ssh:/srv' },
      { kind: 'text', text: ')' },
    ]);
  });

  test('collapses to a single "New session" part when there is neither preset nor label', () => {
    expect(sessionLabelParts(info({ label: '', cwd: '/home/u/api-server' }), true))
      .toEqual([{ kind: 'text', text: 'New session' }]);
  });

  test('concatenated parts round-trip to sessionLabel', () => {
    const cases: Partial<SessionInfo>[] = [
      { presetName: 'Default', label: 'Local:/home/u/project', cwd: '/home/u/project' },
      { presetName: 'edge', label: 'ssh:/srv', cwd: '/srv' },
      { label: '', cwd: '/home/u/api-server' },
      { presetName: 'named', label: 'detail', cwd: '' },
      { label: '', cwd: '' },
    ];
    for (const partial of cases) {
      const i = info(partial);
      const text = sessionLabelParts(i, true).map(p => p.text).join('');
      expect(text, `round-trip for ${JSON.stringify(partial)}`).toBe(sessionLabel(i));
    }
  });
});
