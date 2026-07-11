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

export class SessionHookProvisioner implements HookProvisioner {
  private readonly grants = new Map<string, { launch: ResolvedLaunch; settingsPath: string }>();

  constructor(private readonly opts: HookProvisionerOptions) {}

  provision(sessionId: string, launch: ResolvedLaunch): SessionHookGrant {
    const settingsPath = settingsPathFor(launch);
    const hookPort = this.hookPortFor(launch);
    const settings = buildHookSettings({
      sessionId,
      hookPort,
      token: this.opts.authToken,
      os: launch.server.os,
    });
    const json = JSON.stringify(settings, null, 2);

    this.grants.set(sessionId, { launch, settingsPath });
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
    if (grant.launch.server.kind === 'ssh') {
      return;
    }
    try { rmSync(grant.settingsPath); } catch {}
  }

  private hookPortFor(launch: ResolvedLaunch): number {
    if (launch.server.kind === 'ssh') return pickRemoteHookPort(this.opts.port);
    return this.opts.port;
  }
}

function pickRemoteHookPort(port: number): number {
  if (port > 0 && port <= 65535) return port;
  return 3778;
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
