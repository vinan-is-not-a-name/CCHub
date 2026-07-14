import { SessionState } from '../../../shared/protocol.js';
import { CliAdapter, TIMING } from './cliAdapter.js';

/**
 * Owns the "what state should the session be in?" decision, delegating
 * CLI-specific screen-text matching to the CliAdapter. Holds the per-session
 * `lastStableScreen` baseline so the adapter can stay stateless and shareable.
 * It owns no terminal, channel, or timer, so the detection logic can be unit
 * tested in isolation. ManagedSession remains the orchestrator — it owns the
 * idle timer and feeds this class the screen text plus elapsed-input timing.
 */
export interface StateDecision {
  state: SessionState | null;
  /** Human-readable reason the decision was reached. Used by ManagedSession
   * to log the WHY of every flip so a spurious notification in production
   * can be traced back to the exact screen-text signal that produced it. */
  reason: string;
}

export class SessionStateMachine {
  constructor(
    private readonly cli: CliAdapter,
    private readonly timing = TIMING,
  ) {}

  /** Decide the next state from screen text (or null to leave it unchanged),
   * with a human-readable reason. See {@link StateDecision}.
   *
   * Turn boundaries (idle↔processing) are now driven by cc's hooks
   * (UserPromptSubmit / Stop — see ManagedSession.emitHook), so this screen
   * scraper NO LONGER flips to 'processing' on a generic screen change. Doing
   * so was the root of the "stuck on running" bugs: the startup banner draw
   * and a rewind repaint both change the screen without a turn actually
   * running, and nothing on screen then flips it back. What remains here is
   * only what hooks can't observe: the approval prompt (fast local detection,
   * and the exit from it once the user answers). */
  detectStateExplained(screenText: string, currentState: SessionState, _timeSinceUserInput: number): StateDecision {
    // Belt-and-braces guard: a real approval UI parks the CLI (it stops
    // spinning "esc to interrupt" because it's waiting on user, not
    // running a tool). If the screen matches an approval pattern AND
    // simultaneously shows a busy hint, the approval hit is a false
    // positive — an approval-shaped phrase (`Yes/No`, `(y/n)`, `Do you
    // want to proceed`) surfacing in ongoing content: a log line the
    // user pasted, a code block cc is quoting, a shell script cc is
    // running that itself prompts. Prefer the busy signal. Without this,
    // one such mid-turn hit fires a spurious "CC needs approval" toast
    // while cc is still working.
    if (this.cli.isAwaitingApproval(screenText) && !this.cli.looksBusy(screenText)) {
      return { state: 'awaiting_approval', reason: 'approval-pattern (not busy)' };
    }
    // We were parked at an approval prompt and it's no longer on screen → the
    // user answered and cc resumed the turn. There's no hook for "permission
    // granted, resuming", so this screen transition fills the gap.
    if (currentState === 'awaiting_approval') {
      return { state: 'processing', reason: 'approval cleared → processing' };
    }
    return { state: null, reason: 'no screen-scrape transition (turn boundaries are hook-driven)' };
  }

  /** Back-compat plain-state overload. New callers should prefer
   * {@link detectStateExplained} so the reason string reaches the log. */
  detectState(screenText: string, currentState: SessionState, timeSinceUserInput: number): SessionState | null {
    return this.detectStateExplained(screenText, currentState, timeSinceUserInput).state;
  }

  /** Delay after which a still-processing session is treated as idle. */
  get idleDelayMs(): number {
    return this.timing.idleAfterMs;
  }

  /** Whether a session in `currentState` should flip to idle once the idle delay elapses. */
  shouldSetIdle(currentState: SessionState): boolean {
    return currentState === 'processing';
  }
}
