import { test, expect } from '@playwright/test';
import { buildLaunchOverrides } from '../src/shared/launchOverrides.js';

const blankForm = { serverId: '', profileId: '', cwd: '', condaEnv: '', resume: '' };

// buildLaunchOverrides has exactly three behaviours worth pinning, so the suite is
// three cases — not one per field. The earlier file repeated the blank-form
// assertions across four overlapping tests; they are unified into the single
// blank-form case below without losing any assertion.
test.describe('buildLaunchOverrides', () => {
  // id-like fields (serverId/profileId/cwd) collapse '' → undefined so the server's
  // resolveLaunch is the single place that falls back to preset/defaults; but
  // condaEnv/resume pass '' through verbatim because an explicit empty IS a choice
  // ("No conda env" / "don't resume") that must NOT be re-filled from the preset.
  test('blank form: id fields → undefined, condaEnv/resume → empty string (no client-side preset fallback)', () => {
    const out = buildLaunchOverrides(blankForm);
    expect(out.serverId).toBeUndefined();
    expect(out.anthropicProfileId).toBeUndefined();
    expect(out.cwd).toBeUndefined();
    expect(out.condaEnv).toBe('');
    expect(out.resume).toBe('');
  });

  test('filled form passes every field through verbatim', () => {
    const out = buildLaunchOverrides(
      { serverId: 'user-server', profileId: 'user-profile', cwd: '/user/cwd', condaEnv: 'user-env', resume: 'continue' },
    );
    expect(out.serverId).toBe('user-server');
    expect(out.anthropicProfileId).toBe('user-profile');
    expect(out.cwd).toBe('/user/cwd');
    expect(out.condaEnv).toBe('user-env');
    expect(out.resume).toBe('continue');
  });

  test('resume = continue is preserved (the resume opt-in)', () => {
    expect(buildLaunchOverrides({ ...blankForm, resume: 'continue' }).resume).toBe('continue');
  });
});
