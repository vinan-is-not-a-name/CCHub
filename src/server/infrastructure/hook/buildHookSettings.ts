export interface HookSettingsInput {
  sessionId: string;
  hookPort: number;
  token: string;
  os?: 'linux' | 'windows' | 'macos';
}

export interface HookSettings {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
}

/**
 * Build the `.claude/settings.local.json` content that registers CC hooks to
 * POST back to cc-remote's hook endpoint when a turn completes or CC needs
 * input.
 *
 * Three events:
 *   - Notification (idle_prompt, permission_prompt): CC is waiting for user.
 *   - Stop: CC finished responding normally.
 *   - StopFailure: CC stopped due to API error / rate limit.
 *
 * Each hook is a standalone `curl` command that POSTs a tiny JSON body to
 * `http://127.0.0.1:<hookPort>/hook/<sessionId>`. For SSH sessions that port
 * is a reverse tunnel back to cc-remote; for local sessions it's cc-remote's
 * own listening port.
 *
 * The curl command always includes `--noproxy '*'` so that any HTTPS_PROXY env
 * (inherited from the session for the user's LLM traffic) doesn't intercept
 * the loopback POST.
 */
export function buildHookSettings(input: HookSettingsInput): HookSettings {
  const { sessionId, hookPort, token, os = 'linux' } = input;
  const url = `http://127.0.0.1:${hookPort}/hook/${sessionId}`;
  return {
    hooks: {
      Notification: [{
        matcher: 'idle_prompt,permission_prompt',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'notification') }],
      }],
      Stop: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'stop') }],
      }],
      StopFailure: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'stop_failure') }],
      }],
    },
  };
}

/**
 * Build a single curl command for a hook event kind.
 * Exported for unit testing.
 */
export function buildCurlCmd(url: string, token: string, os: string, kind: string): string {
  const noproxy = os === 'windows' ? '--noproxy "*"' : "--noproxy '*'";
  const body = JSON.stringify({ kind });
  const bodyArg = os === 'windows'
    ? `"${body.replace(/"/g, '\\"')}"`
    : `'${body}'`;
  return `curl -sS ${noproxy} -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d ${bodyArg} ${url}`;
}
