import { ConfigService, assertCondaEnv } from '../domain/config/index.js';
import { AnthropicEnv, LaunchOverrides, LaunchPreset, ProxyTunnel, ResolvedLaunch, AnthropicEnvProfile, SessionTarget } from '../../shared/protocol.js';
import { normalizeTerminalEnv } from '../../shared/envKeys.js';

export interface CreateSessionRequest {
  cwd?: string;
  resume?: string;
  target?: 'local' | 'ssh';
  presetId?: string;
  launch?: LaunchOverrides;
}

interface LaunchParams {
  cwd: string;
  condaEnv?: string;
  resume?: string;
}

export function resolveLaunch(input: CreateSessionRequest, store: ConfigService, defaultTarget: SessionTarget = 'local'): ResolvedLaunch {
  const defaults = store.getDefaults();
  const launch = input.launch ?? {};
  // Preset is opt-in: only what the caller passed. We no longer fall back to
  // `defaults.presetId` (which is auto-promoted from the first preset ever
  // created) — that fallback turned every "custom" launch into an implicit
  // preset launch, so session labels and recent-history entries all read as
  // that preset's name.
  const preset = resolvePreset(input.presetId, store);
  const server = store.resolveServer({
    preferredIds: [launch.serverId, preset?.serverId, defaults.serverId],
    fallbackTarget: input.target ?? defaultTarget,
  });
  const profile = resolveProfile(launch, preset, defaults.profileId, store);
  const params = resolveLaunchParams(input, launch, preset);
  // Proxy is SSH-only: a reverse tunnel is meaningless for a local PTY, so we
  // drop it (and its env) for local servers even if the preset names one.
  const proxy = server.kind === 'ssh' ? resolveProxy(launch, preset, store) : undefined;
  const env = buildEnv(profile?.env, proxy);
  return {
    server,
    cwd: params.cwd,
    env,
    // Profile-only env, pre-merge — see ResolvedLaunch.profileEnv.
    profileEnv: profile?.env,
    resume: params.resume,
    condaEnv: params.condaEnv,
    skipPermissions: launch.skipPermissions ?? preset?.skipPermissions,
    // Defaults ON — the one toggle whose fallback is true rather than absent.
    // The trailing `?? true` is what makes "new session, nothing recorded
    // anywhere" land on the checked state the form shows; a stored `false`
    // (explicit opt-out) survives both `??` hops because false is not nullish.
    skipWebFetchPreflight: launch.skipWebFetchPreflight ?? preset?.skipWebFetchPreflight ?? true,
    // SSH only: a local launch reaches a loopback endpoint directly. Anything
    // that is not loopback is left alone (see loopbackTunnelFor).
    loopbackTunnel: server.kind === 'ssh'
      ? loopbackTunnelFor(profile?.env.ANTHROPIC_BASE_URL)
      : undefined,
    proxy,
    effort: launch.effort ?? preset?.effort,
    serverName: server.name,
    profileName: profile?.name,
    presetName: preset?.name,
    // The "detail" part of a session's display name: the server the launch
    // targets and the absolute cwd inside it. The client puts the preset name
    // in front and drops this string in parens (see sessionLabel), so the tab
    // reads as `presetName (server:cwd)`.
    label: `${server.name}:${params.cwd}`,
  };
}

function resolvePreset(presetId: string | undefined, store: ConfigService): LaunchPreset | undefined {
  return store.getPreset(presetId);
}

/** Look up the proxy referenced by the launch override or preset. Returns the
 * runtime tunnel shape, or undefined when neither names a proxy or the id no
 * longer resolves. */
function resolveProxy(launch: LaunchOverrides, preset: LaunchPreset | undefined, store: ConfigService): ProxyTunnel | undefined {
  const proxyId = launch.proxyId ?? preset?.proxyId;
  const proxy = store.getProxy(proxyId);
  if (!proxy) return undefined;
  return { bindPort: proxy.bindPort, host: proxy.host, port: proxy.port };
}

function resolveProfile(
  launch: LaunchOverrides,
  preset: LaunchPreset | undefined,
  defaultProfileId: string | undefined,
  store: ConfigService,
): AnthropicEnvProfile | undefined {
  return store.getProfile(launch.anthropicProfileId ?? preset?.anthropicProfileId ?? defaultProfileId);
}

function resolveLaunchParams(input: CreateSessionRequest, launch: LaunchOverrides, preset: LaunchPreset | undefined): LaunchParams {
  const cwd = launch.cwd ?? input.cwd ?? preset?.cwd;
  if (!cwd) throw new Error('cwd is required');
  const condaEnv = launch.condaEnv ?? preset?.condaEnv;
  if (condaEnv) assertCondaEnv(condaEnv);
  const resume = launch.resume ?? input.resume ?? preset?.resume;
  return { cwd, condaEnv, resume };
}

/**
 * The reverse tunnel an SSH launch needs when its profile points at THIS
 * machine's loopback — a cc-switch router on `http://127.0.0.1:15721` is the
 * case that prompted this.
 *
 * Such a profile is a statement about where the LLM traffic goes; making that
 * address reachable on the other side is cchub's job, not another knob. On a
 * remote host `127.0.0.1:<port>` is the REMOTE's loopback, where nothing
 * listens, so the same port is bound there and forwarded back here. Local
 * launches need nothing — they reach it directly.
 *
 * Deliberately limited to loopback. A profile pointing at a private LAN address
 * may well be reachable from the remote on its own, and forwarding it would be
 * a guess.
 */
export function loopbackTunnelFor(baseUrl: string | undefined): ProxyTunnel | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return undefined;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { bindPort: port, host: '127.0.0.1', port };
}

function buildEnv(profileEnv?: AnthropicEnv, proxy?: ProxyTunnel): Record<string, string> {
  // normalizeTerminalEnv first, so a profile that deliberately sets TERM or a
  // terminal var still wins — the strip is about what the *host shell* leaked,
  // not about overriding an explicit choice.
  const env = normalizeTerminalEnv(process.env as Record<string, string>);
  for (const [key, value] of Object.entries(profileEnv ?? {})) {
    if (value) env[key] = value;
  }
  if (proxy) Object.assign(env, buildProxyEnv(proxy));
  return env;
}

/** Proxy env routed to the remote claude. The tunnel binds `127.0.0.1:<bindPort>`
 * on the remote host, so the remote process points at that local address. Both
 * cases are written because some tools read the lowercase variants specifically.
 * NO_PROXY keeps loopback traffic off the tunnel. */
function buildProxyEnv(proxy: ProxyTunnel): Record<string, string> {
  const url = `http://127.0.0.1:${proxy.bindPort}`;
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: noProxy,
    http_proxy: url, https_proxy: url, all_proxy: url, no_proxy: noProxy,
  };
}
