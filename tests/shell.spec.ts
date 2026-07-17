import { test, expect } from '@playwright/test';
import { CmdAdapter, BashAdapter, EffectiveLaunch } from '../src/server/infrastructure/shell/shellAdapter.js';
import { condaBinPath, condaProfileScripts, winCondaPathPrepend, WIN_CONDA_PREFIXES } from '../src/server/infrastructure/discovery/condaPaths.js';

function makeLaunch(overrides: Partial<EffectiveLaunch> = {}): EffectiveLaunch {
  return {
    server: { id: 's1', name: 'Local', kind: 'local', os: 'windows', createdAt: 0, updatedAt: 0 } as any,
    cwd: 'D:\\projects\\foo',
    env: {},
    command: ['claude'],
    serverName: 'Local',
    label: 'x',
    ...overrides,
  };
}

test.describe('CmdAdapter.compile', () => {
  test('basic without conda or env', () => {
    const cmd = CmdAdapter.compile(makeLaunch());
    expect(cmd).toBe('claude');
  });

  test('with resume continue', () => {
    const cmd = CmdAdapter.compile(makeLaunch({ command: ['claude', '-c'] }));
    expect(cmd).toBe('claude -c');
  });

  test('with conda env prepends every known condabin to PATH and calls activate', () => {
    const cmd = CmdAdapter.compile(makeLaunch({ condaEnv: 'myenv' }));
    // PATH bootstrap is the precondition for conda being found in a cmd /c
    // subprocess that never ran `conda init cmd.exe`. The block is built from
    // condaPaths.ts (single source of truth) — derive expectations from there
    // so adding a new prefix only touches one file.
    expect(cmd).toContain(`set "PATH=${winCondaPathPrepend()};%PATH%"`);
    for (const prefix of WIN_CONDA_PREFIXES) {
      expect(cmd).toContain(`${prefix}\\condabin`);
    }
    // `call` matters: conda.bat exits with `exit /b` which would otherwise
    // terminate the entire `cmd /c` chain before the CLI ever runs.
    expect(cmd).toContain('call conda activate "myenv"');
    // And the CLI still comes last in the chain.
    expect(cmd).toMatch(/call conda activate "myenv" && claude$/);
  });

  test('no conda block when condaEnv is unset', () => {
    const cmd = CmdAdapter.compile(makeLaunch());
    expect(cmd).not.toContain('condabin');
    expect(cmd).not.toContain('conda activate');
    expect(cmd).not.toContain('call ');
  });

  test('with anthropic env vars', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 'tok', UNRELATED: 'no' },
    }));
    expect(cmd).toContain('set "ANTHROPIC_BASE_URL=http://x"');
    expect(cmd).toContain('set "ANTHROPIC_AUTH_TOKEN=tok"');
    expect(cmd).not.toContain('UNRELATED');
  });

  test('exports proxy env vars when present', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      env: { HTTPS_PROXY: 'http://127.0.0.1:1080', NO_PROXY: 'localhost,127.0.0.1,::1' },
    }));
    expect(cmd).toContain('set "HTTPS_PROXY=http://127.0.0.1:1080"');
    expect(cmd).toContain('set "NO_PROXY=localhost,127.0.0.1,::1"');
  });

  // The `set KEY="value"` form is a cmd.exe trap: the quotes become part of the
  // value, so a base URL expanded to `"https://host"` and the CLI built an
  // unparseable `"https://host"/v1/messages`. The `set "KEY=value"` form must
  // leave the value with no surrounding quotes.
  test('env value has no surrounding quotes (the base-url parse bug)', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      env: { ANTHROPIC_BASE_URL: 'https://api.example.com' },
    }));
    expect(cmd).toContain('set "ANTHROPIC_BASE_URL=https://api.example.com"');
    expect(cmd).not.toContain('="https://api.example.com"');
  });

  test('quotes env values so shell metacharacters cannot break chaining or inject', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      env: { ANTHROPIC_BASE_URL: 'http://x && calc.exe' },
    }));
    expect(cmd).toContain('set "ANTHROPIC_BASE_URL=http://x && calc.exe"');
  });

  test('all parts combined in correct order', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      condaEnv: 'env1',
      command: ['claude', '-c'],
      env: { ANTHROPIC_BASE_URL: 'http://x' },
    }));
    // Order: env exports → PATH bootstrap → call conda activate → CLI.
    // The env exports run before the PATH set so the activation hook sees
    // them; the CLI runs after activation so it inherits the env's Python.
    expect(cmd).toMatch(/^set "ANTHROPIC_BASE_URL=http:\/\/x" && set "PATH=.+;%PATH%" && call conda activate "env1" && claude -c$/);
  });

  // A real MCP config path lands in the user's temp dir; on Windows that's
  // C:\Users\<name>\AppData\Local\Temp, which has no spaces — but a Windows
  // username can ("John Doe"), and an unquoted spaced path would split the argv
  // and break the `&&` chain. Bare flags must stay unquoted so the command is
  // still readable / matches the simple cases above.
  test('quotes only the spaced --mcp-config path, leaving bare flags untouched', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      command: ['claude', '--mcp-config', 'C:\\Users\\John Doe\\AppData\\Local\\Temp\\cchub-mcp-1.json', '--allowedTools', 'mcp__cchub__feed_image'],
    }));
    expect(cmd).toBe('claude --mcp-config "C:\\Users\\John Doe\\AppData\\Local\\Temp\\cchub-mcp-1.json" --allowedTools mcp__cchub__feed_image');
  });

  test('spawnArgs returns args as a single string (avoids node-pty MSVC quoting)', () => {
    // node-pty on Windows runs an MSVC-style argv→cmdline rewriter when given
    // an array, turning each embedded `"` into `\"` — a form cmd.exe does NOT
    // recognize. Passing the whole `/c <command>` as one string bypasses that
    // rewriter so our cmd-style `""` escaping in compile() survives intact.
    const result = CmdAdapter.spawnArgs('conda activate "envname" && claude');
    expect(result.file).toBe('cmd.exe');
    expect(typeof result.args).toBe('string');
    expect(result.args).toBe('/c conda activate "envname" && claude');
  });

  test('does not quote a space-free config path (stays readable)', () => {
    const cmd = CmdAdapter.compile(makeLaunch({
      command: ['claude', '--mcp-config', 'C:\\Temp\\cchub-mcp-1.json'],
    }));
    expect(cmd).toBe('claude --mcp-config C:\\Temp\\cchub-mcp-1.json');
  });
});

