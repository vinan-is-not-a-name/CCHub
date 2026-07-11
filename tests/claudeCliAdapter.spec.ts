import { test, expect } from '@playwright/test';
import { ClaudeCliAdapter } from '../src/server/domain/session/ClaudeCliAdapter.js';

// FakeCli in stateMachine.spec.ts deliberately stubs these methods to test the
// state-machine algorithm in isolation. That leaves the *real* adapter's regexes
// and command assembly unasserted — a broken approval pattern or a dropped `-c`
// would pass every other test. This locks the real contract directly.

const cli = new ClaudeCliAdapter();

test.describe('buildCommand', () => {
  test('appends -c to continue a conversation', () => {
    expect(cli.buildCommand({ resume: 'continue' })).toEqual(['claude', '-c']);
  });

  test('plain claude when resume is unset or not "continue"', () => {
    expect(cli.buildCommand({})).toEqual(['claude']);
    expect(cli.buildCommand({ resume: 'something-else' })).toEqual(['claude']);
  });

  // The MCP config is registered so feed_image is *discoverable*, but the tool
  // is deliberately NOT pre-approved via --allowedTools. Default = present but
  // inactive; the user opts in at the first call via claude's own permission
  // prompt (Allow / Always allow). This keeps cchub from silently granting
  // a tool the user never asked for.
  test('appends --mcp-config when mcpConfigPath is set (no auto --allowedTools)', () => {
    expect(cli.buildCommand({ mcpConfigPath: '/tmp/mcp-abc.json' })).toEqual([
      'claude', '--mcp-config', '/tmp/mcp-abc.json',
    ]);
  });

  test('--mcp-config composes with -c (resume + MCP together)', () => {
    expect(cli.buildCommand({ resume: 'continue', mcpConfigPath: '/tmp/mcp-abc.json' })).toEqual([
      'claude', '-c', '--mcp-config', '/tmp/mcp-abc.json',
    ]);
  });

  test('never auto-passes --allowedTools (opt-in stays with the user)', () => {
    expect(cli.buildCommand({ mcpConfigPath: '/tmp/mcp-abc.json' })).not.toContain('--allowedTools');
    expect(cli.buildCommand({ resume: 'continue', mcpConfigPath: '/tmp/mcp-abc.json' })).not.toContain('--allowedTools');
  });

  test('no MCP flags when mcpConfigPath is absent', () => {
    const argv = cli.buildCommand({ resume: 'continue' });
    expect(argv).not.toContain('--mcp-config');
    expect(argv).not.toContain('--allowedTools');
  });

  test('appends --dangerously-skip-permissions when skipPermissions is set', () => {
    expect(cli.buildCommand({ skipPermissions: true })).toEqual(['claude', '--dangerously-skip-permissions']);
  });

  test('omits the skip flag when skipPermissions is unset or false', () => {
    expect(cli.buildCommand({})).not.toContain('--dangerously-skip-permissions');
    expect(cli.buildCommand({ skipPermissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  test('skip flag composes after -c and before --mcp-config', () => {
    expect(cli.buildCommand({ resume: 'continue', skipPermissions: true, mcpConfigPath: '/tmp/mcp-abc.json' })).toEqual([
      'claude', '-c', '--dangerously-skip-permissions', '--mcp-config', '/tmp/mcp-abc.json',
    ]);
  });
});

test.describe('isAwaitingApproval', () => {
  // Strings the real Claude CLI surfaces when it blocks on a permission prompt.
  const approving = [
    'Do you want to proceed?',
    'Proceed? Yes/No',
    'Continue? (y/n)',
    'Allow  Deny',         // \bAllow\b\s+\bDeny\b — the button row
    'Deny   Allow',        // reverse order also matches
    'DO YOU WANT TO PROCEED',  // case-insensitive
  ];
  for (const s of approving) {
    test(`true for ${JSON.stringify(s)}`, () => {
      expect(cli.isAwaitingApproval(s)).toBe(true);
    });
  }

  const notApproving = [
    'just normal output',
    'Running tests...',
    '1. Allow  2. Deny',  // numbered menu: tokens between break \bAllow\b\s+\bDeny\b;
                          // the real prompt's "Do you want to proceed?" line matches instead
    '',
  ];
  for (const s of notApproving) {
    test(`false for ${JSON.stringify(s)}`, () => {
      expect(cli.isAwaitingApproval(s)).toBe(false);
    });
  }
});

test.describe('looksBusy', () => {
  // Signals cc surfaces in its bottom status area whenever it considers itself
  // busy. Presence of any is a hard "not idle" — even if stdout has been quiet,
  // we should not flip the session to idle and re-fire a ready notification.
  const busy = [
    'esc to interrupt',
    'press esc to interrupt',
    'esc to exit',
    '1 shell still running',
    '3 shells still running',
    'ESC TO INTERRUPT',           // case-insensitive
    '✻ Crunched for 11s · 1 shell still running',  // real cc status line
    // Real cc mid-turn spinner lines observed in production. None of these
    // include `esc to interrupt` on their own — the pattern that unifies them
    // is the ellipsis `…` (U+2026) trailing the present-participle verb.
    '✻ 分析代码…',
    '✢ 分析代码… (19s)',
    '✽ 分析代码… (1m 7s · almost done thinking with high effort)',
    '· Forging… (11m 53s · ↑ 10.2k tokens · thought for 3s)',
    'Running 2 shell commands…',
  ];
  for (const s of busy) {
    test(`true for ${JSON.stringify(s)}`, () => {
      expect(cli.looksBusy(s)).toBe(true);
    });
  }

  const notBusy = [
    'just normal output',
    '',
    '✻ Brewed for 7s',            // finished status, no active hint, no `…`
    '● Done — exit code 0, 60 lines emitted as expected.',
    '? for shortcuts',            // idle prompt hint
    // Idle per-turn summary lines from production. All past-tense, all with
    // NO ellipsis. These must NOT be flagged busy or we'd trap the session
    // in 'processing' forever once cc's turn ends.
    '✻ Worked for 10s',
    '✻ Baked for 9s',
    '✻ Cogitated for 27s',
    // The recap line format observed on turn completion — no ellipsis, no
    // spinner-line shape.
    '※ recap: refactored the module into smaller helpers (disable recaps in /config)',
  ];
  for (const s of notBusy) {
    test(`false for ${JSON.stringify(s)}`, () => {
      expect(cli.looksBusy(s)).toBe(false);
    });
  }

  // Ellipsis in ordinary content (an assistant message body, further up the
  // buffer) must NOT trip the busy check — otherwise every quoted `…` would
  // pin the session as busy forever. The check is restricted to the tail.
  test('ellipsis in a content line far above the tail is not treated as busy', () => {
    // 10 lines of history: the top has an `…`, the bottom is a clean idle
    // summary. The tail-only check should skip the top ellipsis.
    const screen = [
      'The report ended with an ellipsis…',
      ...Array.from({ length: 8 }, (_, i) => `content line ${i + 1}`),
      '✻ Worked for 10s',
    ].join('\n');
    expect(cli.looksBusy(screen)).toBe(false);
  });
});

test.describe('looksIdle', () => {
  // Positive "cc finished this turn" marker: the per-turn summary line uses
  // past-tense verb + `for <N>s` and terminates its own line. The mid-turn
  // spinner line has `thought for 3s` inside a parenthesised aggregate,
  // which never terminates its line at the `s`.
  const idle = [
    '✻ Worked for 10s',
    '✻ Baked for 9s',
    '✻ Cogitated for 27s',
    '✻ Brewed for 7s',
    '✻ Crunched for 11s',
    '· Forged for 45s',                    // any leading glyph works
  ];
  for (const s of idle) {
    test(`true for ${JSON.stringify(s)}`, () => {
      expect(cli.looksIdle(s)).toBe(true);
    });
  }

  const notIdle = [
    '',
    'just normal output',
    // Mid-turn: `thought for 3s` is a fragment inside the parenthesised
    // spinner-line aggregate. It does NOT terminate its line at the `s`
    // (there's a `)` after), so the whole-line anchor keeps looksIdle false.
    '· Forging… (11m 53s · ↑ 10.2k tokens · thought for 3s)',
    // Bare ellipsis-terminated processing lines
    '✻ 分析代码…',
    'Running 2 shell commands…',
    // Approval / recap lines that are not per-turn summaries
    '※ recap: something happened',
    'Do you want to proceed?',
  ];
  for (const s of notIdle) {
    test(`false for ${JSON.stringify(s)}`, () => {
      expect(cli.looksIdle(s)).toBe(false);
    });
  }

  // Multi-line: the summary can be on any line of the screen (usually near
  // the bottom, but the anchor is line-oriented, not tail-restricted).
  test('true when a per-turn summary appears on any line of a multi-line screen', () => {
    const screen = [
      '[history]',
      '[more history]',
      '✻ Worked for 10s',
      '> ',
    ].join('\n');
    expect(cli.looksIdle(screen)).toBe(true);
  });
});

test.describe('detectRecovery', () => {
  test('flags the resume-fallback case on "No conversation found to continue"', () => {
    expect(cli.detectRecovery('Error: No conversation found to continue'))
      .toEqual({ kind: 'restart-without-resume' });
  });

  test('case-insensitive match', () => {
    expect(cli.detectRecovery('no conversation found to continue'))
      .toEqual({ kind: 'restart-without-resume' });
  });

  test('null for ordinary output', () => {
    expect(cli.detectRecovery('hello world')).toBeNull();
    expect(cli.detectRecovery('')).toBeNull();
  });
});
