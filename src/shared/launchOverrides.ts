import type { LaunchOverrides } from './protocol.js';

export interface LaunchFormValues {
  serverId: string;
  profileId: string;
  cwd: string;
  condaEnv: string;
  resume: string;
}

// Build LaunchOverrides from the form. All values pass through verbatim; the
// server-side resolveLaunch handles preset/defaults fallback as the single decision point.
export function buildLaunchOverrides(form: LaunchFormValues): LaunchOverrides {
  return {
    serverId: form.serverId || undefined,
    anthropicProfileId: form.profileId || undefined,
    cwd: form.cwd || undefined,
    condaEnv: form.condaEnv,
    resume: form.resume,
  };
}
