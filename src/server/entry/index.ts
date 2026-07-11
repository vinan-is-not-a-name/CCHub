#!/usr/bin/env node
import { join } from 'path';
import { homedir } from 'os';
import { ConfigService, FileConfigRepository, seedFromEnv, SshSeed } from '../domain/config/index.js';
import { SessionManager } from '../application/session.js';
import { TmpFileMcpProvisioner } from '../infrastructure/mcp/sessionMcpConfig.js';
import { makeSessionFeeder } from '../infrastructure/mcp/feedImage.js';
import { buildApp } from './createApp.js';
import { loadRuntime } from './runtime.js';
import { logger } from './logger.js';
import { MetricsCollector } from '../infrastructure/metrics/metricsCollector.js';
import { SessionHookProvisioner } from '../infrastructure/hook/hookProvisioner.js';

const runtime = loadRuntime();

// The loopback guard registered in createApp rejects every non-127.0.0.1
// caller, so we don't need a separate MCP-only bind check here — an exposed
// bind can't actually receive requests. Cross-device access is via SSH
// tunnel.
const mcpProvisioner = new TmpFileMcpProvisioner({ port: runtime.port, authToken: runtime.authToken });
const hookProvisioner = new SessionHookProvisioner({ port: runtime.port, authToken: runtime.authToken });
const manager = new SessionManager({ historySize: runtime.historySize, mcpProvisioner, hookProvisioner });
const feeder = makeSessionFeeder(manager);
const configPath = process.env.CCHUB_CONFIG ?? join(homedir(), '.cchub', 'config.json');
const repo = new FileConfigRepository(configPath);
const sshSeed: SshSeed | undefined = runtime.ssh.host && runtime.ssh.username
  ? {
      host: runtime.ssh.host,
      port: runtime.ssh.port,
      username: runtime.ssh.username,
      password: runtime.ssh.password,
      privateKeyPath: runtime.ssh.privateKeyPath,
      defaultCwd: runtime.ssh.cwd,
      preferred: runtime.defaultTarget === 'ssh',
    }
  : undefined;
const store = new ConfigService(repo, process.cwd(), { onFirstCreate: (initial) => seedFromEnv(initial, sshSeed) });

const metrics = new MetricsCollector(manager);
const app = await buildApp({ manager, store, authToken: runtime.authToken, defaultTarget: runtime.defaultTarget, feeder, metrics });
await app.listen({ port: runtime.port, host: runtime.host });

logger.info(`cchub running: http://${runtime.host}:${runtime.port}`);
// Log only a masked preview of the token rather than the full value. The
// preview is enough to answer "which of my configured tokens is this
// process using" while a scrollback / support-log with the full token no
// longer hands over WS-connect authority to whoever reads it.
const tokenPreview = runtime.authToken
  ? `${runtime.authToken.slice(0, 4)}…${runtime.authToken.slice(-4)}`
  : '(not set — the server will accept any auth message)';
logger.info(`auth token: ${tokenPreview}`);
if (runtime.ssh.host) {
  logger.info(`ssh target: ${runtime.ssh.username ?? '<user>'}@${runtime.ssh.host}:${runtime.ssh.port} ${runtime.ssh.cwd ?? process.cwd()}`);
  logger.info(`ssh url: http://${runtime.host}:${runtime.port}?target=ssh`);
}

async function shutdown(signal: NodeJS.Signals) {
  logger.info(`received ${signal}, shutting down`);
  try { await app.close(); } catch (error) { logger.error(error); }
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
