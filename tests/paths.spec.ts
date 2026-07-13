import { test, expect } from '@playwright/test';
import {
  LOCAL_DRIVES_PATH,
  LOCAL_DRIVES_DISPLAY,
  splitLocalPath,
  splitRemotePath,
  parentLocalDirectory,
  parentRemoteDirectory,
  displayDirectoryPath,
  resolveDirectoryInput,
  joinRemotePath,
  isValidFolderName,
} from '../src/shared/paths.js';

// Pure path protocol shared by client and server — directory-browse core. These
// lock the cross-platform split/parent contracts (Windows drive roots, the
// "This PC" sentinel, POSIX roots) so a harmless refactor that breaks an edge
// case is caught here instead of in the (expensive, indirect) e2e browse flow.

test.describe('splitLocalPath', () => {
  const cases: Array<[string, { parent: string; filter: string }]> = [
    ['C:\\', { parent: 'C:\\', filter: '' }],
    ['C:', { parent: 'C:\\', filter: '' }],          // bare drive normalizes to root
    ['C:\\Users\\fo', { parent: 'C:\\Users', filter: 'fo' }],
    ['C:\\file', { parent: 'C:\\', filter: 'file' }], // directly under the drive root
    ['D:\\proj\\', { parent: 'D:\\proj\\', filter: '' }], // trailing sep → no filter
    ['C:/Users/fo', { parent: 'C:/Users', filter: 'fo' }], // forward slashes accepted
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(splitLocalPath(input)).toEqual(expected);
    });
  }

  test('bare name falls back to the provided fallbackParent', () => {
    expect(splitLocalPath('foo')).toEqual({ parent: '', filter: 'foo' });
    expect(splitLocalPath('foo', 'C:\\base')).toEqual({ parent: 'C:\\base', filter: 'foo' });
  });

  test('empty input yields the fallbackParent and empty filter', () => {
    expect(splitLocalPath('', 'C:\\base')).toEqual({ parent: 'C:\\base', filter: '' });
  });
});

test.describe('splitRemotePath', () => {
  const cases: Array<[string, { parent: string; filter: string }]> = [
    ['/', { parent: '/', filter: '' }],
    ['/home/u', { parent: '/home', filter: 'u' }],
    ['/home/', { parent: '/home', filter: '' }],   // trailing slash trimmed off parent
    ['/file', { parent: '/', filter: 'file' }],     // directly under root
    ['relative', { parent: '.', filter: 'relative' }], // no slash → cwd-relative
    ['', { parent: '/', filter: '' }],              // empty normalizes to root
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(splitRemotePath(input)).toEqual(expected);
    });
  }
});

test.describe('parentLocalDirectory', () => {
  const cases: Array<[string, string]> = [
    [LOCAL_DRIVES_PATH, LOCAL_DRIVES_PATH],     // This PC is its own parent
    [LOCAL_DRIVES_DISPLAY, LOCAL_DRIVES_PATH],  // friendly label resolves to sentinel
    ['C:\\', LOCAL_DRIVES_PATH],                // drive root → This PC
    ['C:', LOCAL_DRIVES_PATH],
    ['C:\\a', 'C:\\'],                          // one level under root → root
    ['C:\\a\\b', 'C:\\a'],
    ['C:/a/b', 'C:/a'],                         // forward slashes accepted
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(parentLocalDirectory(input)).toBe(expected);
    });
  }
});

test.describe('parentRemoteDirectory', () => {
  const cases: Array<[string, string]> = [
    ['/', '/'],          // root is its own parent
    ['/a', '/'],
    ['/a/b', '/a'],
    ['/a/b/', '/a'],     // trailing slash ignored
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(parentRemoteDirectory(input)).toBe(expected);
    });
  }
});

