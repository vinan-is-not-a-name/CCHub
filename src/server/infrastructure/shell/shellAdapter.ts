import { ResolvedLaunch, FORWARDED_ENV_KEYS, ServerOs } from '../../../shared/protocol.js';
import { condaBinPath, condaProfileScripts, bashProfileSourceSnippet, winCondaPathPrepend } from '../discovery/condaPaths.js';
import { shellQuote } from '../../utils/shellEscape.js';

/** A resolved launch plus the fully-built CLI command (argv incl. program name). ShellAdapter consumes this. */
export interface EffectiveLaunch extends ResolvedLaunch {
  command: string[];
  /** Per-session MCP config path, carried so a resume-fallback respawn rebuilds
   * the same MCP flags. Undefined when the session has no MCP grant. */
  mcpConfigPath?: string;
}

export interface ShellAdapter {
  /** Compile a launch into a single command string the shell will execute. */
  compile(launch: EffectiveLaunch): string;
  /**
   * Executable + arguments to feed the compiled command to the shell.
   *
   * The args can be either an argv array (POSIX-friendly: each element is a
   * distinct argument) or a single pre-built command-line string (Windows-
   * friendly: bypasses node-pty's MSVC-style argv→cmdline rewriter, which
   * escapes embedded `"` as `\"` — a form cmd.exe does not understand).
   *
   * BashAdapter uses the array form so node-pty quotes spaces in
   * `bash -lc <script>` correctly; CmdAdapter uses the string form so its
   * `set "KEY=val"` and `"<env name>"` quoting survives.
   */
  spawnArgs(command: string): { file: string; args: string[] | string };
}

/** Windows cmd.exe — uses `set` and `&&` chaining. cwd is set by the connector, no `cd` needed.
 * Env values use the `set "KEY=value"` form (whole assignment quoted) so cmd strips the outer
 * quotes — the value stays clean while `&`, `|`, `>` inside it stay literal and can't break the
 * `&&` chain. The conda name and spaced argv parts use `"value"` quoting. */
export const CmdAdapter: ShellAdapter = {
  compile(launch: EffectiveLaunch): string {
    const cmdQuote = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // Only quote argv parts that actually need it (whitespace or a cmd.exe
    // metacharacter): bare flags like `-c` stay readable, but a `--mcp-config`
    // path containing spaces no longer splits and breaks the `&&` chain.
    const quoteArg = (v: string) => (/[\s&|<>^()"]/.test(v) ? cmdQuote(v) : v);
    // `set "KEY=value"` not `set KEY="value"`: the latter is a cmd.exe trap that
    // keeps the quotes as part of the value, so a base URL came out as
    // `"https://host"` and the CLI built an unparseable `"https://host"/v1/...`.
    const envParts = FORWARDED_ENV_KEYS
      .filter(key => launch.env[key])
      .map(key => `set "${key}=${launch.env[key]}"`);
    const conda = launch.condaEnv ? buildCmdCondaActivate(launch.condaEnv, cmdQuote) : [];
    const cli = launch.command.map(quoteArg).join(' ');
    return [...envParts, ...conda, cli].join(' && ');
  },

  spawnArgs(command: string) {
    // Pass the whole `/c <command>` as a single string, not a `['/c', command]`
    // array. node-pty's Windows path otherwise rewrites the array into a
    // command line using MSVC's argv→cmdline rules: embedded `"` become `\"`.
    // cmd.exe does NOT recognize `\"` — inside `"..."` it expects `""` for an
    // embedded quote, otherwise the surrounding `"` get split and the inside
    // turns into bare tokens. Concretely, `"my-env"` became
    // `\"my-env\"` and conda saw the env name as the literal
    // string `\"my-env\"`, failing with EnvironmentNameNotFound.
    // Passing as a single string skips node-pty's rewriter; cmd parses our
    // already-correct cmd-style quoting (compile uses `""` for embedded `"`).
    return { file: 'cmd.exe', args: `/c ${command}` };
  },
};

/**
 * Bootstrap conda inside a `cmd.exe /c` subprocess so `conda activate` works
 * even when the parent process never ran `conda init cmd.exe`.
 *
 * Mirrors BashAdapter's `buildBashCondaActivate` in intent — make conda
 * reachable, then activate — but takes a Windows-shaped path:
 *
 *   1. Prepend every known conda installation's `condabin` and `Scripts` dirs
 *      to `%PATH%`. cmd.exe ignores PATH entries that don't exist, so a wide
 *      candidate list is cheap.
 *
 *   2. Invoke activation via `call`. `conda.bat` (the modern entry point in
 *      `condabin\`) returns control via `exit /b`, which without `call` would
 *      terminate the entire `cmd /c` chain before the CLI ever runs. With
 *      `call`, `conda.bat`'s env mutations stay applied and `&&` continues.
 *
 * Returns the activation steps as an array so the caller can fold them into
 * the same `&&`-joined chain as env exports and the CLI invocation.
 */
function buildCmdCondaActivate(condaEnv: string, cmdQuote: (v: string) => string): string[] {
  return [
    `set "PATH=${winCondaPathPrepend()};%PATH%"`,
    `call conda activate ${cmdQuote(condaEnv)}`,
  ];
}

/** POSIX bash — uses `export` and `;` chaining inside `bash -lc`. */
export const BashAdapter: ShellAdapter = {
  compile(launch: EffectiveLaunch): string {
    const envSetup = buildBashEnvExports(launch.env);
    const condaSetup = launch.condaEnv ? buildBashCondaActivate(launch.condaEnv) : '';
    const cliCommand = launch.command.map(shellQuote).join(' ');
    return `${condaSetup}${envSetup}cd ${shellQuote(launch.cwd)} && ${cliCommand}`;
  },

  spawnArgs(command: string) {
    return { file: '/bin/bash', args: ['-lc', command] };
  },
};

export function adapterFor(os: ServerOs): ShellAdapter {
  return os === 'windows' ? CmdAdapter : BashAdapter;
}

function buildBashEnvExports(env: Record<string, string>): string {
  return FORWARDED_ENV_KEYS
    .map(key => [key, env[key]] as const)
    .filter(([, v]) => v)
    .map(([key, v]) => `export ${key}=${shellQuote(v)}\n`)
    .join('');
}

function buildBashCondaActivate(condaEnv: string): string {
  const profileSourceCases = condaProfileScripts()
    .map((script) => `elif [ -r "${script}" ]; then\n  . "${script}"`)
    .join('\n');
  return `export PATH="${condaBinPath()}:$PATH"
${bashProfileSourceSnippet()}
if command -v conda >/dev/null 2>&1; then
  eval "$(conda shell.bash hook)"
${profileSourceCases}
fi
conda activate ${shellQuote(condaEnv)}
`;
}
