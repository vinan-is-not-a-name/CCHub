import { test, expect } from '@playwright/test';
import {
  REMOTE_CONDA_PREFIXES,
  condaBinPath,
  condaBinaryCandidates,
  condaProfileScripts,
  REMOTE_BASH_PROFILES,
  bashProfileList,
  bashProfileSourceSnippet,
} from '../src/server/infrastructure/discovery/condaPaths.js';

// This is the *right* home for the literal conda-path assertions that shell.spec
// used to hardcode: condaPaths.ts is the single source of truth, so locking the
// exact prefixes and their order belongs here. Adding a prefix is a deliberate
// change that updates this spec — not a surprise red in an unrelated shell test.

test.describe('condaPaths — canonical prefixes and derivations', () => {
  test('prefix order is the documented fallback order (earlier wins)', () => {
    expect([...REMOTE_CONDA_PREFIXES]).toEqual([
      '$HOME/miniconda3', '$HOME/miniforge3', '$HOME/anaconda3', '/opt/conda',
    ]);
  });

  test('condaBinPath prepends <prefix>/bin for each, colon-joined in order', () => {
    expect(condaBinPath()).toBe(
      '$HOME/miniconda3/bin:$HOME/miniforge3/bin:$HOME/anaconda3/bin:/opt/conda/bin',
    );
  });

  test('condaBinaryCandidates is <prefix>/bin/conda for each', () => {
    expect(condaBinaryCandidates()).toEqual(REMOTE_CONDA_PREFIXES.map((p) => `${p}/bin/conda`));
  });

  test('condaProfileScripts is <prefix>/etc/profile.d/conda.sh for each', () => {
    expect(condaProfileScripts()).toEqual(
      REMOTE_CONDA_PREFIXES.map((p) => `${p}/etc/profile.d/conda.sh`),
    );
  });
});

test.describe('condaPaths — bash profile sourcing', () => {
  test('profile order matches the login-shell precedence', () => {
    expect([...REMOTE_BASH_PROFILES]).toEqual(['$HOME/.bashrc', '$HOME/.bash_profile', '$HOME/.profile']);
  });

  test('bashProfileList quotes and space-joins each profile', () => {
    expect(bashProfileList()).toBe(`"$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"`);
  });

  test('bashProfileSourceSnippet loops over the quoted list and swallows errors', () => {
    const snippet = bashProfileSourceSnippet();
    expect(snippet).toContain(`for profile in ${bashProfileList()}; do`);
    expect(snippet).toContain('[ -r "$profile" ] && . "$profile" >/dev/null 2>&1 || true');
  });
});