test.describe('joinRemotePath', () => {
  const cases: Array<[string, string, string]> = [
    ['/home/u', 'proj', '/home/u/proj'],
    ['/home/u/', 'proj', '/home/u/proj'],  // trailing slash collapsed
    ['/', 'proj', '/proj'],                 // root parent
    ['', 'proj', '/proj'],                  // empty parent → rooted
    ['/a//', 'b', '/a/b'],                  // multiple trailing slashes collapsed
  ];
  for (const [parent, name, expected] of cases) {
    test(`(${JSON.stringify(parent)}, ${JSON.stringify(name)}) → ${JSON.stringify(expected)}`, () => {
      expect(joinRemotePath(parent, name)).toBe(expected);
    });
  }
});

// Validation is OS-aware: POSIX (linux/macos) is near-permissive, Windows is
// strict. The two suites lock the divergence so a name legal on Linux isn't
// wrongly rejected for an SSH target, and Windows-hostile names (reserved
// chars, device names, trailing dots) can't reach a local mkdir.

test.describe('isValidFolderName — posix', () => {
  // Everything but `/` and NUL is a legal POSIX segment — including the chars
  // and device-name words Windows reserves, and trailing/leading dots.
  const legal = [
    'proj', 'my folder', 'a-b_c', 'v1.2', '2026', '.hidden', 'a.b.c', '  spaced-out  ',
    'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\\b', // Windows-illegal chars, fine here
    'con', 'nul', 'com1', 'lpt3',                             // Windows device names, ordinary here
    'foo.', 'a..', '...',                                     // trailing dots are legal on POSIX
  ];
  for (const name of legal) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(isValidFolderName(name, 'posix')).toBe(true);
    });
  }

  // Only blank, the nav aliases, the `/` separator and the NUL byte are illegal.
  const illegal = ['', '   ', '.', '..', 'a/b', 'a\x00b'];
  for (const name of illegal) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(isValidFolderName(name, 'posix')).toBe(false);
    });
  }
});

test.describe('isValidFolderName — windows', () => {
  // Legal names — the regression guard: spaces, dashes, digits and mid-name
  // dots must all pass (an earlier ` -<` range bug rejected every one of these).
  // The last four are near-misses that must NOT trip the reserved-name rule.
  const legal = [
    'proj', 'my folder', 'a-b_c', 'v1.2', '2026', '.hidden', 'a.b.c', '  spaced-out  ',
    'console', 'com0', 'com10', 'null',
  ];
  for (const name of legal) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(isValidFolderName(name, 'windows')).toBe(true);
    });
  }

  // Illegal — blank, nav aliases, path separators, reserved chars, control
  // chars, reserved device names (bare/with extension/any case), and a trailing
  // dot Windows would silently strip.
  const illegal = [
    '', '   ', '.', '..',
    'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\tb', 'a\nb',
    'CON', 'con', 'nul', 'NUL', 'aux', 'prn', 'com1', 'LPT3', 'con.txt',
    'foo.', 'a..',
  ];
  for (const name of illegal) {
    test(`rejects ${JSON.stringify(name)}`, () => {
      expect(isValidFolderName(name, 'windows')).toBe(false);
    });
  }
});

test.describe('display ↔ resolve round-trip', () => {
  test('displayDirectoryPath maps the sentinel to the friendly label, passes others through', () => {
    expect(displayDirectoryPath(LOCAL_DRIVES_PATH)).toBe(LOCAL_DRIVES_DISPLAY);
    expect(displayDirectoryPath('C:\\Users')).toBe('C:\\Users');
  });

  test('resolveDirectoryInput is the inverse mapping', () => {
    expect(resolveDirectoryInput(LOCAL_DRIVES_DISPLAY)).toBe(LOCAL_DRIVES_PATH);
    expect(resolveDirectoryInput('C:\\Users')).toBe('C:\\Users');
  });

  test('round-trips the sentinel both directions', () => {
    expect(resolveDirectoryInput(displayDirectoryPath(LOCAL_DRIVES_PATH))).toBe(LOCAL_DRIVES_PATH);
    expect(displayDirectoryPath(resolveDirectoryInput(LOCAL_DRIVES_DISPLAY))).toBe(LOCAL_DRIVES_DISPLAY);
  });
});
