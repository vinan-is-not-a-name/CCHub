import { test, expect } from '@playwright/test';
import { buildXshellSessionFile, buildXshellUrl, buildXftpUrl } from '../src/server/infrastructure/shell/revealSsh.js';
import type { SshServerProfile } from '../src/shared/protocol.js';

// The `.xsh` builder and the sftp URL builder are the two pure parts of the
// remote-reveal side-effect. Testing them here lets us pin the fields we
// need (RemoteCommand as the SSH auto-cwd channel, not InitRemoteDirectory)
// without having to actually spawn XShell / XFTP.

function passwordServer(overrides: Partial<SshServerProfile> = {}): SshServerProfile {
  return {
    id: 's', name: 'edge', kind: 'ssh', os: 'linux',
    host: '192.0.2.10', port: 22, username: 'alice',
    auth: { method: 'password' },
    createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function keyServer(privateKeyPath = '/home/me/.ssh/id_ed25519'): SshServerProfile {
  return passwordServer({ auth: { method: 'privateKeyPath', privateKeyPath } });
}

test.describe('buildXshellSessionFile', () => {
  test('emits Host / Port / Protocol in [CONNECTION]', () => {
    const body = buildXshellSessionFile(passwordServer(), '/home/alice/my-project');
    expect(body).toContain('[CONNECTION]');
    expect(body).toContain('Protocol=SSH');
    expect(body).toContain('Host=192.0.2.10');
    expect(body).toContain('Port=22');
  });

  test('routes auto-cwd through [CONNECTION:SSH] RemoteCommand (not InitRemoteDirectory)', () => {
    // InitRemoteDirectory is a SFTP/FTP-only field and does nothing on SSH
    // sessions. Auto-cwd must go through RemoteCommand.
    const body = buildXshellSessionFile(passwordServer(), '/home/alice/my-project');
    expect(body).toContain('[CONNECTION:SSH]');
    expect(body).toContain(`RemoteCommand=cd '/home/alice/my-project' && exec $SHELL -l`);
    expect(body).not.toMatch(/^InitRemoteDirectory=/m);
  });

  test('escapes single quotes in cwd so an adversarial path cannot break out of the quoted string', () => {
    // POSIX-safe: close, escape, reopen. `it's` becomes `it'\''s`.
    const body = buildXshellSessionFile(passwordServer(), `/tmp/it's a dir`);
    expect(body).toContain(`RemoteCommand=cd '/tmp/it'\\''s a dir' && exec $SHELL -l`);
  });

  test('emits UserName and leaves Password / Passphrase empty (XShell encryption is per-machine)', () => {
    const body = buildXshellSessionFile(passwordServer(), '/tmp');
    expect(body).toContain('UserName=alice');
    expect(body).toMatch(/^Password=$/m);
    expect(body).toMatch(/^Passphrase=$/m);
  });

  test('writes the private-key path into UserKey when the server uses key auth', () => {
    const body = buildXshellSessionFile(keyServer('/home/me/.ssh/id_ed25519'), '/tmp');
    expect(body).toContain('UserKey=/home/me/.ssh/id_ed25519');
  });

  test('leaves UserKey empty when the server uses password auth', () => {
    const body = buildXshellSessionFile(passwordServer(), '/tmp');
    expect(body).toMatch(/^UserKey=$/m);
  });

  test('uses CRLF line endings (XShell is a Windows-native app)', () => {
    const body = buildXshellSessionFile(passwordServer(), '/tmp');
    expect(body.includes('\r\n')).toBe(true);
  });

  test('rejects host / username / cwd / userKey containing CR or LF (INI injection guard)', () => {
    // Newlines in any of these would let a spoofed value splice a new
    // [SECTION] header or overwrite a real field like `AuthMethodList=` in
    // the emitted INI body. Legitimate SSH inputs never contain these, so
    // rejecting is safe.
    expect(() => buildXshellSessionFile(passwordServer({ host: '192.0.2.10\n[Nefarious]' }), '/tmp'))
      .toThrow(/host contains characters unsafe/);
    expect(() => buildXshellSessionFile(passwordServer({ username: 'alice\nAuthMethodList=00' }), '/tmp'))
      .toThrow(/username contains characters unsafe/);
    expect(() => buildXshellSessionFile(passwordServer(), '/tmp\r\n[Nefarious]'))
      .toThrow(/cwd contains characters unsafe/);
    expect(() => buildXshellSessionFile(keyServer('/keys/id\nAuthMethodList=00'), '/tmp'))
      .toThrow(/privateKeyPath contains characters unsafe/);
  });

  test('rejects a NUL in any INI-embedded field', () => {
    // Same class as the newline case — parsers on the receiving end (XShell
    // and the file writer) each handle NUL differently and letting one
    // through invites TOCTOU quirks.
    expect(() => buildXshellSessionFile(passwordServer({ host: '192.0.2.10\x00' }), '/tmp'))
      .toThrow(/host contains characters unsafe/);
  });
});

test.describe('buildXshellUrl', () => {
  test('returns ssh://user:password@host:port when the server has a password', () => {
    // XShell's docs: URL properties override the paired session file, so the
    // Password= field's emptiness doesn't matter — the URL password wins and
    // the prompt is skipped.
    const url = buildXshellUrl(passwordServer({ auth: { method: 'password', password: 'secret' } }));
    expect(url).toBe('ssh://alice:secret@192.0.2.10:22');
  });

  test('percent-encodes passwords with @ / : / # / spaces so the URL structure survives', () => {
    // Real passwords are RFC 3986 reserved-char soup; encodeURIComponent
    // handles every char that would misparse the authority.
    const url = buildXshellUrl(passwordServer({ auth: { method: 'password', password: 'p@ss:w/rd# !' } }));
    expect(url).toBe('ssh://alice:p%40ss%3Aw%2Frd%23%20!@192.0.2.10:22');
  });

  test('percent-encodes usernames that contain a literal @', () => {
    const url = buildXshellUrl(passwordServer({
      username: 'u@corp',
      auth: { method: 'password', password: 'p' },
    }));
    expect(url).toBe('ssh://u%40corp:p@192.0.2.10:22');
  });

  test('returns null for private-key auth (no password to inline, key path lives in the .xsh file)', () => {
    expect(buildXshellUrl(keyServer('/home/me/.ssh/id_ed25519'))).toBeNull();
  });

  test('returns null when password auth is declared but the password field is empty', () => {
    // Falls back to the file-association path in revealXshell — XShell will
    // prompt if it needs to. Better than emitting `user:@host` which some
    // parsers reject.
    expect(buildXshellUrl(passwordServer({ auth: { method: 'password', password: '' } }))).toBeNull();
  });

  test('returns null when password auth has no password field at all', () => {
    expect(buildXshellUrl(passwordServer())).toBeNull();
  });
});

test.describe('buildXftpUrl', () => {
  test('builds sftp://user@host:port/path with the cwd as URL path (no password)', () => {
    const url = buildXftpUrl(passwordServer(), '/home/alice/my-project');
    expect(url).toBe('sftp://alice@192.0.2.10:22/home/alice/my-project');
  });

  test('percent-encodes segments containing spaces or reserved chars', () => {
    // The path is preserved verbatim aside from encoding chars that would
    // break URL parsing — spaces become %20, '#' becomes %23, etc.
    const url = buildXftpUrl(passwordServer(), '/srv/My Project#1');
    expect(url).toBe('sftp://alice@192.0.2.10:22/srv/My%20Project%231');
  });

  test('percent-encodes usernames that contain a literal @', () => {
    // Rare but possible with corporate SSO identities; without encoding the
    // URL parser would misread the authority.
    const url = buildXftpUrl(passwordServer({ username: 'u@corp' }), '/x');
    expect(url).toBe('sftp://u%40corp@192.0.2.10:22/x');
  });

  test('prefixes a slash when the cwd is not already absolute', () => {
    // XFTP still needs `sftp://…/relative` (not `sftp://…relative`) to keep
    // the authority parsable; the builder normalizes.
    const url = buildXftpUrl(passwordServer(), 'relative/dir');
    expect(url).toBe('sftp://alice@192.0.2.10:22/relative/dir');
  });

  test('rejects hosts containing characters that would reshape the URL authority', () => {
    // `@` in a host would split the authority; `/` would end it; `#`/`?`
    // would start fragment/query. None of these appear in a legitimate DNS
    // label or IPv6 literal, so rejecting is safer than encoding (which
    // would still let a spoofed host reach the URL parser under a
    // percent-encoded disguise the receiving app might decode back).
    expect(() => buildXftpUrl(passwordServer({ host: 'evil.example/bad' }), '/x'))
      .toThrow(/host contains characters unsafe/);
    expect(() => buildXftpUrl(passwordServer({ host: 'a@b' }), '/x'))
      .toThrow(/host contains characters unsafe/);
    expect(() => buildXftpUrl(passwordServer({ host: 'a b' }), '/x'))
      .toThrow(/host contains characters unsafe/);
  });

  test('accepts an IPv6 literal wrapped in brackets', () => {
    // The URL authority form for IPv6 is `[::1]` — brackets and colons are
    // required, so our host validator explicitly allows them.
    const url = buildXftpUrl(passwordServer({ host: '[::1]' }), '/x');
    expect(url).toBe('sftp://alice@[::1]:22/x');
  });

  test('inlines the password as userinfo when the server has one — XFTP skips its prompt', () => {
    // The whole point of doing this in a URL is to skip XFTP's password
    // dialog. `user:password@` is the RFC 3986 userinfo shape.
    const url = buildXftpUrl(passwordServer({ auth: { method: 'password', password: 'secret' } }), '/x');
    expect(url).toBe('sftp://alice:secret@192.0.2.10:22/x');
  });

  test('percent-encodes passwords with @ / : / # so the URL structure survives', () => {
    // Real-world passwords are full of RFC 3986 reserved chars. Every one of
    // these would either misparse the authority or amputate the path if left
    // raw — encodeURIComponent catches them all.
    const url = buildXftpUrl(
      passwordServer({ auth: { method: 'password', password: 'p@ss:w/rd#!' } }),
      '/x',
    );
    expect(url).toBe('sftp://alice:p%40ss%3Aw%2Frd%23!@192.0.2.10:22/x');
  });

  test('omits the password for private-key auth — XFTP will use the key agent instead', () => {
    const url = buildXftpUrl(keyServer('/home/me/.ssh/id_ed25519'), '/x');
    expect(url).toBe('sftp://alice@192.0.2.10:22/x');
  });

  test('omits the password when password auth is declared but the password field is empty', () => {
    // Falls back to the no-userinfo-password shape rather than emitting
    // `user:@host` which some URL parsers reject.
    const url = buildXftpUrl(passwordServer({ auth: { method: 'password', password: '' } }), '/x');
    expect(url).toBe('sftp://alice@192.0.2.10:22/x');
  });
});
