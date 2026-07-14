import { test, expect } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionHookProvisioner } from '../src/server/infrastructure/hook/hookProvisioner.js';
import type { ResolvedLaunch } from '../src/shared/protocol.js';

function localLaunch(cwd: string): ResolvedLaunch {
  return {
    server: { id: 'local', name: 'local', kind: 'local', os: 'linux', createdAt: 0, updatedAt: 0 },
    cwd,
    env: {},
    serverName: 'local',
    label: cwd,
  };
}

function sshLaunch(cwd: string, os: 'linux' | 'windows' = 'linux'): ResolvedLaunch {
  return {
    server: { id: 'ssh', name: 'ssh', kind: 'ssh', os, host: 'h', port: 22, username: 'u', auth: { method: 'password' }, createdAt: 0, updatedAt: 0 },
    cwd,
    env: {},
    serverName: 'ssh',
    label: cwd,
  };
}

test.describe('SessionHookProvisioner', () => {
  test('local provision writes settings.local.json and cleanup removes it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cchub-hook-'));
    try {
      const provisioner = new SessionHookProvisioner({ port: 7777, authToken: 'tok' });
      const grant = provisioner.provision('sess-1', localLaunch(cwd));
      expect(grant.settingsPath).toBe(join(cwd, '.claude', 'settings.local.json'));
      expect(grant.hookTunnel).toBeUndefined();
      expect(grant.setupCommand).toBeUndefined();
      const settings = JSON.parse(readFileSync(grant.settingsPath, 'utf8'));
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('http://127.0.0.1:7777/hook/sess-1');
      expect(settings.hooks.Stop[0].hooks[0].command).toContain("--noproxy '*'");
      provisioner.cleanup('sess-1');
      expect(existsSync(grant.settingsPath)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('ssh provision returns a setup command plus hook reverse tunnel', () => {
    const provisioner = new SessionHookProvisioner({ port: 7777, authToken: 'tok' });
    const grant = provisioner.provision('sess-ssh', sshLaunch('/home/u/work'));
    expect(grant.settingsPath).toBe('/home/u/work/.claude/settings.local.json');
    expect(grant.hookTunnel).toEqual({ bindPort: 7777, host: '127.0.0.1', port: 7777 });
    expect(grant.setupCommand).toContain("mkdir -p '/home/u/work/.claude'");
    expect(grant.setupCommand).toContain("http://127.0.0.1:7777/hook/sess-ssh");
    expect(grant.setupCommand).toContain("--noproxy '\"'\"'*'\"'\"'");
  });

  test('windows ssh provision uses PowerShell write command and Windows curl quoting', () => {
    const provisioner = new SessionHookProvisioner({ port: 7777, authToken: 'tok' });
    const grant = provisioner.provision('sess-win', sshLaunch('C:\\work', 'windows'));
    expect(grant.setupCommand).toContain('powershell.exe -NoProfile -Command');
    expect(grant.setupCommand).toContain('--noproxy \\`"*\\`"');
    // curl.exe dodges the PowerShell curl→Invoke-WebRequest alias, and the event
    // kind rides a ?kind= query param (no -d JSON body → no nested-quote hazard).
    expect(grant.setupCommand).toContain('curl.exe -sS');
    expect(grant.setupCommand).toContain('?kind=stop');
    expect(grant.setupCommand).not.toContain('-d ');
  });
});
