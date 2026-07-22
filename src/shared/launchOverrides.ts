import type { LaunchOverrides } from './protocol.js';

export interface LaunchFormValues {
  serverId: string;
  profileId: string;
  cwd: string;
  condaEnv: string;
  resume: string;
  skipPermissions: boolean;
  proxyId: string;
  effort: string;
}

// Build LaunchOverrides from the form. The dialog always submits a COMPLETE
// snapshot, so an explicit "off/None/Auto" must reach the server as a real
// value — not undefined, which resolveLaunch reads as "fall back to preset".
// Only the identity ids (server/profile/cwd) collapse empty→undefined: their
// selects are never blank, so empty means "unset, use the defaults ladder".
// skipPermissions/proxyId/effort pass through verbatim (like condaEnv/resume)
// so unchecking skip, picking None proxy, or Auto effort actually overrides a
// preset that set them.
export function buildLaunchOverrides(form: LaunchFormValues): LaunchOverrides {
  return {
    serverId: form.serverId || undefined,
    anthropicProfileId: form.profileId || undefined,
    cwd: form.cwd || undefined,
    condaEnv: form.condaEnv,
    resume: form.resume,
    skipPermissions: form.skipPermissions,
    proxyId: form.proxyId,
    effort: form.effort,
  };
}