test.describe('BashAdapter.compile', () => {
  test('basic without conda or env', () => {
    const cmd = BashAdapter.compile(makeLaunch({ cwd: '/home/user' }));
    expect(cmd).toBe(`cd '/home/user' && 'claude'`);
  });

  test('with resume continue', () => {
    const cmd = BashAdapter.compile(makeLaunch({ cwd: '/home/user', command: ['claude', '-c'] }));
    expect(cmd).toContain(`'claude' '-c'`);
  });

  test('with conda env includes activation block', () => {
    const cmd = BashAdapter.compile(makeLaunch({ cwd: '/home/user', condaEnv: 'myenv' }));
    expect(cmd).toContain(`conda activate 'myenv'`);
    expect(cmd).toContain('conda shell.bash hook');
    // Derive expectations from condaPaths.ts (the single source of truth) instead
    // of copying the literal prefixes here. This locks the real contract — "every
    // prefix's bin is prepended to PATH and every profile script is sourced" —
    // while letting a new prefix be added in one place without a forced red here.
    expect(cmd).toContain(`export PATH="${condaBinPath()}:$PATH"`);
    for (const script of condaProfileScripts()) {
      expect(cmd).toContain(`. "${script}"`);
    }
  });

  test('exports anthropic env vars', () => {
    const cmd = BashAdapter.compile(makeLaunch({
      cwd: '/home/user',
      env: { ANTHROPIC_BASE_URL: 'http://x', UNRELATED: 'no' },
    }));
    expect(cmd).toContain(`export ANTHROPIC_BASE_URL='http://x'`);
    expect(cmd).not.toContain('UNRELATED');
  });

  test('exports proxy env vars when present', () => {
    const cmd = BashAdapter.compile(makeLaunch({
      cwd: '/home/user',
      env: { HTTPS_PROXY: 'http://127.0.0.1:1080', NO_PROXY: 'localhost,127.0.0.1,::1' },
    }));
    expect(cmd).toContain(`export HTTPS_PROXY='http://127.0.0.1:1080'`);
    expect(cmd).toContain(`export NO_PROXY='localhost,127.0.0.1,::1'`);
  });

  test('escapes single quotes in env values', () => {
    const cmd = BashAdapter.compile(makeLaunch({
      cwd: '/home/user',
      env: { ANTHROPIC_AUTH_TOKEN: "it's-a-trap" },
    }));
    expect(cmd).toContain(`export ANTHROPIC_AUTH_TOKEN='it'"'"'s-a-trap'`);
  });

  // BashAdapter already shellQuotes every argv part, so a spaced MCP config path
  // is safe with no special-casing — this just pins that the feed-loop flags
  // survive compilation on POSIX too.
  test('quotes the --mcp-config path and keeps the feed-tool flags', () => {
    const cmd = BashAdapter.compile(makeLaunch({
      cwd: '/home/user',
      command: ['claude', '--mcp-config', '/tmp/spaced dir/mcp-1.json', '--allowedTools', 'mcp__cchub__feed_image'],
    }));
    expect(cmd).toContain(`'claude' '--mcp-config' '/tmp/spaced dir/mcp-1.json' '--allowedTools' 'mcp__cchub__feed_image'`);
  });
});

// The effort level (/effort) is applied by setting CLAUDE_CODE_EFFORT_LEVEL in
// the session env (application/session.ts). Local sessions hand the whole env
// to node-pty so it just works; remote/SSH sessions only carry the keys the
// adapters export (FORWARDED_ENV_KEYS). The bash `export` / cmd `set` lines are
// the ONLY reliable way the var reaches the remote process — the SSH channel
// env is stripped by the remote sshd's AcceptEnv. If effort isn't in the
// forwarded set it silently no-ops on remote, which is exactly the reported
// "effort level doesn't take effect in remote mode" bug. Both adapters must
// emit it.
test.describe('effort level forwarding to remote sessions', () => {
  test('CmdAdapter exports CLAUDE_CODE_EFFORT_LEVEL', () => {
    const cmd = CmdAdapter.compile(makeLaunch({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }));
    expect(cmd).toContain('set "CLAUDE_CODE_EFFORT_LEVEL=high"');
  });

  test('BashAdapter exports CLAUDE_CODE_EFFORT_LEVEL', () => {
    const cmd = BashAdapter.compile(makeLaunch({ cwd: '/home/user', env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }));
    expect(cmd).toContain(`export CLAUDE_CODE_EFFORT_LEVEL='high'`);
  });
});
