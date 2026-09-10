import { test, expect } from '@playwright/test';
import { parseProbeOutput, diffRemoteEnv } from '../src/server/infrastructure/transport/envProbe.js';

test.describe('parseProbeOutput', () => {
  test('parses env KEY=VALUE tuples and the claude marker fields', () => {
    const raw = [
      'PATH=/usr/bin:/bin', 'VLM_API_KEY=sk-123', 'CONDA_DEFAULT_ENV=base',
      'CCHUB_CLAUDE_PATH', '/usr/local/bin/claude',
      'CCHUB_CLAUDE_VERSION', '2.1.148 (Claude Code)',
    ].join('\0');
    const probe = parseProbeOutput(raw);
    expect(probe.env.PATH).toBe('/usr/bin:/bin');
    expect(probe.env.VLM_API_KEY).toBe('sk-123');
    expect(probe.env.CONDA_DEFAULT_ENV).toBe('base');
    expect(probe.claudePath).toBe('/usr/local/bin/claude');
    expect(probe.claudeVersion).toBe('2.1.148 (Claude Code)');
  });

  test('a claude marker with an empty value yields undefined (entry content)', () => {
    const raw = ['PATH=/x', 'CCHUB_CLAUDE_PATH', '', 'CCHUB_CLAUDE_VERSION', ''].join('\0');
    const probe = parseProbeOutput(raw);
    expect(probe.claudePath).toBeUndefined();
    expect(probe.claudeVersion).toBeUndefined();
  });

  test('skips malformed env lines (no =, non-opaque key)', () => {
    const raw = ['PATH=/x', 'NOT-A-KEY=val', 'split', 'A=1'].join('\0');
    const probe = parseProbeOutput(raw);
    expect(probe.env).toEqual({ PATH: '/x', A: '1' });
  });

  test('a single trailing NUL yields the sane union', () => {
    const probe = parseProbeOutput('X=1\0');
    expect(probe.env.X).toBe('1');
  });
});

test.describe('diffRemoteEnv', () => {
  const base = (over = {}) => ({
    env: { PATH: '/usr/local/bin:/usr/bin', ANTHROPIC_MODEL: 'm' },
    ...over,
  } as Parameters<typeof diffRemoteEnv>[0]);

  test('null when environments match (interactive adds only shell noise)', () => {
    const interactive = base({
      env: { PATH: '/usr/local/bin:/usr/bin', ANTHROPIC_MODEL: 'm', SHLVL: '2', '_': 'ls' },
    });
    expect(diffRemoteEnv(base(), interactive)).toBeNull();
  });

  test('claude path divergence is reported with both sides', () => {
    const interactive = base({
      claudePath: '/home/czn/.npm-global/bin/claude',
      claudeVersion: '2.1.246 (Claude Code)',
    });
    const diff = diffRemoteEnv(
      base({ claudePath: '/usr/local/bin/claude', claudeVersion: '2.1.148 (Claude Code)' }),
      interactive,
    );
    expect(diff).not.toBeNull();
    expect(diff!.claude).toEqual({
      sessionPath: '/usr/local/bin/claude',
      interactivePath: '/home/czn/.npm-global/bin/claude',
      sessionVersion: '2.1.148 (Claude Code)',
      interactiveVersion: '2.1.246 (Claude Code)',
    });
  });

  test('claude identical regardless of other env variation', () => {
    const both = { claudePath: '/usr/local/bin/claude', claudeVersion: '2.1.246' };
    const diff = diffRemoteEnv(
      base({ ...both, env: { PATH: '/usr/bin', SHLVL: '1' } }),
      base({ ...both, env: { PATH: '/usr/bin', SHLVL: '2', VLM_API_KEY: 'k' } }),
    );
    expect(diff!.claude).toBeNull();
    expect(diff!.missingKeys).toEqual(['VLM_API_KEY']);
  });

  test('missingKeys are the interactive-only user env vars, sorted into absent', () => {
    const interactive = base({
      env: { PATH: '/usr/bin', VLM_API_KEY: 'k', HF_ENDPOINT: 'u', PWD: '/home' },
    });
    const diff = diffRemoteEnv(base({ env: { PATH: '/usr/bin', PWD: '/srv' } }), interactive);
    expect(diff!.missingKeys).toEqual(['HF_ENDPOINT', 'VLM_API_KEY']);
    expect(diff!.missingPathDirs).toEqual([]);
  });

  test('missingPathDirs are PATH segments present only in interactive login', () => {
    const interactive = base({ env: { PATH: '/home/czn/.npm-global/bin:/usr/bin' } });
    const diff = diffRemoteEnv(base(), interactive);
    expect(diff!.missingPathDirs).toEqual(['/home/czn/.npm-global/bin']);
  });

  test('null when only PATH noise differs but paths are same set', () => {
    const interactive = base({ env: { PATH: '/usr/bin:/usr/local/bin' } });
    expect(diffRemoteEnv(base(), interactive)).toBeNull();
  });
});
