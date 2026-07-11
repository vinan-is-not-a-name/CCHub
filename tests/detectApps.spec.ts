import { test, expect } from '@playwright/test';
import { detectAppPath, detectApps, type DetectDeps } from '../src/server/infrastructure/shell/detectApps.js';

// detectAppPath and detectApps are the two exposed functions that the
// Settings dialog's Detect button eventually reaches. We test them with a
// fake DetectDeps so specs don't spawn `where` or read the real filesystem —
// the interesting logic is the fallback order (PATH → Program Files roots),
// not the child_process integration.

function fakeDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  return {
    where: overrides.where ?? (async () => null),
    readdir: overrides.readdir ?? (() => []),
    exists: overrides.exists ?? (() => false),
  };
}

test.describe('detectAppPath', () => {
  test('uses `where` when it returns a path that exists on disk', async () => {
    const result = await detectAppPath('xshell', fakeDeps({
      where: async (exe) => {
        expect(exe).toBe('Xshell.exe'); // maps 'xshell' to the exe name
        return 'C:\\PATH\\Xshell.exe';
      },
      exists: (p) => p === 'C:\\PATH\\Xshell.exe',
    }));
    expect(result).toBe('C:\\PATH\\Xshell.exe');
  });

  test('ignores a `where` hit whose file no longer exists', async () => {
    // Users can delete an exe without cleaning PATH; the guard prevents us
    // handing back a phantom path that would spawn ENOENT later.
    const result = await detectAppPath('xshell', fakeDeps({
      where: async () => 'C:\\stale\\Xshell.exe',
      exists: () => false,
    }));
    expect(result).toBeNull();
  });

  test('falls back to Program Files\\NetSarang scan when `where` returns null', async () => {
    if (process.platform !== 'win32') return;
    // Default install: NetSarang\Xshell 8\Xshell.exe under Program Files.
    // The scan globs the version-suffixed directory so 7 / 8 / 9 all match.
    const result = await detectAppPath('xshell', fakeDeps({
      where: async () => null,
      readdir: (dir) => dir === 'C:\\Program Files\\NetSarang' ? ['Xshell 8', 'Xftp 8'] : [],
      exists: (p) => p === 'C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe',
    }));
    expect(result).toBe('C:\\Program Files\\NetSarang\\Xshell 8\\Xshell.exe');
  });

  test('also checks Program Files (x86)\\NetSarang', async () => {
    if (process.platform !== 'win32') return;
    // 32-bit NetSarang on 64-bit Windows lands under (x86). Same scan pattern.
    const result = await detectAppPath('xftp', fakeDeps({
      readdir: (dir) => dir === 'C:\\Program Files (x86)\\NetSarang' ? ['Xftp 7'] : [],
      exists: (p) => p === 'C:\\Program Files (x86)\\NetSarang\\Xftp 7\\Xftp.exe',
    }));
    expect(result).toBe('C:\\Program Files (x86)\\NetSarang\\Xftp 7\\Xftp.exe');
  });

  test('is case-insensitive on the directory prefix — Xshell / xshell / XSHELL all match', async () => {
    if (process.platform !== 'win32') return;
    // NetSarang keeps title-case, but drive imaging + rename tools sometimes
    // lower-case directories; matching case-insensitively means those users
    // aren't stuck on manual paths.
    const result = await detectAppPath('xshell', fakeDeps({
      readdir: () => ['xshell 8'], // lower-case on disk
      exists: (p) => p.endsWith('xshell 8\\Xshell.exe'),
    }));
    expect(result).not.toBeNull();
  });

  test('returns null when neither PATH nor Program Files has the exe', async () => {
    const result = await detectAppPath('xshell', fakeDeps());
    expect(result).toBeNull();
  });

  test('never returns a Xftp match when looking for Xshell', async () => {
    // The prefix filter has to stop Xshell from resolving to Xftp\Xftp.exe
    // (or the paired reverse) — otherwise Xshell path in the config would
    // point at the wrong exe.
    const result = await detectAppPath('xshell', fakeDeps({
      readdir: (dir) => dir === 'C:\\Program Files\\NetSarang' ? ['Xftp 8'] : [],
      exists: () => true,
    }));
    expect(result).toBeNull();
  });
});

