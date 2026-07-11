import { Client } from 'ssh2';
import { SshServerProfile } from '../../../shared/protocol.js';
import { resolveSshAuth } from './sshAuth.js';

export interface SshConnectionOptions {
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;

/**
 * Open one ssh2 connection and resolve once it is ready. Rejects on
 * connection/auth error or handshake timeout. The caller owns the returned
 * Client and is responsible for attaching lifetime handlers and calling
 * `conn.end()`.
 */
export function createSshConnection(server: SshServerProfile, options: SshConnectionOptions = {}): Promise<Client> {
  const readyTimeout = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .once('ready', () => resolve(conn))
      .once('error', (error) => reject(error));
    conn.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      ...resolveSshAuth(server),
      readyTimeout,
    });
  });
}
