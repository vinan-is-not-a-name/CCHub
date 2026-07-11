// In-process SSH test server. Used by playwright globalSetup so that integration
// and E2E SSH paths run end-to-end without needing the host's sshd.
//
// - Accepts a single ed25519 publickey (the test client key).
// - Spawns each `exec` request in the host's default shell (or node-pty for PTY).
// - Picks an ephemeral port; we expose host/port/keypair via writeKeysAndConfig().

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import * as net from 'net';
import * as pty from 'node-pty';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;

export interface SshTestServerHandle {
  port: number;
  host: '127.0.0.1';
  privateKeyPath: string;
  publicKey: string;
  username: string;
  close(): Promise<void>;
}

export async function startSshTestServer(opts: {
  username?: string;
  keyDir: string;
}): Promise<SshTestServerHandle> {
  const username = opts.username ?? 'cchub-test';
  const hostKeys = utils.generateKeyPairSync('ed25519');
  const userKeys = utils.generateKeyPairSync('ed25519');
  const allowedPub = utils.parseKey(userKeys.public);
  if (allowedPub instanceof Error) throw allowedPub;

  mkdirSync(opts.keyDir, { recursive: true });
  const privateKeyPath = join(opts.keyDir, 'id_ed25519');
  writeFileSync(privateKeyPath, userKeys.private, { encoding: 'utf8', mode: 0o600 });

  const server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== username) return ctx.reject(['publickey']);
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const offered = ctx.key;
      if (offered.algo !== allowedPub.type) return ctx.reject(['publickey']);
      const allowedData = allowedPub.getPublicSSH();
      if (!Buffer.isBuffer(offered.data) || !offered.data.equals(allowedData)) return ctx.reject(['publickey']);
      if (ctx.signature) {
        const ok = allowedPub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true;
        if (!ok) return ctx.reject(['publickey']);
      }
      ctx.accept();
    });

    client.on('ready', () => {
      const forwards = new Map<number, net.Server>();
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward' && name !== 'cancel-tcpip-forward') return reject?.();
        const req = info as { bindAddr: string; bindPort: number };
        if (name === 'cancel-tcpip-forward') {
          const existing = forwards.get(req.bindPort);
          if (existing) {
            forwards.delete(req.bindPort);
            existing.close();
          }
          return accept?.();
        }
        const listener = net.createServer((socket) => {
          const remote = socket.remoteAddress ?? '127.0.0.1';
          const remotePort = socket.remotePort ?? 0;
          client.forwardOut(req.bindAddr, req.bindPort, remote, remotePort, (err, ch) => {
            if (err) { socket.destroy(); return; }
            socket.pipe(ch);
            ch.pipe(socket);
            socket.on('error', () => { try { ch.close(); } catch {} });
            ch.on('error', () => { try { socket.destroy(); } catch {} });
          });
        });
        listener.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE' && req.bindAddr === '127.0.0.1') {
            forwards.set(req.bindPort, listener);
            accept?.(req.bindPort);
            return;
          }
          try { reject?.(); } catch {}
        });
        listener.listen(req.bindPort, req.bindAddr, () => {
          const addr = listener.address();
          const boundPort = typeof addr === 'object' && addr ? addr.port : req.bindPort;
          forwards.set(boundPort, listener);
          accept?.(boundPort);
        });
      });
      client.on('close', () => {
        for (const listener of forwards.values()) listener.close();
        forwards.clear();
      });
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let ptyInfo: { cols: number; rows: number; term: string } | undefined;
        session.on('pty', (acceptPty, _r, info) => {
          ptyInfo = { cols: info.cols, rows: info.rows, term: info.term };
          acceptPty();
        });
        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          if (ptyInfo) {
            const file = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
            const args = process.platform === 'win32' ? ['/c', info.command] : ['-lc', info.command];
            const proc = pty.spawn(file, args, {
              name: ptyInfo.term || 'xterm-256color',
              cols: ptyInfo.cols, rows: ptyInfo.rows,
              cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
              env: process.env as Record<string, string>,
            });
            proc.onData((data) => { try { stream.write(data); } catch {} });
            proc.onExit(({ exitCode }) => {
              try { stream.exit(exitCode ?? 0); } catch {}
              try { stream.end(); } catch {}
            });
            stream.on('data', (data: Buffer) => { try { proc.write(data.toString('utf8')); } catch {} });
            stream.on('close', () => { try { proc.kill(); } catch {} });
          } else {
            const file = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
            const args = process.platform === 'win32' ? ['/d', '/s', '/c', info.command] : ['-lc', info.command];
            const proc = spawn(file, args, { windowsHide: true });
            proc.stdout.on('data', (chunk) => { try { stream.write(chunk); } catch {} });
            proc.stderr.on('data', (chunk) => { try { stream.stderr.write(chunk); } catch {} });
            proc.on('close', (code) => {
              try { stream.exit(code ?? 0); } catch {}
              try { stream.end(); } catch {}
            });
            proc.on('error', (err) => {
              try { stream.stderr.write(`spawn error: ${err.message}\n`); } catch {}
              try { stream.exit(127); } catch {}
              try { stream.end(); } catch {}
            });
          }
        });
        session.on('shell', (acceptShell) => {
          // not used by cchub, but accept gracefully so clients don't hang.
          const stream = acceptShell();
          stream.end();
        });
      });
    });

    client.on('error', () => { /* swallow — test server is best-effort */ });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ssh test server: no port');
  const port = address.port;
  return {
    port,
    host: '127.0.0.1',
    privateKeyPath,
    publicKey: userKeys.public.toString(),
    username,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
