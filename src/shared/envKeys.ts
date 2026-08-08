/**
 * Single source of truth for the profile form-field ↔ Anthropic env-key relation.
 * Adding a new forwarded env var means adding one line here; the env-key list,
 * the key union, and the field→env conversion all derive from this map. Keep this
 * module dependency-free so `domain.ts` can import the key type without a cycle.
 */
export const PROFILE_FIELD_TO_ENV = {
  baseUrl: 'ANTHROPIC_BASE_URL',
  authToken: 'ANTHROPIC_AUTH_TOKEN',
  model: 'ANTHROPIC_MODEL',
  subagentModel: 'CLAUDE_CODE_SUBAGENT_MODEL',
  smallFastModel: 'ANTHROPIC_SMALL_FAST_MODEL',
} as const;

export type ProfileEnvField = keyof typeof PROFILE_FIELD_TO_ENV;
export type AnthropicEnvKey = typeof PROFILE_FIELD_TO_ENV[ProfileEnvField];

/** Anthropic env keys forwarded to the launched CLI. Derived from PROFILE_FIELD_TO_ENV. */
export const ANTHROPIC_ENV_KEYS = Object.values(PROFILE_FIELD_TO_ENV) as readonly AnthropicEnvKey[];

/** Standard proxy env vars, both cases — set when a preset's SSH reverse tunnel
 * is active so the remote claude routes through `127.0.0.1:<bindPort>`. Lowercase
 * variants included because some tools (curl, git) read those specifically. */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const;

/** CC runtime session controls carried in the session env. Effort (/effort) is
 * applied by setting CLAUDE_CODE_EFFORT_LEVEL; it must be forwarded like the
 * Anthropic vars or remote/SSH sessions silently drop it (local works only
 * because node-pty inherits the full, unfiltered env). */
export const CC_RUNTIME_ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const;

/** Every env key the shell adapters export into the launch command and that
 * remoteEnv forwards over SSH: Anthropic profile vars + proxy vars + CC runtime
 * controls. One list so adding a forwarded var is a single edit and both code
 * paths stay in sync. */
export const FORWARDED_ENV_KEYS = [...ANTHROPIC_ENV_KEYS, ...PROXY_ENV_KEYS, ...CC_RUNTIME_ENV_KEYS] as readonly string[];

/** Env vars that identify the *host* terminal to the launched CLI, in the order
 * cc's detector reads them. cc derives a terminal id from these at startup and
 * gates protocol choices on it: an id in its allowlist ("windows-terminal",
 * "kitty", "WezTerm", "ghostty", "tmux", "iTerm.app", "WarpTerminal") makes it
 * push the kitty keyboard protocol (CSI >1u) + modifyOtherKeys (CSI >4;2m) and
 * wrap frames in synchronized output (CSI ?2026h).
 *
 * For a local PTY these leak in from whatever terminal ran `npm start`, but the
 * thing rendering the bytes is xterm.js in the browser — which implements
 * neither kitty keyboard nor modifyOtherKeys, so cc encodes keys one way and
 * the client sends them another. Measured on one machine, same cc 2.1.220 and
 * same bundled ConPTY: injecting only WT_SESSION reproduced a
 * Windows-Terminal-launched host's stream byte-for-byte (kitty push + ?2026
 * appear, OSC 9;4 disappears). Stripping these pins the detector to its bare
 * TERM branch, and HOST_TERM below keeps that branch deterministic.
 *
 * SSH needs no equivalent: buildRemoteEnv forwards FORWARDED_ENV_KEYS only and
 * the pty request already sets term explicitly. */
export const HOST_TERMINAL_ENV_KEYS = [
  'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier',
  'VisualStudioVersion', 'TERMINAL_EMULATOR', 'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION', 'TMUX', 'STY', 'KONSOLE_VERSION',
  'GNOME_TERMINAL_SERVICE', 'XTERM_VERSION', 'VTE_VERSION', 'TERMINATOR_UUID',
  'KITTY_WINDOW_ID', 'ALACRITTY_LOG', 'TILIX_ID', 'WT_SESSION',
  'WT_PROFILE_ID', 'MSYSTEM', 'WSL_DISTRO_NAME',
] as const;

/** Host-terminal families matched by prefix. ConEmu/Cmder exports ~20 ConEmu*
 * vars; cc keys off ConEmuANSI/ConEmuPID/ConEmuTask for both its terminal id
 * and its taskbar-progress probe (the OSC 9;4 that only a ConEmu-launched host
 * emits), so the whole family goes. */
export const HOST_TERMINAL_ENV_PREFIXES = [/^ConEmu/i] as const;

/** What the local PTY claims to be. Matches the term the SSH pty request
 * already sends, so both transports present one terminal identity to cc. */
export const HOST_TERM = 'xterm-256color';

/** Replace the host terminal's identity in a launch env with xterm.js's.
 * Returns a new object; the input is not mutated. */
export function normalizeTerminalEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set<string>(HOST_TERMINAL_ENV_KEYS);
  for (const [key, value] of Object.entries(env)) {
    if (drop.has(key)) continue;
    if (HOST_TERMINAL_ENV_PREFIXES.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  out.TERM = HOST_TERM;
  return out;
}

/** Map flat profile form fields onto their env keys, dropping empty values. */
export function profileFieldsToEnv(
  fields: Partial<Record<ProfileEnvField, string | undefined>>,
): Partial<Record<AnthropicEnvKey, string>> {
  const env: Partial<Record<AnthropicEnvKey, string>> = {};
  for (const field of Object.keys(PROFILE_FIELD_TO_ENV) as ProfileEnvField[]) {
    const value = fields[field];
    if (value) env[PROFILE_FIELD_TO_ENV[field]] = value;
  }
  return env;
}
