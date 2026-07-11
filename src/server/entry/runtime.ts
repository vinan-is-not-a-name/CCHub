import { SessionTarget } from '../../shared/protocol.js';

export interface SshRuntime {
  host?: string;
  port: number;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  cwd?: string;
}

export interface Runtime {
  port: number;
  host: string;
  historySize: number;
  defaultTarget: SessionTarget;
  ssh: SshRuntime;
  authToken: string;
}

export function loadRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const sshPort = env.CCHUB_SSH_PORT ? parseInt(env.CCHUB_SSH_PORT, 10) : 22;
  const privateKeyPath = env.CCHUB_SSH_KEY;
  const defaultTarget: SessionTarget = env.CCHUB_DEFAULT_TARGET === 'ssh' ? 'ssh' : 'local';
  return {
    port: parseInt(env.CCHUB_PORT ?? '3000', 10),
    host: env.CCHUB_HOST ?? '127.0.0.1',
    historySize: 64 * 1024,
    defaultTarget,
    ssh: {
      host: env.CCHUB_SSH_HOST,
      port: Number.isFinite(sshPort) ? sshPort : 22,
      username: env.CCHUB_SSH_USER,
      password: env.CCHUB_SSH_PASSWORD,
      privateKeyPath,
      cwd: env.CCHUB_SSH_CWD,
    },
    authToken: env.CCHUB_AUTH_TOKEN ?? '',
  };
}
