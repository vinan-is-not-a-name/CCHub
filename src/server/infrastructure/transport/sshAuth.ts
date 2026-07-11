import { readFileSync } from 'fs';
import { SshServerProfile } from '../../../shared/protocol.js';

export function resolveSshAuth(server: SshServerProfile) {
  if (server.auth.method === 'password') {
    if (!server.auth.password) throw new Error('SSH password is required');
    return { password: server.auth.password };
  }
  if (!server.auth.privateKeyPath) throw new Error('SSH private key path is required');
  return { privateKey: readFileSync(server.auth.privateKeyPath, 'utf8') };
}
