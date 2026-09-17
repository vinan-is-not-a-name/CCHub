import { rmSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, posix, win32 } from 'path';
import type { ProxyTunnel, ResolvedLaunch, ServerOs } from '../../../shared/protocol.js';
import { buildHookSettings } from './buildHookSettings.js';

export interface SessionHookGrant {
  settingsPath: string;
  hookTunnel?: ProxyTunnel;
  setupCommand?: string;
}

export interface HookProvisioner {
  provision(sessionId: string, launch: ResolvedLaunch): SessionHookGrant | undefined;
  cleanup(sessionId: string): void;
}

export interface HookProvisionerOptions {
  port: number;
  authToken: string;
}

/** Remote hook ports are handed out from this range, one per live SSH session.
 * `ssh -R` binds the port ON THE REMOTE HOST, so the number has to be unique
 * per session there — two sessions to the same host claiming one number means
 * the second bind fails and its hooks silently stop firing (the "port conflict
 * when connecting several sessions to one server" report). 3778 is the old
 * fallback, kept as the base so single-session behaviour is unchanged. */
const REMOTE_HOOK_PORT_BASE = 3778;
const REMOTE_HOOK_PORT_COUNT = 64;

export class SessionHookProvisioner implements HookProvisioner {
  private readonly grants = new Map<string, { launch: ResolvedLaunch; settingsPath: string; remotePort?: number }>();
  /** Remote ports currently claimed by a live session of THIS process. */
  private readonly remotePortsInUse = new Set<number>();

  constructor(private readonly opts: HookProvisionerOptions) {}

  provision(sessionId: string, launch: ResolvedLaunch): SessionHookGrant {
    const settingsPath = settingsPathFor(launch);
    const hookPort = this.hookPortFor(sessionId, launch);
    const settings = buildHookSettings({
      sessionId,
      hookPort,
      token: this.opts.authToken,
      os: launch.server.os,
    });
    const json = JSON.stringify(settings, null, 2);

    this.grants.set(sessionId, {
      launch,
      settingsPath,
      remotePort: launch.server.kind === 'ssh' ? hookPort : undefined,
    });
    if (launch.server.kind === 'ssh') {
      return {
        settingsPath,
        setupCommand: buildRemoteWriteCommand(launch.server.os, settingsPath, json),
        hookTunnel: { bindPort: hookPort, host: '127.0.0.1', port: this.opts.port },
      };
    }

    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, json, 'utf8');
    return { settingsPath };
  }

  cleanup(sessionId: string): void {
    const grant = this.grants.get(sessionId);
    if (!grant) return;
    this.grants.delete(sessionId);
    // Release before the SSH early-return: a remote port stays claimed for
    // exactly as long as its session lives, so the next session on that host
    // can reuse it.
    if (grant.remotePort !== undefined) this.remotePortsInUse.delete(grant.remotePort);
    if (grant.launch.server.kind === 'ssh') {
      return;
    }
    try { rmSync(grant.settingsPath); } catch {}
  }

  private hookPortFor(sessionId: string, launch: ResolvedLaunch): number {
    // Local sessions POST to cchub's own listener — no tunnel, no conflict.
    if (launch.server.kind !== 'ssh') return this.opts.port;
    // Re-provisioning an id (resume fallback) must keep the SAME remote port:
    // the host's settings.local.json already names it, and the tunnel is
    // re-established on the same number.
    const claimed = this.grants.get(sessionId)?.remotePort;
    if (claimed !== undefined) return claimed;

    for (let port = REMOTE_HOOK_PORT_BASE; port < REMOTE_HOOK_PORT_BASE + REMOTE_HOOK_PORT_COUNT; port++) {
      if (this.remotePortsInUse.has(port)) continue;
      this.remotePortsInUse.add(port);
      return port;
    }
    // Range exhausted (64 concurrent SSH sessions). Handing out a port that is
    // already taken is better than failing the launch: the tunnel bind reports
    // itself on the session, and only hooks degrade.
    return REMOTE_HOOK_PORT_BASE;
  }
}

function settingsPathFor(launch: ResolvedLaunch): string {
  if (launch.server.kind !== 'ssh') return join(launch.cwd, '.claude', 'settings.local.json');
  return launch.server.os === 'windows'
    ? win32.join(launch.cwd, '.claude', 'settings.local.json')
    : posix.join(launch.cwd, '.claude', 'settings.local.json');
}

function buildRemoteWriteCommand(os: ServerOs, filePath: string, content: string): string {
  const dir = os === 'windows' ? win32.dirname(filePath) : posix.dirname(filePath);
  return os === 'windows'
    ? `powershell.exe -NoProfile -Command ${psQuote(`New-Item -ItemType Directory -Force -Path ${psString(dir)} | Out-Null; Set-Content -LiteralPath ${psString(filePath)} -Value ${psString(content)} -Encoding UTF8`)}`
    : `mkdir -p ${shQuote(dir)} && printf %s ${shQuote(content)} > ${shQuote(filePath)}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function psQuote(value: string): string {
  return `"${value.replace(/"/g, '`"')}"`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
