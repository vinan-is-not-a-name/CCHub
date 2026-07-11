import { SshServerProfile } from '../../../shared/protocol.js';
import { createSshConnection } from './sshFactory.js';

export interface ExecOnceOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;

/** Open one ssh2 connection, exec `command`, capture stdout, close. Errors include stderr text on non-zero exit. */
export async function execOnce(server: SshServerProfile, command: string, options: ExecOnceOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Single deadline spanning connect + exec, so total time can't reach 2× timeoutMs.
  const deadline = Date.now() + timeoutMs;
  const conn = await createSshConnection(server, { readyTimeoutMs: timeoutMs });
  return new Promise<string>((resolve, reject) => {
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('remote command timed out'));
    }, remaining);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        conn.end();
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => { stdout += data.toString('utf8'); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf8'); });
      stream.on('close', (code: number) => {
        clearTimeout(timer);
        conn.end();
        if (code && stderr) reject(new Error(stderr.trim()));
        else resolve(stdout.trim());
      });
    });
  });
}
