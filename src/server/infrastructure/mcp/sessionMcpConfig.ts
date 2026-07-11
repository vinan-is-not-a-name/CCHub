import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MCP_SERVER_NAME } from '../../../shared/mcp.js';

/**
 * What a provisioned session receives so its claude can reach back into
 * cchub's MCP endpoint. This is the *only* MCP-related data a session
 * carries — it lives inside the session's SessionContext and nowhere global,
 * so two sessions can never see each other's grant.
 */
export interface SessionMcpGrant {
  /** Absolute path to this session's --mcp-config file. */
  configPath: string;
  /** Extra env merged into the session's private env copy (carries CCHUB_SESSION_ID). */
  env: Record<string, string>;
}

/**
 * Port (application depends on this interface, not the fs/os implementation —
 * same inversion as Connector/ShellAdapter). `provision` is called once per
 * session before its command is built; `cleanup` once when it exits for good.
 */
export interface McpProvisioner {
  provision(sessionId: string): SessionMcpGrant | undefined;
  cleanup(sessionId: string): void;
}

export interface McpProvisionerOptions {
  /** Port cchub's HTTP server listens on — the MCP endpoint shares it. */
  port: number;
  /** Bearer token mirrored from the WS auth gate. Empty → no Authorization header. */
  authToken: string;
}

/**
 * Writes one --mcp-config JSON per session into the OS temp dir. The session's
 * identity is welded into the endpoint URL path (`/mcp/<sessionId>`), so the
 * server knows the caller from the URL alone — the agent never self-reports it,
 * and the UUID doubles as the capability token. The URL host is always
 * 127.0.0.1 (loopback only) regardless of cchub's external bind address.
 */
export class TmpFileMcpProvisioner implements McpProvisioner {
  constructor(private readonly opts: McpProvisionerOptions) {}

  provision(sessionId: string): SessionMcpGrant {
    const url = `http://127.0.0.1:${this.opts.port}/mcp/${sessionId}`;
    const server: Record<string, unknown> = { type: 'http', url };
    // Omit the header entirely when there's no token, mirroring the WS gate
    // which treats an empty configured token as "no auth required".
    if (this.opts.authToken) {
      server.headers = { Authorization: `Bearer ${this.opts.authToken}` };
    }
    const config = { mcpServers: { [MCP_SERVER_NAME]: server } };
    const configPath = this.pathFor(sessionId);
    writeFileSync(configPath, JSON.stringify(config), 'utf8');
    return { configPath, env: { CCHUB_SESSION_ID: sessionId } };
  }

  cleanup(sessionId: string): void {
    try { unlinkSync(this.pathFor(sessionId)); } catch { /* already gone — fine */ }
  }

  private pathFor(sessionId: string): string {
    return join(tmpdir(), `cchub-mcp-${sessionId}.json`);
  }
}