test.describe('detectApps', () => {
  test('returns all three paths in one shot', async () => {
    const result = await detectApps(fakeDeps({
      where: async (exe) => {
        if (exe === 'Xshell.exe') return 'C:\\a\\Xshell.exe';
        if (exe === 'Xftp.exe') return 'C:\\b\\Xftp.exe';
        // The VS Code detector looks up either `code.cmd` on Windows or
        // `code` elsewhere. On the CI host running the specs the platform
        // varies, so accept either — what we're asserting is the shape.
        if (exe === 'code.cmd' || exe === 'code') return 'C:\\c\\code.cmd';
        return null;
      },
      exists: () => true,
    }));
    expect(result).toEqual({
      xshellPath: 'C:\\a\\Xshell.exe',
      xftpPath: 'C:\\b\\Xftp.exe',
      vscodePath: 'C:\\c\\code.cmd',
    });
  });

  test('returns null for the ones it couldn\'t find, path for the ones it did', async () => {
    // The Settings dialog uses this shape to render a per-app status message
    // — any mix of found/not-found is a supported outcome.
    const result = await detectApps(fakeDeps({
      where: async (exe) => exe === 'Xshell.exe' ? 'C:\\a\\Xshell.exe' : null,
      // Only the xshell PATH result exists; every Program Files / AppData
      // candidate the vscode fallback probes reports missing so the vscode
      // path resolves to null (this is the "one found, others missing" case
      // the Settings dialog surfaces via the partial-detected message).
      exists: (p) => p === 'C:\\a\\Xshell.exe',
    }));
    expect(result.xshellPath).toBe('C:\\a\\Xshell.exe');
    expect(result.xftpPath).toBeNull();
    expect(result.vscodePath).toBeNull();
  });
});

// VS Code lives outside NetSarang and its install layout differs
// (Program Files\Microsoft VS Code\bin\code.cmd, plus a per-user
// AppData\Local\Programs mirror). detectAppPath('vscode') must consult
// those roots instead of the NetSarang scan.
test.describe('detectAppPath — vscode', () => {
  test('prefers a PATH hit (installers add code.cmd to PATH by default)', async () => {
    const result = await detectAppPath('vscode', fakeDeps({
      where: async (exe) => {
        // Windows spec sees code.cmd, Linux/mac sees code.
        expect(['code.cmd', 'code']).toContain(exe);
        return 'C:\\PATH\\code.cmd';
      },
      exists: (p) => p === 'C:\\PATH\\code.cmd',
    }));
    expect(result).toBe('C:\\PATH\\code.cmd');
  });

  test('falls back to Program Files\\Microsoft VS Code\\bin\\code.cmd when PATH misses', async () => {
    if (process.platform !== 'win32') return;
    const result = await detectAppPath('vscode', fakeDeps({
      exists: (p) => p === 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
    }));
    expect(result).toBe('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd');
  });

  test('also checks the per-user AppData\\Local\\Programs install location', async () => {
    if (process.platform !== 'win32') return;
    // The "Install for current user" installer lands VS Code under
    // %LOCALAPPDATA%\Programs\Microsoft VS Code — no admin rights needed
    // during install, which is the more common flow at BYOD shops.
    const result = await detectAppPath('vscode', fakeDeps({
      exists: (p) => p.includes('AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'),
    }));
    expect(result).not.toBeNull();
    expect(result!.endsWith('AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd')).toBe(true);
  });

  test('returns null when neither PATH nor any known install root has code', async () => {
    const result = await detectAppPath('vscode', fakeDeps());
    expect(result).toBeNull();
  });
});
