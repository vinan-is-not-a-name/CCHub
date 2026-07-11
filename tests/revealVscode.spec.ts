import { test, expect } from '@playwright/test';
import { buildVscodeArgs, buildVscodeSpawn } from '../src/server/infrastructure/shell/revealVscode.js';
import type { SshServerProfile } from '../src/shared/protocol.js';

// buildVscodeArgs is the pure argv builder — it decides which flags the
// launcher receives without spawning a process. The interesting logic is
// the local vs Remote-SSH split and the host:port shape we hand VS Code
// on non-default SSH ports.

function ssh(overrides: Partial<SshServerProfile> = {}): SshServerProfile {
  return {
    id: 's', name: 'edge', kind: 'ssh', os: 'linux', host: 'srv.example', port: 22,
    username: 'alice', auth: { method: 'privateKeyPath', privateKeyPath: '/k' },
    createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

test('local session opens with just the cwd as the positional', () => {
  expect(buildVscodeArgs('/home/me/proj')).toEqual(['/home/me/proj']);
});

test('SSH session with default port 22 uses user@host — no explicit port', () => {
  // VS Code's --remote parser is picky about redundant :22 on some builds
  // (some builds resolve `alice@srv:22` as a different authority than
  // `alice@srv` and silently open an empty window). Default port is
  // omitted so the parser sees the canonical authority.
  expect(buildVscodeArgs('/remote/work', ssh())).toEqual([
    '--remote', 'ssh-remote+alice@srv.example', '/remote/work',
  ]);
});

test('SSH session with a non-default port appends :port to the authority', () => {
  expect(buildVscodeArgs('/x', ssh({ port: 2222 }))).toEqual([
    '--remote', 'ssh-remote+alice@srv.example:2222', '/x',
  ]);
});

test('SSH authority uses the ssh server username verbatim (no URL-encoding)', () => {
  // VS Code parses --remote as an ssh-remote authority, not a URL, so we do
  // NOT URL-encode the username. This is deliberately different from
  // buildXftpUrl / buildXshellUrl which need URL encoding.
  expect(buildVscodeArgs('/x', ssh({ username: 'user.with-dots' }))).toEqual([
    '--remote', 'ssh-remote+user.with-dots@srv.example', '/x',
  ]);
});

// buildVscodeSpawn is the Windows-specific quoting decision. The bug this
// exists to prevent: on Windows we spawn code.cmd via `shell: true`, which
// concatenates command+args into a single string for `cmd.exe /d /s /c`.
// A default VS Code install path — `C:\Program Files\Microsoft VS Code\bin\
// code.cmd` — has a space in it, and cmd truncates unquoted commands at the
// first space (real repro on this machine: "'C:\Program' is not recognized as
// an internal or external command"). Every piece must be quoted so cmd's
// `/c ""a" "b""` outer-quote-strip re-parses correctly.

test('non-Windows: exe + args pass through untouched, no shell', () => {
  const r = buildVscodeSpawn('/usr/local/bin/code', ['/home/me/proj'], 'linux');
  expect(r).toEqual({ command: '/usr/local/bin/code', args: ['/home/me/proj'], useShell: false });
});

test('non-Windows: an .exe is spawned directly even on darwin (no shell)', () => {
  const r = buildVscodeSpawn('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', ['/x'], 'darwin');
  expect(r.useShell).toBe(false);
  expect(r.command).toBe('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
});

test('Windows + code.cmd with a space in the path: exe AND args get quoted', () => {
  // The exact shape of the previously-broken input. Under the old code the
  // command was `C:\tools\Microsoft VS Code\bin\code.cmd` (unquoted) and cmd
  // read `C:\tools\Microsoft` as the command → exit 1. Now both the exe and
  // the args are wrapped in `"…"` so cmd sees one command and one argument.
  const r = buildVscodeSpawn(
    'C:\\tools\\Microsoft VS Code\\bin\\code.cmd',
    ['D:\\Temp'],
    'win32',
  );
  expect(r.useShell).toBe(true);
  expect(r.command).toBe('"C:\\tools\\Microsoft VS Code\\bin\\code.cmd"');
  expect(r.args).toEqual(['"D:\\Temp"']);
});

test('Windows + .bat is also treated as a shell target (same code path)', () => {
  // Not something we ship, but a user could point vscodePath at a .bat
  // wrapper and the same quoting rule applies. Locks the pattern so a
  // future refactor doesn't narrow it to .cmd only.
  const r = buildVscodeSpawn('C:\\wrap\\code.bat', ['/x'], 'win32');
  expect(r.useShell).toBe(true);
  expect(r.command).toBe('"C:\\wrap\\code.bat"');
});

test('Windows + a bare code.exe: no shell needed, no quoting applied', () => {
  // Regression fence: only .cmd/.bat trigger the shell path. If a user ever
  // configured Code.exe directly we would spawn it via Node's argv-aware
  // path where extra quoting would BREAK the argument. This test locks that
  // we don't drift toward always-quoting.
  const r = buildVscodeSpawn('C:\\Program Files\\Microsoft VS Code\\Code.exe', ['D:\\Temp'], 'win32');
  expect(r.useShell).toBe(false);
  expect(r.command).toBe('C:\\Program Files\\Microsoft VS Code\\Code.exe');
  expect(r.args).toEqual(['D:\\Temp']);
});

test('Windows + Remote-SSH argv (multi-arg) is quoted per-argument', () => {
  // buildVscodeArgs produces ['--remote', 'ssh-remote+alice@srv:2222', '/x']
  // for a non-default-port SSH session; every one of them must be quoted
  // individually — cmd would otherwise split on the space after --remote.
  const argv = ['--remote', 'ssh-remote+alice@srv.example:2222', '/remote/work'];
  const r = buildVscodeSpawn('C:\\tools\\Microsoft VS Code\\bin\\code.cmd', argv, 'win32');
  expect(r.args).toEqual([
    '"--remote"',
    '"ssh-remote+alice@srv.example:2222"',
    '"/remote/work"',
  ]);
});
