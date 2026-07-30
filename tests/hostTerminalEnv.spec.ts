import { test, expect } from '@playwright/test';
import {
  normalizeTerminalEnv,
  HOST_TERMINAL_ENV_KEYS,
  HOST_TERM,
} from '../src/shared/envKeys.js';

/** cc's terminal-id allowlist (claude 2.1.220). An id in this set makes cc push
 * the kitty keyboard protocol + modifyOtherKeys, which xterm.js implements
 * neither of. Mirrored here so the test states what the strip is protecting
 * against rather than just re-listing the keys the implementation removes. */
const CC_KITTY_TERMINALS = [
  'iTerm.app', 'kitty', 'WezTerm', 'ghostty', 'tmux', 'windows-terminal', 'WarpTerminal',
];

/** cc's detector, transcribed from claude 2.1.220 in its original order. Given
 * an env it returns the terminal id cc would compute — the value it feeds to
 * the allowlist above. Only the branches reachable from env are modelled. */
function ccTerminalId(env: Record<string, string>): string | null {
  if (env.CURSOR_TRACE_ID) return 'cursor';
  const askpass = env.VSCODE_GIT_ASKPASS_MAIN?.toLowerCase() ?? '';
  if (askpass.includes('cursor')) return 'cursor';
  const bundle = env.__CFBundleIdentifier?.toLowerCase();
  if (bundle?.includes('vscodium')) return 'codium';
  if (env.VisualStudioVersion) return 'visualstudio';
  if (env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'pycharm';
  if (env.TERM === 'xterm-ghostty') return 'ghostty';
  if (env.TERM?.includes('kitty')) return 'kitty';
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  if (env.TMUX) return 'tmux';
  if (env.STY) return 'screen';
  if (env.KONSOLE_VERSION) return 'konsole';
  if (env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal';
  if (env.XTERM_VERSION) return 'xterm';
  if (env.VTE_VERSION) return 'vte-based';
  if (env.TERMINATOR_UUID) return 'terminator';
  if (env.KITTY_WINDOW_ID) return 'kitty';
  if (env.ALACRITTY_LOG) return 'alacritty';
  if (env.TILIX_ID) return 'tilix';
  if (env.WT_SESSION) return 'windows-terminal';
  if (env.MSYSTEM) return env.MSYSTEM.toLowerCase();
  if (env.ConEmuANSI || env.ConEmuPID || env.ConEmuTask) return 'conemu';
  if (env.WSL_DISTRO_NAME) return `wsl-${env.WSL_DISTRO_NAME}`;
  if (env.TERM) return env.TERM;
  return null;
}

test.describe('normalizeTerminalEnv', () => {
  test('keeps the launch env intact apart from terminal identity', () => {
    const out = normalizeTerminalEnv({
      PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'sk-x', HTTP_PROXY: 'http://127.0.0.1:1',
      CLAUDE_CODE_EFFORT_LEVEL: 'high', WT_SESSION: 'guid',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.ANTHROPIC_AUTH_TOKEN).toBe('sk-x');
    expect(out.HTTP_PROXY).toBe('http://127.0.0.1:1');
    expect(out.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  test('does not mutate its input', () => {
    const input = { WT_SESSION: 'guid', TERM: 'dumb' };
    normalizeTerminalEnv(input);
    expect(input).toEqual({ WT_SESSION: 'guid', TERM: 'dumb' });
  });

  test('drops the whole ConEmu family, not just the three cc reads', () => {
    const out = normalizeTerminalEnv({
      ConEmuANSI: 'OFF', ConEmuPID: '1', ConEmuTask: '{cmd}', ConEmuBuild: '230724',
      ConEmuPalette: '<Solarized Light>',
    });
    expect(Object.keys(out).filter((k) => /^ConEmu/i.test(k))).toEqual([]);
  });

  test('pins TERM so cc lands on a deterministic id', () => {
    expect(normalizeTerminalEnv({}).TERM).toBe(HOST_TERM);
    expect(normalizeTerminalEnv({ TERM: 'xterm-kitty' }).TERM).toBe(HOST_TERM);
  });

  // The point of the strip: whatever terminal launched the server, cc must not
  // come out holding an id that turns on a protocol xterm.js cannot speak.
  const HOSTS: Array<[string, Record<string, string>]> = [
    ['Windows Terminal', { WT_SESSION: '177a1758-8055-413f-9e64-3d41ccfc1f21', WT_PROFILE_ID: '{guid}' }],
    ['Cmder / ConEmu', { ConEmuANSI: 'OFF', ConEmuPID: '16180', ConEmuTask: '{cmd::Cmder}', TERM: 'xterm-256color' }],
    ['VS Code', { TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.90.0' }],
    ['kitty', { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }],
    ['WezTerm', { TERM_PROGRAM: 'WezTerm' }],
    ['ghostty', { TERM: 'xterm-ghostty' }],
    ['tmux', { TMUX: '/tmp/tmux-1000/default,123,0' }],
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' }],
    ['Warp', { TERM_PROGRAM: 'WarpTerminal' }],
    ['MSYS2', { MSYSTEM: 'MINGW64' }],
    ['bare cmd.exe', {}],
  ];

  for (const [name, hostEnv] of HOSTS) {
    test(`${name}: cc sees ${HOST_TERM}, not a kitty-allowlisted terminal`, () => {
      const out = normalizeTerminalEnv({ PATH: '/usr/bin', ...hostEnv });
      const id = ccTerminalId(out);
      expect(id).toBe(HOST_TERM);
      expect(CC_KITTY_TERMINALS).not.toContain(id);
    });
  }

  test('detects the pre-fix leak, so these cases are known-different', () => {
    // Guards the test above from passing vacuously: without the strip, the two
    // hosts whose streams were actually captured do resolve to different ids.
    expect(ccTerminalId({ WT_SESSION: 'guid' })).toBe('windows-terminal');
    expect(CC_KITTY_TERMINALS).toContain('windows-terminal');
    expect(ccTerminalId({ ConEmuPID: '1', TERM: 'xterm-256color' })).toBe('conemu');
    expect(CC_KITTY_TERMINALS).not.toContain('conemu');
  });

  test('strips every key it claims to', () => {
    const env = Object.fromEntries(HOST_TERMINAL_ENV_KEYS.map((k) => [k, 'x']));
    const out = normalizeTerminalEnv({ ...env, PATH: '/usr/bin' });
    for (const key of HOST_TERMINAL_ENV_KEYS) expect(out[key]).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });
});
