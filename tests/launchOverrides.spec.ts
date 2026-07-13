import { test, expect } from '@playwright/test';
import { buildLaunchOverrides } from '../src/shared/launchOverrides.js';

const blankForm = { serverId: '', profileId: '', cwd: '', condaEnv: '', resume: '', skipPermissions: false, proxyId: '', effort: '' };

test.describe('buildLaunchOverrides', () => {
  test('blank form: id fields → undefined, condaEnv/resume → empty string (no client-side preset fallback)', () => {
    const out = buildLaunchOverrides(blankForm);
    expect(out.serverId).toBeUndefined();
    expect(out.anthropicProfileId).toBeUndefined();
    expect(out.cwd).toBeUndefined();
    expect(out.condaEnv).toBe('');
    expect(out.resume).toBe('');
    expect(out.skipPermissions).toBeUndefined();
    expect(out.proxyId).toBeUndefined();
    expect(out.effort).toBeUndefined();
  });

  test('filled form passes every field through verbatim', () => {
    const out = buildLaunchOverrides(
      { serverId: 'user-server', profileId: 'user-profile', cwd: '/user/cwd', condaEnv: 'user-env', resume: 'continue', skipPermissions: true, proxyId: 'px1', effort: 'max' },
    );
    expect(out.serverId).toBe('user-server');
    expect(out.anthropicProfileId).toBe('user-profile');
    expect(out.cwd).toBe('/user/cwd');
    expect(out.condaEnv).toBe('user-env');
    expect(out.resume).toBe('continue');
    expect(out.skipPermissions).toBe(true);
    expect(out.proxyId).toBe('px1');
    expect(out.effort).toBe('max');
  });

  test('resume = continue is preserved (the resume opt-in)', () => {
    expect(buildLaunchOverrides({ ...blankForm, resume: 'continue' }).resume).toBe('continue');
  });

  test('skipPermissions=false becomes undefined (not set)', () => {
    const out = buildLaunchOverrides({ ...blankForm, skipPermissions: false });
    expect(out.skipPermissions).toBeUndefined();
  });

  test('empty proxyId and effort become undefined', () => {
    const out = buildLaunchOverrides({ ...blankForm, proxyId: '', effort: '' });
    expect(out.proxyId).toBeUndefined();
    expect(out.effort).toBeUndefined();
  });
});
