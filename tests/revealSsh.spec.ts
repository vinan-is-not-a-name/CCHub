import { test, expect } from '@playwright/test';
import { buildXshellSessionFile, buildXftpUrl } from '../src/server/infrastructure/shell/revealSsh.js';
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
    const body = buildXshellSessionFile(passwordServer(), '/home/alice/my-project', false);
    expect(body).toContain('[CONNECTION]');
    expect(body).toContain('Protocol=SSH');
    expect(body).toContain('Host=192.0.2.10');
    expect(body).toContain('Port=22');
  });

  test('routes auto-cwd through [CONNECTION:SSH] RemoteCommand (not InitRemoteDirectory)', () => {
    // InitRemoteDirectory is a SFTP/FTP-only field and does nothing on SSH
    // sessions. Auto-cwd must go through RemoteCommand — and this must hold on
    // BOTH auth paths, since RemoteCommand is the whole point of auto-cd.
    for (const certInstalled of [false, true]) {
      const body = buildXshellSessionFile(passwordServer(), '/home/alice/my-project', certInstalled);
      expect(body).toContain('[CONNECTION:SSH]');
      expect(body).toContain(`RemoteCommand=cd '/home/alice/my-project' && exec $SHELL -l`);
      expect(body).not.toMatch(/^InitRemoteDirectory=/m);
    }
  });

  test('escapes single quotes in cwd so an adversarial path cannot break out of the quoted string', () => {
    // POSIX-safe: close, escape, reopen. `it's` becomes `it'\''s`.
    const body = buildXshellSessionFile(passwordServer(), `/tmp/it's a dir`, false);
    expect(body).toContain(`RemoteCommand=cd '/tmp/it'\\''s a dir' && exec $SHELL -l`);
  });

  test('never inlines a credential — Password / Passphrase stay empty on both paths', () => {
    // Auto-feeding a password (Password= or a -url override) makes XShell skip
    // RemoteCommand, which breaks auto-cd. So the file must never carry one,
    // regardless of auth path.
    for (const certInstalled of [false, true]) {
      const body = buildXshellSessionFile(passwordServer(), '/tmp', certInstalled);
      expect(body).toContain('UserName=alice');
      expect(body).toMatch(/^Password=$/m);
      expect(body).toMatch(/^Passphrase=$/m);
    }
  });

  test('cert-installed path enables ONLY the public-key method and points UserKey at the cchub key', () => {
    // AuthMethodList=00,11,20,30 (pubkey method = code 11) sampled from a real
    // GUI-built key session; UserKey takes the XShell key-store BASENAME, not a
    // disk path (a disk path is silently ignored → password prompt).
    const body = buildXshellSessionFile(passwordServer(), '/tmp', true);
    expect(body).toContain('UserKey=cchub_ed25519');
    expect(body).toContain('AuthMethodList=00,11,20,30');
  });

  test('not-installed path leaves UserKey empty and enables the interactive password method', () => {
    // No key to rely on → XShell prompts for a password once; because nothing
    // is auto-fed, RemoteCommand still runs after login so auto-cd works.
    const body = buildXshellSessionFile(passwordServer(), '/tmp', false);
    expect(body).toMatch(/^UserKey=$/m);
    expect(body).toContain('AuthMethodList=01,10,20,30');
  });

  test('auth path is independent of the stored auth.method (the .xsh does not read config auth)', () => {
    // A server whose config uses key auth still gets the password .xsh when the
    // cchub key isn't installed, and a password-auth server gets the pubkey
    // .xsh when it is. The switch is the runtime cert probe, not auth.method —
    // this is the whole "install pubkey only, don't change config" contract.
    expect(buildXshellSessionFile(keyServer(), '/tmp', false)).toContain('AuthMethodList=01,10,20,30');
    expect(buildXshellSessionFile(keyServer(), '/tmp', false)).toMatch(/^UserKey=$/m);
    expect(buildXshellSessionFile(passwordServer(), '/tmp', true)).toContain('UserKey=cchub_ed25519');
  });

  test('uses CRLF line endings (XShell is a Windows-native app)', () => {
    const body = buildXshellSessionFile(passwordServer(), '/tmp', false);
    expect(body.includes('\r\n')).toBe(true);
  });

  test('rejects host / username / cwd containing CR or LF (INI injection guard)', () => {
    // Newlines in any of these would let a spoofed value splice a new
    // [SECTION] header or overwrite a real field like `AuthMethodList=` in
    // the emitted INI body. Legitimate SSH inputs never contain these, so
    // rejecting is safe.
    expect(() => buildXshellSessionFile(passwordServer({ host: '192.0.2.10\n[Nefarious]' }), '/tmp', false))
      .toThrow(/host contains characters unsafe/);
    expect(() => buildXshellSessionFile(passwordServer({ username: 'alice\nAuthMethodList=00' }), '/tmp', false))
      .toThrow(/username contains characters unsafe/);
    expect(() => buildXshellSessionFile(passwordServer(), '/tmp\r\n[Nefarious]', false))
      .toThrow(/cwd contains characters unsafe/);
  });

  test('rejects a NUL in any INI-embedded field', () => {
    // Same class as the newline case — parsers on the receiving end (XShell
    // and the file writer) each handle NUL differently and letting one
    // through invites TOCTOU quirks.
    expect(() => buildXshellSessionFile(passwordServer({ host: '192.0.2.10\x00' }), '/tmp', false))
      .toThrow(/host contains characters unsafe/);
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
