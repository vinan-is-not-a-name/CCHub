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
 * POST back to cc-remote's hook endpoint when a turn starts/completes or CC
 * needs input.
 *
 * Events:
 *   - UserPromptSubmit: the user submitted a prompt — a turn just STARTED.
 *     This is the authoritative "processing" signal; without it the server
 *     has to guess a turn began from screen changes, which mis-fires on the
 *     startup banner draw and on a rewind repaint (both strand the dot on
 *     "running" with no matching turn end).
 *   - PreToolUse / PostToolUse: cc is mid-turn, about to run / just ran a tool.
 *     These fire REPEATEDLY during an active turn (once per tool call), so they
 *     serve as a "still processing" heartbeat that RE-ASSERTS the processing
 *     state. UserPromptSubmit alone is a single point of failure: if that one
 *     POST is dropped (tunnel blip, curl miss, out-of-order arrival) the turn
 *     never leaves 'idle' and the dot stays green while cc works. The heartbeat
 *     turns that single POST into N independent chances to correct the state —
 *     any one arriving flips idle→processing. They carry `kind=tool_active` and,
 *     like UserPromptSubmit, are state-only (must NOT reach the notification
 *     pipeline, or every tool call would fire a "ready" toast).
 *   - Notification (idle_prompt, permission_prompt): CC is waiting for user.
 *   - SubagentStart / SubagentStop: a subagent started / finished. Together
 *     they let the server count live subagents: cc fires Stop when the MAIN
 *     turn ends, which can happen while a subagent is still mid-flight — a
 *     Stop while subagents are live must not flip the session to idle.
 *
 * Version support (measured against the changelog + the 2.0.42 bundle):
 * SubagentStop exists since 1.0.41, SubagentStart since 2.0.43. Both are
 * injected unconditionally — an older cc treats the unknown event name as an
 * ignorable settings key (verified: 2.0.42 loads a settings file containing
 * SubagentStart without erroring, behaviour identical to one without it), so
 * old clients degrade silently (no subagent counting) instead of breaking.
 * The server-side counter guards `count > 0` before decrementing, so a
 * partial-support cc (Stop only) is also a no-op.
 *   - Stop: CC finished responding normally.
 *   - StopFailure: CC stopped due to API error / rate limit.
 *
 * Each hook is a standalone `curl` command that POSTs to
 * `http://127.0.0.1:<hookPort>/hook/<sessionId>?kind=<event>`. For SSH sessions
 * that port is a reverse tunnel back to cc-remote; for local sessions it's
 * cc-remote's own listening port.
 *
 * The event kind travels as a query param, not a JSON body: on Windows the hook
 * runs under PowerShell/cmd, where escaping a JSON body's inner quotes is
 * unreliable (PowerShell mangles `\"`, producing a malformed body the server
 * 400s). A bare query param needs no body and no inner quoting on any shell.
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
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'user_prompt_submit') }],
      }],
      PreToolUse: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'tool_active') }],
      }],
      PostToolUse: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'tool_active') }],
      }],
      // Split into two Notification entries: permission_prompt is a real
      // approval (→ approval notification), idle_prompt is cc simply waiting
      // for input (→ no notification — the client ignores this kind).
      Notification: [{
        matcher: 'permission_prompt',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'approval_request') }],
      }, {
        matcher: 'idle_prompt',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'idle_prompt') }],
      }],
      SubagentStart: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'subagent_start') }],
      }],
      SubagentStop: [{
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlCmd(url, token, os, 'subagent_stop') }],
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
  const isWin = os === 'windows';
  // curl.exe (not bare `curl`): in PowerShell `curl` is an alias for
  // Invoke-WebRequest, which rejects curl's -sS/-X/-H flags and never sends the
  // request. curl.exe is the real binary (System32) in both cmd and PowerShell.
  const bin = isWin ? 'curl.exe' : 'curl';
  const noproxy = isWin ? '--noproxy "*"' : "--noproxy '*'";
  const fullUrl = `${url}?kind=${kind}`;
  const urlArg = isWin ? `"${fullUrl}"` : `'${fullUrl}'`;
  return `${bin} -sS ${noproxy} -X POST -H "Authorization: Bearer ${token}" ${urlArg}`;
}
