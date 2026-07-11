import { CliAdapter, CliLaunchSpec, CliRecoveryAction } from './cliAdapter.js';

const APPROVAL_PATTERN = /(?:Do you want to proceed|Yes\/No|\(y\/n\)|\bAllow\b\s+\bDeny\b|\bDeny\b\s+\bAllow\b)/i;
const NO_CONVERSATION_PATTERN = /No conversation found to continue/i;
// Claude prints one of these hints in the bottom status area whenever it
// considers itself busy: `esc to interrupt` while thinking or running a tool,
// `N shell(s) still running` while a background shell hasn't finished. Their
// presence is a hard "not idle" signal — even if stdout has been quiet for the
// idle window, we should not fire a ready notification.
const BUSY_HINT_PATTERN = /esc to (?:interrupt|exit)|shells? still running/i;
// cc's mid-turn spinner line always ends the present-participle verb with `…`
// (U+2026 ellipsis). Examples observed in production:
//   `✻ 分析代码…`
//   `✢ 分析代码… (19s)`
//   `· Forging… (11m 53s · ↑ 10.2k tokens · thought for 3s)`
//   `Running 2 shell commands…`
// The idle per-turn summary uses past-tense with NO ellipsis:
//   `✻ Worked for 10s` / `✻ Baked for 9s` / `✻ Cogitated for 27s`
// So an ellipsis followed by end-of-line or an opening paren is a strong
// "still processing" signal — it survives even between spinner ticks, unlike
// `esc to interrupt` which is on the same status row and disappears whenever
// cc prints a bulk output frame that pushes the row off the visible viewport.
// Restrict to the last few lines so ellipses further up the buffer (an
// assistant message that ended with `…`, a quoted string) don't lock the
// session into perpetual busy.
const PROCESSING_ELLIPSIS_PATTERN = /…\s*(?:\([^\n]*|$)/m;
const BUSY_TAIL_LINES = 8;
// cc's per-turn summary shape: a leading spinner glyph (non-word, non-space),
// a whitespace, a past-tense verb (`\w+ed` — Work-ed, Bak-ed, Cogitat-ed,
// Brew-ed, Crunch-ed, Forg-ed), the literal "for", and a seconds count
// terminating the line. The whole-line anchor is what separates this
// definitive idle marker from the mid-turn `thought for 3s` fragment which
// only ever appears inside a parenthesised aggregate (never as its own line).
const IDLE_SUMMARY_PATTERN = /^\s*\S\s+\w+ed\s+for\s+\d+s\s*$/m;

export class ClaudeCliAdapter implements CliAdapter {
  // The MCP config is registered so feed_image is discoverable, but the tool is
  // intentionally NOT added to --allowedTools: it stays behind claude's own
  // permission prompt until the user explicitly approves it (Allow once /
  // Always allow). Default = present but inactive, opt-in by the user.
  buildCommand(launch: CliLaunchSpec): string[] {
    const argv = launch.resume === 'continue' ? ['claude', '-c'] : ['claude'];
    if (launch.skipPermissions) {
      argv.push('--dangerously-skip-permissions');
    }
    if (launch.mcpConfigPath) {
      argv.push('--mcp-config', launch.mcpConfigPath);
    }
    return argv;
  }

  isAwaitingApproval(screenText: string): boolean {
    return APPROVAL_PATTERN.test(screenText);
  }

  looksBusy(screenText: string): boolean {
    if (BUSY_HINT_PATTERN.test(screenText)) return true;
    const lines = screenText.split(/\r?\n/);
    const tail = lines.slice(-BUSY_TAIL_LINES).join('\n');
    return PROCESSING_ELLIPSIS_PATTERN.test(tail);
  }

  looksIdle(screenText: string): boolean {
    return IDLE_SUMMARY_PATTERN.test(screenText);
  }

  detectRecovery(chunk: string): CliRecoveryAction | null {
    return NO_CONVERSATION_PATTERN.test(chunk) ? { kind: 'restart-without-resume' } : null;
  }
}
