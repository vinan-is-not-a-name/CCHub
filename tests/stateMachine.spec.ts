import { test, expect } from '@playwright/test';
import { SessionStateMachine } from '../src/server/domain/session/StateMachine.js';
import { TIMING } from '../src/server/domain/session/cliAdapter.js';
import type { CliAdapter, CliLaunchSpec, CliRecoveryAction } from '../src/server/domain/session/cliAdapter.js';

/** Treats any screen text containing "APPROVE" as an approval prompt, and any
 * containing "BUSY" as a busy-status screen. Stateless. */
class FakeCli implements CliAdapter {
  buildCommand(_launch: CliLaunchSpec): string[] { return ['claude']; }
  isAwaitingApproval(screenText: string): boolean { return screenText.includes('APPROVE'); }
  looksBusy(screenText: string): boolean { return screenText.includes('BUSY'); }
  looksIdle(screenText: string): boolean { return screenText.includes('DONE'); }
  looksInterrupted(screenText: string): boolean { return screenText.includes('INTERRUPTED'); }
  detectRecovery(_chunk: string): CliRecoveryAction | null { return null; }
}

test.describe('SessionStateMachine', () => {
  test('enters awaiting_approval when the adapter detects an approval prompt', () => {
    const sm = new SessionStateMachine(new FakeCli());
    expect(sm.detectState('please APPROVE this', 'processing', 0)).toBe('awaiting_approval');
  });

  test('leaves awaiting_approval back to processing once the prompt clears', () => {
    const sm = new SessionStateMachine(new FakeCli());
    // No approval pattern on the current screen + we were parked awaiting → the
    // user answered and cc resumed. There's no hook for "permission granted",
    // so this screen transition is what moves us back to processing.
    expect(sm.detectState('done', 'awaiting_approval', 0)).toBe('processing');
  });

  // Turn boundaries (idle↔processing) are now hook-driven (UserPromptSubmit /
  // Stop in ManagedSession), so the state machine must NOT flip to processing
  // on a generic screen change — that was the root of the cold-start /
  // rewind "stuck on running" bugs.
  test('does NOT flip to processing on a generic screen change (turn boundaries are hook-driven)', () => {
    const sm = new SessionStateMachine(new FakeCli());
    expect(sm.detectState('new output', 'idle', TIMING.inputSilenceMs + 1)).toBeNull();
  });

  test('ignores the input-silence timing entirely (no screen-change→processing rule remains)', () => {
    const sm = new SessionStateMachine(new FakeCli());
    expect(sm.detectState('typed by user', 'idle', TIMING.inputSilenceMs - 1)).toBeNull();
    expect(sm.detectState('lots of output', 'idle', TIMING.inputSilenceMs + 9999)).toBeNull();
  });

  test('only a processing session should flip to idle', () => {
    const sm = new SessionStateMachine(new FakeCli());
    expect(sm.shouldSetIdle('processing')).toBe(true);
    expect(sm.shouldSetIdle('idle')).toBe(false);
    expect(sm.shouldSetIdle('awaiting_approval')).toBe(false);
    expect(sm.shouldSetIdle('exited')).toBe(false);
  });

  test('exposes the idle delay from timing', () => {
    const sm = new SessionStateMachine(new FakeCli());
    expect(sm.idleDelayMs).toBe(TIMING.idleAfterMs);
  });

  test('honors an injected timing override', () => {
    const custom = { inputSilenceMs: 10, idleAfterMs: 99 };
    const sm = new SessionStateMachine(new FakeCli(), custom);
    expect(sm.idleDelayMs).toBe(99);
  });

  // The "notification fires while cc is still working" failure mode: while cc is
  // in a busy phase (rendering "esc to interrupt", running a shell) an
  // approval-shaped phrase can transiently appear in ongoing content — a
  // log line the user pasted, a code snippet cc is quoting, a shell script
  // that itself prints (y/n). The FIRST-approval-wins rule would then flip
  // the session to awaiting_approval mid-turn and fire a spurious "CC needs
  // approval" toast. The state machine must prefer the busy signal.
  test('busy-guard: an approval hit that co-occurs with a busy screen is ignored', () => {
    const sm = new SessionStateMachine(new FakeCli());
    // Screen has BOTH signals (a real Claude approval never shows an
    // "esc to interrupt" spinner because the CLI is parked on user).
    // State should stay unchanged — no awaiting_approval flip.
    expect(sm.detectState('APPROVE this? BUSY', 'processing', 0)).toBeNull();
  });

  test('busy-guard: an approval hit on a NOT-busy screen still flips as before', () => {
    const sm = new SessionStateMachine(new FakeCli());
    expect(sm.detectState('please APPROVE this', 'processing', 0)).toBe('awaiting_approval');
  });

  test('detectStateExplained: reason string names the busy-guard skip so server logs can trace it', () => {
    const sm = new SessionStateMachine(new FakeCli());
    // A screen carrying BOTH an approval phrase and a busy hint must not flip
    // to awaiting_approval — the busy signal wins. The decision is a
    // null-transition with a non-empty reason a log trace can read back.
    const d1 = sm.detectStateExplained('APPROVE this? BUSY', 'processing', 0);
    expect(d1.state).toBeNull();
    expect(typeof d1.reason).toBe('string');
    expect(d1.reason.length).toBeGreaterThan(0);
  });

  test('detectStateExplained: reason names the approval flip when it does fire', () => {
    const sm = new SessionStateMachine(new FakeCli());
    const d = sm.detectStateExplained('please APPROVE', 'processing', 0);
    expect(d.state).toBe('awaiting_approval');
    expect(d.reason).toContain('approval');
  });

  test('detectStateExplained: a generic idle screen change is a null decision flagged hook-driven', () => {
    const sm = new SessionStateMachine(new FakeCli());
    const d = sm.detectStateExplained('some fresh output', 'idle', TIMING.inputSilenceMs + 1);
    expect(d.state).toBeNull();
    expect(d.reason).toContain('hook-driven');
  });
});
