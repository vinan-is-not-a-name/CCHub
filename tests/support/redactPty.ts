/**
 * Length-preserving redaction for real PTY captures.
 *
 * A `CCHUB_RECORD_PTY` capture is the strongest test oracle we have: it is what
 * cc *actually* emitted, not what we imagined it would. But a capture taken on
 * someone's machine carries their filesystem paths, their account's billing
 * mode, and (in the env probes) their terminal's session GUID. Those have to go
 * before a capture can be committed.
 *
 * Every replacement is the SAME BYTE LENGTH as what it replaces. cc paints its
 * UI with absolute column moves (`CSI 52G`, `CSI 168G`) computed against the
 * text it wrote; shortening `D:\Temp\cchub-cwd-probe` to `<path>` would leave
 * those columns pointing at cells the text no longer reaches, and every
 * downstream grid assertion would be asserting an artifact of the redaction.
 * So: same length, or don't redact.
 *
 * The redactor is deliberately dumb about *finding* things — it only rewrites
 * patterns it can match structurally (drive-letter paths, POSIX home paths,
 * GUIDs, the billing line). `assertRedacted` is the part that has teeth: it
 * re-scans the output and throws if anything path-shaped or GUID-shaped is
 * left, so a capture containing a form we didn't anticipate fails to commit
 * instead of leaking quietly.
 */

/** A single redaction: what matched, and what it became. */
export interface Redaction {
  kind: 'winPath' | 'posixHome' | 'guid' | 'billing' | 'userName';
  from: string;
  to: string;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

/** Windows drive-letter paths: `D:\temp\new`, `C:/Users/x/y`. Stops at chars cc
 * never puts inside a path in its UI (quotes, box-drawing, escape, whitespace
 * runs). A single trailing space is excluded so `D:\a ` keeps its separator. */
const WIN_PATH = /[A-Za-z]:[\\/][^\s\x1b'"|│╭╮╰╯─]*/g;

/** POSIX home paths: `/home/alice/proj`, `/Users/alice/proj`. Only these two
 * roots — bare `/usr/bin` carries no identity and stays readable. */
const POSIX_HOME = /\/(?:home|Users)\/[^\s\x1b'"|│╭╮╰╯─]*/g;

/** RFC-4122-shaped GUIDs, e.g. a WT_SESSION value. */
const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** cc prints the account's billing mode in its welcome box. Which plan someone
 * is on is account info, and it is not what any of these tests are about. */
const BILLING = /API Usage Billing|Claude Pro|Claude Max|Subscription/g;

/**
 * Rewrite `s` to a fixed-length placeholder of exactly `s.length` bytes.
 *
 * The placeholder repeats a marker (`REDACTED`) and truncates, so a redacted
 * region is recognizable at any length: `RED`, `REDACTED`, `REDACTEDREDACT`.
 * Below 3 chars there's no room for a marker, so we use `x` — still a stable,
 * identity-free byte of the right width.
 */
function padTo(len: number, marker = 'REDACTED'): string {
  if (len <= 0) return '';
  if (len < 3) return 'x'.repeat(len);
  return marker.repeat(Math.ceil(len / marker.length)).slice(0, len);
}

/** A path-shaped placeholder of the same length: keeps the drive/root prefix so
 * the capture still reads as a path, and fills the rest. `D:\temp\new` (11) →
 * `D:\REDACTED`. Short paths fall back to plain padding. */
function padPath(original: string): string {
  const len = original.length;
  const prefix = /^[A-Za-z]:[\\/]/.test(original) ? original.slice(0, 3) : '/';
  if (len <= prefix.length) return padTo(len);
  return prefix + padTo(len - prefix.length);
}

/**
 * Redact a capture without changing its byte length.
 *
 * Returns the rewritten text plus the list of substitutions, so a caller (and
 * the spec) can see exactly what was removed rather than trusting that
 * something was.
 */
export function redactPtyCapture(text: string, opts: { userName?: string } = {}): RedactResult {
  const redactions: Redaction[] = [];
  const swap = (kind: Redaction['kind'], to: (m: string) => string) => (m: string) => {
    const replacement = to(m);
    // A same-length guarantee is the whole point; a bug here would silently
    // shift every column in the capture, so it is checked, not assumed.
    if (replacement.length !== m.length) {
      throw new Error(`redactPtyCapture: ${kind} replacement changed length ${m.length} -> ${replacement.length}`);
    }
    redactions.push({ kind, from: m, to: replacement });
    return replacement;
  };

  let out = text;
  // The account's own username can appear outside a path (prompt, git config
  // echo), so it is redacted by value when the caller passes it.
  if (opts.userName && opts.userName.length > 0) {
    const escaped = opts.userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), swap('userName', (m) => padTo(m.length, 'user')));
  }
  out = out.replace(WIN_PATH, swap('winPath', padPath));
  out = out.replace(POSIX_HOME, swap('posixHome', padPath));
  out = out.replace(GUID, swap('guid', (m) => padTo(m.length, 'g')));
  out = out.replace(BILLING, swap('billing', (m) => padTo(m.length, 'Billing ')));

  if (out.length !== text.length) {
    throw new Error(`redactPtyCapture: total length changed ${text.length} -> ${out.length}`);
  }
  return { text: out, redactions };
}

/** Patterns that must not survive into a committed fixture, with a message
 * naming what leaked so a failure is actionable rather than just "regex hit". */
const FORBIDDEN: Array<{ re: RegExp; what: string }> = [
  { re: WIN_PATH, what: 'a Windows filesystem path' },
  { re: POSIX_HOME, what: 'a POSIX home path' },
  { re: GUID, what: 'a GUID (terminal session id?)' },
  { re: BILLING, what: "the account's billing mode" },
  // Credential shapes: never seen in a cc startup frame, but a capture taken
  // during real work could scroll one past, and that must block the commit.
  { re: /sk-[A-Za-z0-9_-]{16,}/g, what: 'an API key' },
  { re: /gh[pousr]_[A-Za-z0-9]{16,}/g, what: 'a GitHub token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: 'a private key' },
];

/**
 * Throw if `text` still contains anything identifying. Called by the fixture
 * spec so an un-redactable capture fails the suite instead of shipping.
 *
 * `padPath` deliberately leaves `D:\REDACTED` in place, which is itself
 * path-shaped — so matches whose body is entirely placeholder are accepted.
 */
export function assertRedacted(text: string, label = 'capture'): void {
  const problems: string[] = [];
  for (const { re, what } of FORBIDDEN) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (isPlaceholder(m[0])) continue;
      problems.push(`${what}: ${JSON.stringify(m[0])} at offset ${m.index}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${label} is not fully redacted:\n  ${problems.join('\n  ')}`);
  }
}

/** Markers `padTo` can emit. A placeholder is a marker repeated and truncated,
 * so the tail is often partial (`REDACTEDREDA`) — comparing against `padTo` of
 * the same length is what makes that recognizable, rather than a regex that
 * would have to spell out every prefix. */
const MARKERS = ['REDACTED', 'Billing ', 'user', 'g', 'x'];

/** True when a match consists only of redaction filler (plus a path prefix), so
 * the redactor's own output isn't reported as a leak. */
function isPlaceholder(m: string): boolean {
  const body = m.replace(/^[A-Za-z]:[\\/]/, '').replace(/^\//, '');
  if (body.length === 0) return false;
  return MARKERS.some((marker) => body === padTo(body.length, marker));
}
