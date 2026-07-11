import { test, expect } from '@playwright/test';
import { buildLocalShellSpec, psSingleQuote, labelFor, assertSafeShellCwd } from '../src/server/infrastructure/shell/revealLocalShell.js';

// buildLocalShellSpec is the pure argv builder for local-shell reveal.
// The interesting logic is the split between "just spawn a new console
// (non-admin)" and "route through PowerShell Start-Process -Verb RunAs
// (admin)", and the cwd path — inherited via spawn options for the
// non-admin path, injected as PowerShell -WorkingDirectory for the
// admin path (because UAC drops the parent cwd).

test.describe('non-admin: cwd rides on spawn cwd option', () => {
  test('cmd: `cmd /c start "" cmd.exe` with cwd on the spawn option', () => {
    const spec = buildLocalShellSpec('C:\\proj', 'cmd');
    expect(spec.file).toBe('cmd.exe');
    // `start` needs a title as its first arg or it will misparse the shell
    // name as the title on paths containing spaces. Empty string works.
    expect(spec.args).toEqual(['/c', 'start', '', 'cmd.exe']);
    expect(spec.cwd).toBe('C:\\proj');
  });

  test('powershell: same shape, swap the tail exe', () => {
    const spec = buildLocalShellSpec('C:\\proj', 'powershell');
    expect(spec.file).toBe('cmd.exe');
    expect(spec.args).toEqual(['/c', 'start', '', 'powershell.exe']);
    expect(spec.cwd).toBe('C:\\proj');
  });

  test('cwd with spaces travels through unchanged — no manual quoting needed', () => {
    // The whole point of putting cwd on the spawn option instead of splicing
    // it into the `start` argv is that this Just Works — no quoting logic,
    // no `&` / `^` gotchas.
    const spec = buildLocalShellSpec('C:\\path with spaces\\proj', 'cmd');
    expect(spec.cwd).toBe('C:\\path with spaces\\proj');
    // The argv itself does NOT contain cwd — belt-and-braces check that
    // we're not inadvertently double-passing it.
    expect(spec.args.join(' ')).not.toContain('spaces');
  });
});

test.describe('admin: cwd is delivered through -ArgumentList (UAC drops -WorkingDirectory)', () => {
  test('cmd-admin: elevated cmd runs `/K cd /D "<cwd>"` as its first command', () => {
    // Regression: previously used `-WorkingDirectory '<cwd>'`, which
    // Windows silently drops under `-Verb RunAs` (elevated cmd lands in
    // C:\Windows\System32 regardless). `-ArgumentList '/K cd /D "..."'`
    // has the elevated shell cd to `<cwd>` as its FIRST action — that's
    // what actually reaches the interactive prompt.
    const spec = buildLocalShellSpec('C:\\proj', 'cmd-admin');
    expect(spec.file).toBe('powershell.exe');
    expect(spec.cwd).toBeUndefined();
    expect(spec.args[0]).toBe('-NoProfile');
    expect(spec.args[1]).toBe('-Command');
    const cmd = spec.args[2]!;
    expect(cmd).toContain('Start-Process');
    expect(cmd).toContain('-FilePath cmd.exe');
    expect(cmd).toContain('-Verb RunAs');
    expect(cmd).toContain(`-ArgumentList '/K cd /D "C:\\proj"'`);
    // The old, silently-broken shape must not sneak back in.
    expect(cmd).not.toContain('-WorkingDirectory');
  });

  test('powershell-admin: elevated PS runs a base64 -EncodedCommand', () => {
    // We route through -EncodedCommand so the cwd string never has to
    // survive the cascading quoting rules of cmd → outer PowerShell →
    // inner elevated PowerShell (Windows paths can contain `'` and
    // triple-nesting single-quote doubling is a known trap). Base64 is
    // pure ASCII with no quote characters, so no parsing layer can break
    // it. This test decodes the payload and asserts on the actual
    // PowerShell command the elevated shell would run.
    const spec = buildLocalShellSpec('C:\\proj', 'powershell-admin');
    expect(spec.file).toBe('powershell.exe');
    const cmd = spec.args[2]!;
    expect(cmd).toContain('-FilePath powershell.exe');
    expect(cmd).toContain('-Verb RunAs');
    expect(cmd).toContain(`'-NoExit', '-EncodedCommand'`);
    expect(cmd).not.toContain('-WorkingDirectory');
    const m = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(cmd);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1]!, 'base64').toString('utf16le');
    expect(decoded).toBe(`Set-Location -LiteralPath 'C:\\proj'`);
  });

  test('single quotes in cwd are doubled at each PowerShell layer', () => {
    // A path like `C:\folks'\proj` isn't unheard of on Windows (`'` is a
    // legal filename char). Without escaping, PowerShell would end the
    // string mid-path. The doubled form arrives at every parser as a
    // literal `'`.
    const cmdSpec = buildLocalShellSpec("C:\\folks'here\\proj", 'cmd-admin');
    expect(cmdSpec.args[2]).toContain(`-ArgumentList '/K cd /D "C:\\folks''here\\proj"'`);

    const psSpec = buildLocalShellSpec("C:\\folks'here\\proj", 'powershell-admin');
    const m = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(psSpec.args[2]!);
    const decoded = Buffer.from(m![1]!, 'base64').toString('utf16le');
    // The elevated PS parser needs the `'` doubled inside its
    // single-quoted string literal, exactly like the outer layer.
    expect(decoded).toBe(`Set-Location -LiteralPath 'C:\\folks''here\\proj'`);
  });

  test('psSingleQuote is the primitive — direct unit', () => {
    expect(psSingleQuote(`a'b'c`)).toBe(`a''b''c`);
    expect(psSingleQuote(`no quotes`)).toBe(`no quotes`);
    // Backslash and $ are literal inside PowerShell single-quoted strings,
    // so they must pass through unchanged.
    expect(psSingleQuote(`C:\\x $y \`z`)).toBe(`C:\\x $y \`z`);
  });
});

