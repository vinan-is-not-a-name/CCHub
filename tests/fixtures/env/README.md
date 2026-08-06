# Environment baselines

Fingerprints written by `node scripts/doctor.mjs --save <file>`. They exist so
`--diff` has something to compare against: the bugs these tests were built for
were all decided by a property of the *machine*, and CI never sees a machine.

## Files

- **`good-machine.json`** — the box cc-remote is developed on, where all seven
  recent bugs are fixed and do not reproduce. Windows 11 24H2 build 26100,
  conhost `10.0.26100.7306`, server launched from Cmder/ConEmu, node-pty's
  bundled `conpty.dll` present. `ccTerminalId: conemu`, which is **not** on cc's
  kitty-keyboard allowlist.

## Using it

On a machine where something misbehaves, from the same shell you start the
server with:

```
node scripts/doctor.mjs --diff tests/fixtures/env/good-machine.json
```

Exit code is 1 when anything differs. Each difference that has a known
consequence prints it, with the commit that addressed it.

Run it from **the shell that launches the server**. Nearly every value here is
inherited from the launching process, so the answer changes with the shell — on
this same machine, PowerShell reports `ccTerminalId: conemu` while Git Bash in
the same window reports `mingw64`, because Git Bash also exports `MSYSTEM` and
`TERM`. That sensitivity is the mechanism behind the env-leak bug (12f2996), not
a flaw in the tool.

## Privacy

`--save` shapes identifying values before writing: GUIDs become `<set: guid>`,
paths become `<set: path depth N>`, numbers become `<set: number>`. Values cc
compares against exact strings (`TERM`, `MSYSTEM`, `TERM_PROGRAM`) are kept
verbatim, because the whole point is what cc will conclude. `tests/doctor.spec.ts`
re-scans every committed baseline with the same guard used on the PTY captures,
so a baseline carrying a real path or key fails the suite rather than landing in
a commit.

## Adding a baseline

Save it here, name it for the machine's role rather than its owner
(`bad-machine-wt.json`, not `bobs-laptop.json`), and add a line above describing
what is known to work or fail on it. The scan in `tests/doctor.spec.ts` picks up
new files automatically.
