import { test, expect } from '@playwright/test';
import { selectRevealCommand } from '../src/server/infrastructure/shell/revealPath.js';

// selectRevealCommand is the pure argv-picker for the OS file-browser reveal
// side-effect. The spawn wrapper around it is a fire-and-forget process launch
// with no assertable behavior beyond "we asked the right helper" — testing
// that helper choice here is the whole point of splitting it out.

test.describe('selectRevealCommand', () => {
  const path = 'D:\\codebase\\cchub';

  test('Windows uses explorer.exe with the path as a single argv element', () => {
    const cmd = selectRevealCommand('win32', path);
    expect(cmd.file).toBe('explorer.exe');
    // Path stays a single argv element so spaces / `&` / quotes travel through
    // without shell interpolation.
    expect(cmd.args).toEqual([path]);
  });

  test('macOS uses open', () => {
    const cmd = selectRevealCommand('darwin', '/Users/me/repo');
    expect(cmd.file).toBe('open');
    expect(cmd.args).toEqual(['/Users/me/repo']);
  });

  test('Linux and other Unixes use xdg-open', () => {
    expect(selectRevealCommand('linux', '/home/me/repo').file).toBe('xdg-open');
    expect(selectRevealCommand('freebsd', '/home/me/repo').file).toBe('xdg-open');
  });
});
