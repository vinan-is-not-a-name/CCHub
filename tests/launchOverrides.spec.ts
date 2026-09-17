import { test, expect } from '@playwright/test';
import { buildLaunchOverrides } from '../src/shared/launchOverrides.js';

const blankForm = { serverId: '', profileId: '', cwd: '', condaEnv: '', resume: '', skipPermissions: false, skipWebFetchPreflight: true, proxyId: '', effort: '' };

test.describe('buildLaunchOverrides', () => {
  test('blank form: id fields → undefined; condaEnv/resume/skip/proxy/effort → explicit empty (a full snapshot, no client-side preset fallback)', () => {
    const out = buildLaunchOverrides(blankForm);
    expect(out.serverId).toBeUndefined();
    expect(out.anthropicProfileId).toBeUndefined();
    expect(out.cwd).toBeUndefined();
    expect(out.condaEnv).toBe('');
    expect(out.resume).toBe('');
    // The dialog submits a complete snapshot: an explicit off/None/Auto must
    // reach the server verbatim so it overrides a preset that set these.
    expect(out.skipPermissions).toBe(false);
    expect(out.skipWebFetchPreflight).toBe(true);
    expect(out.proxyId).toBe('');
    expect(out.effort).toBe('');
  });

  test('filled form passes every field through verbatim', () => {
    const out = buildLaunchOverrides(
      { serverId: 'user-server', profileId: 'user-profile', cwd: '/user/cwd', condaEnv: 'user-env', resume: 'continue', skipPermissions: true, skipWebFetchPreflight: false, proxyId: 'px1', effort: 'max' },
    );
    expect(out.serverId).toBe('user-server');
    expect(out.anthropicProfileId).toBe('user-profile');
    expect(out.cwd).toBe('/user/cwd');
    expect(out.condaEnv).toBe('user-env');
    expect(out.resume).toBe('continue');
    expect(out.skipPermissions).toBe(true);
    expect(out.skipWebFetchPreflight).toBe(false);
    expect(out.proxyId).toBe('px1');
    expect(out.effort).toBe('max');
  });

  // Unlike skipPermissions the default is ON, so the interesting case is the
  // opt-out surviving the trip — false must not be swallowed as "absent".
  test('skipWebFetchPreflight=false reaches the server as false', () => {
    expect(buildLaunchOverrides({ ...blankForm, skipWebFetchPreflight: false }).skipWebFetchPreflight).toBe(false);
  });

  test('resume = continue is preserved (the resume opt-in)', () => {
    expect(buildLaunchOverrides({ ...blankForm, resume: 'continue' }).resume).toBe('continue');
  });

  test('skipPermissions=false passes through as false (explicit off overrides a preset that skips)', () => {
    const out = buildLaunchOverrides({ ...blankForm, skipPermissions: false });
    expect(out.skipPermissions).toBe(false);
  });

  test('empty proxyId and effort pass through as empty string (explicit None/Auto overrides a preset that set them)', () => {
    const out = buildLaunchOverrides({ ...blankForm, proxyId: '', effort: '' });
    expect(out.proxyId).toBe('');
    expect(out.effort).toBe('');
  });
});