test.describe('assertSafeShellCwd: reject cwd that could break out of the quoted context', () => {
  test('a well-formed Windows path passes', () => {
    expect(() => assertSafeShellCwd('C:\\Users\\me\\proj')).not.toThrow();
    expect(() => assertSafeShellCwd('C:\\path with spaces\\proj')).not.toThrow();
    expect(() => assertSafeShellCwd("C:\\folks'here\\proj")).not.toThrow();
  });

  test('a cwd containing `"` is rejected (cmd-admin argv breakout)', () => {
    // NTFS reserves `"`, so no legitimate on-disk path contains one. If we
    // see one it came from a spoofed WS message, and letting it through
    // would let the payload escape `/K cd /D "<cwd>"` and inject commands
    // that run under UAC elevation.
    expect(() => assertSafeShellCwd('C:\\evil"; whoami > c:\\pwned.txt & rem'))
      .toThrow(/unsafe/);
    // and buildLocalShellSpec surfaces the same rejection at the entry point.
    expect(() => buildLocalShellSpec('C:\\evil"payload', 'cmd-admin')).toThrow(/unsafe/);
  });

  test('a cwd containing \\r or \\n is rejected (line-terminator smuggling)', () => {
    // A newline in a Start-Process ArgumentList could split the elevated
    // command line and let an attacker append arbitrary commands.
    expect(() => assertSafeShellCwd('C:\\a\r\nnext-cmd')).toThrow(/unsafe/);
    expect(() => assertSafeShellCwd('C:\\a\nappended')).toThrow(/unsafe/);
  });

  test('a cwd containing NUL is rejected', () => {
    // Some Node APIs truncate at NUL; leaving it in makes the check
    // subject to TOCTOU across parser layers.
    expect(() => assertSafeShellCwd('C:\\a\x00b')).toThrow(/unsafe/);
  });

  test('the error message does not reflect the cwd content back to the caller', () => {
    // The message is deliberately generic so a malformed request that
    // travels back through a toast can't be used to reflect an attacker's
    // payload into the UI.
    try {
      assertSafeShellCwd('C:\\evil"payload; whoami');
    } catch (err) {
      expect((err as Error).message).not.toContain('payload');
      expect((err as Error).message).not.toContain('whoami');
    }
  });
});

test.describe('labelFor: human-readable error messages', () => {
  test('renders each app as the string the toast title would use', () => {
    expect(labelFor('cmd')).toBe('CMD');
    expect(labelFor('cmd-admin')).toBe('CMD (admin)');
    expect(labelFor('powershell')).toBe('PowerShell');
    expect(labelFor('powershell-admin')).toBe('PowerShell (admin)');
  });
});

// keepAttached is what tells revealLocalShell to spawn the launcher WITHOUT
// `detached: true`. The bug this exists to prevent: on Windows, Node's
// spawn(powershell.exe, ['-Command', ...], { detached: true }) exits code 0
// without executing the -Command payload — Start-Process is never called,
// UAC never appears, no elevated shell opens, and the user sees nothing.
// Only powershell.exe launchers hit this; cmd.exe /c start is fine with
// detached:true, so we keep it there.
test.describe('keepAttached: admin variants must not be detached', () => {
  test('admin variants (both) request keepAttached', () => {
    expect(buildLocalShellSpec('C:\\p', 'cmd-admin').keepAttached).toBe(true);
    expect(buildLocalShellSpec('C:\\p', 'powershell-admin').keepAttached).toBe(true);
  });

  test('non-admin variants do NOT request keepAttached (cmd.exe tolerates detached)', () => {
    // Kept as an explicit "not set" rather than "set to false" so a future
    // refactor to `keepAttached: boolean` shows up as a test failure and
    // forces re-review of this decision.
    expect(buildLocalShellSpec('C:\\p', 'cmd').keepAttached).toBeUndefined();
    expect(buildLocalShellSpec('C:\\p', 'powershell').keepAttached).toBeUndefined();
  });
});
