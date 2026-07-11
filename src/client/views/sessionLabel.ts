import type { SessionInfo } from '../../shared/protocol.js';
import { t } from '../i18n.js';

/** Human-readable tab/pane label for a session. Primary handle is the
 * preset name (the launch that spawned the session), followed by `info.label`
 * (the `server:cwd` detail from resolveLaunch) in parens. Sessions launched
 * without a preset fall through to a localized "new session" placeholder —
 * we deliberately do NOT reuse the cwd basename as the primary name, because
 * that would make every session in the same directory look like it was
 * named after the folder. The cwd still surfaces in the paren
 * detail and (for the rail chip) on the meta line, so no identity is lost. */
export function sessionLabel(info: SessionInfo): string {
  const name = sessionShortName(info);
  return info.label ? `${name} (${info.label})` : name;
}

/** The primary "name" chunk shared by sessionLabel and the rail chip. */
export function sessionShortName(info: SessionInfo): string {
  return info.presetName || t('session.new');
}

/** Full tooltip for a session: the visible label, then a stack of identifying
 * details (target/server, profile, preset, absolute cwd). Used by the rail
 * tab and the grid pane head so a hover always surfaces the full path even
 * when the label is truncated. */
export function sessionTooltip(info: SessionInfo, label: string = sessionLabel(info)): string {
  const lines = [label];
  const where = info.serverName ? `${info.target} · ${info.serverName}` : info.target;
  lines.push(where);
  if (info.profileName) lines.push(`profile: ${info.profileName}`);
  if (info.presetName) lines.push(`preset: ${info.presetName}`);
  lines.push(info.cwd);
  return lines.join('\n');
}

/** Structured pieces of a session label — a text run or a "reveal" chunk that
 * the DOM adapter turns into a clickable link. Split out from the DOM code
 * so the model is pure and unit-testable in Node without a browser. */
export type SessionLabelPart =
  | { kind: 'text'; text: string }
  | { kind: 'reveal'; text: string; title: string };

/** Break a session's display name into an ordered list of parts. Textually
 * identical to `sessionLabel(info)` when concatenated; `revealable === false`
 * simply substitutes a plain text part where the link would go, so callers
 * with nothing to hook up (harness, snapshots) degrade gracefully. The target
 * kind (local vs ssh) no longer gates revealability — SSH sessions get a link
 * too, but the caller pops a small XShell/XFTP menu instead of firing an OS
 * file browser. */
export function sessionLabelParts(info: SessionInfo, revealable: boolean): SessionLabelPart[] {
  const name = sessionShortName(info);
  if (info.label) {
    const title = info.target === 'local'
      ? t('rail.reveal.local').replace('{cwd}', info.cwd)
      : t('rail.reveal.remote').replace('{cwd}', info.cwd);
    const detail: SessionLabelPart = revealable
      ? { kind: 'reveal', text: info.label, title }
      : { kind: 'text', text: info.label };
    return [{ kind: 'text', text: `${name} (` }, detail, { kind: 'text', text: ')' }];
  }
  return [{ kind: 'text', text: name }];
}

/** Fill `el` with the session's display name. Textually identical to
 * `sessionLabel(info)`, but the parenthesized detail becomes a clickable
 * `<a>` — clicking it fires `onReveal(anchor)`, where anchor is the link
 * element itself. The caller wires that: local sessions send a `shell.reveal`
 * for `app: 'files'`; SSH sessions pop a small menu (Open in XShell / Open
 * in XFTP) positioned against the anchor. Called on every store notification,
 * so we clear the element and rebuild rather than diffing — the DOM here is
 * two or three nodes deep, so the churn is negligible.
 *
 * When a `(label)` chunk exists, the whole paren block — the opening `(`, the
 * reveal link, and the closing `)` — is wrapped in a `<span class="pane-label">`
 * so a single CSS rule can reshape all three into the subordinate Inter/11.5px
 * micro-caption from the mockup. Without the wrapper the parentheses would
 * inherit the surrounding serif 13px face from `.pane-name` and read as the
 * same weight as the primary name, killing the visual hierarchy. */
export function renderSessionLabel(
  el: HTMLElement,
  info: SessionInfo,
  onReveal: ((anchor: HTMLElement) => void) | null,
): void {
  el.textContent = '';
  const revealable = !!onReveal;
  const parts = sessionLabelParts(info, revealable);

  // Fast path: no reveal chunk (e.g. no cwd, or non-revealable). Just emit the
  // flat text run into `.pane-name` as before.
  const hasReveal = parts.some((p) => p.kind !== 'text');
  if (!hasReveal) {
    for (const part of parts) el.appendChild(document.createTextNode(part.text));
    return;
  }

  // Structured path: sessionLabelParts always returns [text `${path} (`, reveal, text `)`].
  // Split the leading text at the last `(` so the opening paren joins the wrapper.
  const [head, detail, tail] = parts as [
    { kind: 'text'; text: string },
    { kind: 'reveal'; text: string; title: string },
    { kind: 'text'; text: string },
  ];
  const openIdx = head.text.lastIndexOf('(');
  const namePrefix = openIdx >= 0 ? head.text.slice(0, openIdx) : head.text;
  const openParen = openIdx >= 0 ? head.text.slice(openIdx) : '(';
  if (namePrefix) el.appendChild(document.createTextNode(namePrefix));

  const wrap = document.createElement('span');
  wrap.className = 'pane-label';
  wrap.appendChild(document.createTextNode(openParen));

  const link = document.createElement('a');
  link.className = 'reveal-cwd';
  link.href = '#';
  link.textContent = detail.text;
  link.title = detail.title;
  // Kill the browser's native HTML5 link-drag. Without this, pointerdown on
  // an <a> starts a link drag that cancels the subsequent pointermove
  // events — and the tab/pane-head drag-reorder handler never sees them.
  link.draggable = false;
  link.addEventListener('dragstart', (event) => event.preventDefault());
  link.addEventListener('click', (event) => {
    // Kill the browser navigation on `href="#"` and stop the click from
    // bubbling into the tab/pane-head handlers that would otherwise
    // activate the session. (A completed drag suppresses its trailing
    // click at the drag layer, so this only fires on a real click.)
    event.preventDefault();
    event.stopPropagation();
    onReveal!(link);
  });
  wrap.appendChild(link);
  wrap.appendChild(document.createTextNode(tail.text));
  el.appendChild(wrap);
}
