# Real cc PTY captures

Byte streams that the real `claude` CLI actually emitted, captured with
`CCHUB_RECORD_PTY=<dir>` (see `memory/ptylog-cchub-record-pty.md`).

These exist because most of this repo's bugs live on the boundary between
cc-remote and software we don't control — the host conhost, the launching shell,
ssh2's packet boundaries, cc's own width tables. A hand-written fake on that
boundary encodes our *model* of the other side, so when the model is wrong the
code and its test are wrong together and agree with each other. A capture can't
do that: it is what happened.

## Fixtures

| File | Host | Geometry | Notable |
|---|---|---|---|
| `startup-conemu-170x40.raw` | Cmder/ConEmu (`ConEmu*` env) | 170×40 | cc id `conemu` → no kitty keyboard, no `?2026`; emits `OSC 9;4` taskbar progress. Tips panel + What's-new visible. |
| `startup-wt-54x30.raw` | Windows Terminal (`WT_SESSION` env) | 54×30 | cc id `windows-terminal` → pushes kitty keyboard (`CSI >1u`) + modifyOtherKeys (`CSI >4;2m`), wraps frames in `?2026`; no `OSC 9;4`. Narrow box, tips panel gone. |

Both are `claude` 2.1.220 startup frames through the same bundled ConPTY,
captured on two machines. The pair is the evidence for commit `12f2996`
(`normalizeTerminalEnv`) — see `memory/host-terminal-env-leak.md`.

Their value is that they differ *only* in host terminal identity, which makes
them a differential pair: any assertion that holds for one and not the other is
either a real capability difference or a bug.

## Privacy

Captures are redacted **length-preservingly** before being committed. cc paints
its UI with absolute column moves (`CSI 52G`, `CSI 168G`) computed against the
text it wrote; a shorter replacement would leave those columns pointing past the
text, and every grid assertion would then be measuring the redaction rather than
cc. So a redacted region is the same number of characters as the original.

Redacted here: the session cwd (`D:\REDACTED…`) and the account's billing mode
(`Billing Billing B`). Model names, cc version, tips text and release notes are
public software output and stay — and the fact that the two machines were on
different model configs is itself useful fixture information.

To add a capture:

```
node scripts/redactCapture.mjs <in.raw> tests/fixtures/pty/<name>.raw [--user <name>]
```

The script re-scans its own output and refuses to write if anything
path-shaped, GUID-shaped, or credential-shaped survives. `tests/ptyFixtures.spec.ts`
re-runs that scan over every `.raw` in this directory on each test run, so a
capture added by hand is checked too — and it asserts each file carries cc's real
startup handshake, so a hand-written stub can't quietly take a capture's place.

Never commit anything from `ptyraw/` directly; that directory is where raw,
unredacted captures land.
