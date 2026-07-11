import { test, expect } from '@playwright/test';
import { parseCondaEnvs } from '../src/server/infrastructure/discovery/condaList.js';

// parseCondaEnvs turns `conda env list --json` output into name/path entries. The
// name derivation (envs/<name> vs the base fallback) and de-duplication are pure
// and cross-platform, but only ever ran behind real conda IO. Pinned here directly.
test.describe('parseCondaEnvs', () => {
  test('derives the env name from a POSIX envs/ path', () => {
    const out = parseCondaEnvs(JSON.stringify({ envs: ['/home/u/miniconda3/envs/py311'] }));
    expect(out).toEqual([{ name: 'py311', path: '/home/u/miniconda3/envs/py311' }]);
  });

  test('derives the env name from a Windows \\envs\\ path', () => {
    const path = 'C:\\Users\\u\\miniconda3\\envs\\dev';
    const out = parseCondaEnvs(JSON.stringify({ envs: [path] }));
    expect(out).toEqual([{ name: 'dev', path }]);
  });

  test('a non-envs path (the install root) becomes base', () => {
    const out = parseCondaEnvs(JSON.stringify({ envs: ['/opt/conda'] }));
    expect(out).toEqual([{ name: 'base', path: '/opt/conda' }]);
  });

  test('de-duplicates by name, keeping the first occurrence', () => {
    const out = parseCondaEnvs(JSON.stringify({
      envs: ['/opt/conda', '/home/u/anaconda3', '/home/u/anaconda3/envs/x'],
    }));
    // Both non-envs roots derive name "base"; only the first survives.
    expect(out).toEqual([
      { name: 'base', path: '/opt/conda' },
      { name: 'x', path: '/home/u/anaconda3/envs/x' },
    ]);
  });

  test('missing or non-array envs yields an empty list', () => {
    expect(parseCondaEnvs(JSON.stringify({}))).toEqual([]);
    expect(parseCondaEnvs(JSON.stringify({ envs: null }))).toEqual([]);
  });
});
