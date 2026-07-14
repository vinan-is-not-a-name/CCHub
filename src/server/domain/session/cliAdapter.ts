export const TIMING = {
  /** Below this gap, screen changes are still attributed to the user's keystrokes. */
  inputSilenceMs: 350,
  /** After processing, this much silence flips the session to idle. cc's
   * thinking phase can have brief pauses where the screen doesn't change
   * (waiting on a tool call, loading a file, spinner tick gap); observed
   * pauses have reached the mid-teens of seconds, so the window must
   * comfortably exceed that or the session flips to idle mid-turn and fires
   * a spurious CC-ready notification. */
  idleAfterMs: 20000,
  /** Safety-net cap on how long we keep a session in 'processing' when we've
   * seen NEITHER a busy signal (`…` spinner line, `esc to interrupt`) NOR an
   * idle signal (`Worked for 10s` per-turn summary). Under the "must observe
   * a positive idle marker" rule this is what breaks a session out of a
   * permanently-processing state if cc's output format changes or the
   * session gets wedged. 5 minutes comfortably exceeds any realistic cc
   * "output done, spinner not yet redrawn" gap without letting a truly
   * wedged session pretend to be busy forever. */
  hardIdleTimeoutMs: 5 * 60 * 1000,
  /** Gap between writing a bracketed-paste payload and the submitting CR, so an
   * async image read (claude loading the pasted path from disk) finishes first. */
  pasteSubmitMs: 1500,
  /** Time-since-spawn window during which `detectRecovery` output-scanning
   * stays active. Startup errors (bad --resume, missing conversation, etc.)
   * surface within the first ~1s of a channel's life. After the window
   * closes, the same recovery-pattern string in cc's output is almost
   * certainly *content* — the user pasted a log, cc quoted a file, the
   * conversation is editing the pattern definition itself — and matching it
   * would kill a live session and respawn a blank one. 8s comfortably
   * exceeds observed startup-error latency without inviting false hits
   * during ordinary use. */
  recoveryWindowMs: 8000,
};

export interface CliRecoveryAction {
  kind: 'restart-without-resume';
}

/** Minimal launch shape the CLI adapter needs to build its command. `ResolvedLaunch`
 * structurally satisfies this, so the domain layer stays free of any upward import. */
export interface CliLaunchSpec {
  resume?: string;
  /** Append `--dangerously-skip-permissions` so claude never prompts for tool
   * approval. Granted at the preset level. */
  skipPermissions?: boolean;
  /** Path to a per-session MCP config file. When set, the CLI is told to load it
   * and to allow the feed-image tool. Absent → no MCP flags (feature disabled). */
  mcpConfigPath?: string;
}

/** Adapter for a CLI surface (Claude, aider, etc.). Lets the session manager stay free of CLI-specific text.
 * Stateless: every method is a pure function of its inputs, so one instance is safe to share across sessions. */
export interface CliAdapter {
  /** Build the full argv including the program name (e.g. `['claude', '-c']`). */
  buildCommand(launch: CliLaunchSpec): string[];
  /** Whether the current screen text is prompting the user to approve an action. Pure predicate. */
  isAwaitingApproval(screenText: string): boolean;
  /** Whether the current screen text says the CLI is still doing work (a long
   * tool call, pending background shell, spinner hint). Used to gate the
   * output-silence idle flip: if the screen shouts "busy" we don't fire a
   * ready notification just because stdout paused for the idle window. Pure
   * predicate. */
  looksBusy(screenText: string): boolean;
  /** Whether the current screen text shows a *positive* "cc finished this
   * turn" marker — cc's per-turn summary line (`Worked for 10s`, `Baked for
   * 9s`, `Cogitated for 27s`). Used as a fast-path in the idle flip: when
   * this is true we can trust it and fire ready immediately, even if the
   * grace window hasn't fully elapsed. Absence is NOT proof of busy — cc
   * sometimes settles into an idle prompt without a summary line — so this
   * is only ever consulted for a positive flip, never for a negative
   * "still busy" decision. Pure predicate. */
  looksIdle(screenText: string): boolean;
  /** Whether the screen shows the current turn was ended by a user esc-interrupt
   * (rather than cc still working). cc's Stop hook does NOT fire on a user
   * interrupt, so this screen signal is the only thing that flips an
   * esc-cancelled turn back to idle.
   *
   * This is a composite decision, not a bare "does the word Interrupted
   * appear" check, because cc does NOT clear the screen on interrupt: the
   * spinner frames from the turn just cancelled linger in the buffer. So the
   * rule is positional — within a recent tail window, the interrupt marker
   * must sit *below* the last LIVE busy hint (`esc to interrupt` /
   * `shells still running`). A stale spinner ellipsis further up does NOT
   * block the flip (that lingering `…` is exactly what kept esc-cancelled
   * sessions stuck on 'processing'), and a busy hint co-occurring on/under the
   * interrupt marker keeps the turn alive (cc quoting "Interrupted" while
   * genuinely working). Pure predicate. */
  turnEndedByInterrupt(screenText: string): boolean;
  /** Look at a raw output chunk for CLI-level recovery hints (e.g. "no conversation found"). */
  detectRecovery(chunk: string): CliRecoveryAction | null;
}
