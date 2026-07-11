import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import Fastify from 'fastify';
import { Client } from 'ssh2';
import * as net from 'net';
import { startSshTestServer } from './sshTestServer.js';
import { createSshConnection } from '../src/server/infrastructure/transport/sshFactory.js';
import type { SshServerProfile } from '../src/shared/protocol.js';

function serverProfile(port: number, privateKeyPath: string, username: string): SshServerProfile {
  return {
    id: 'ssh-test', name: 'ssh-test', kind: 'ssh', os: process.platform === 'win32' ? 'windows' : 'linux',
    host: '127.0.0.1', port, username,
    auth: { method: 'privateKeyPath', privateKeyPath },
    createdAt: 0, updatedAt: 0,
  };
}

function execRemote(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', (data: Buffer) => { stdout += data.toString('utf8'); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf8'); });
      stream.on('close', (code: number | null) => resolve({ stdout, stderr, code }));
    });
  });
}

test.describe('SSH test server reverse forwarding', () => {
  test('remote loopback curl reaches a local Fastify hook endpoint through forwardIn', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'cchub-ssh-forward-'));
    const ssh = await startSshTestServer({ keyDir });
    const app = Fastify();
    const received: string[] = [];
    app.addContentTypeParser('*', (_request, _payload, done) => done(null, null));
    app.post('/hook/:sessionId', (request, reply) => {
      received.push(request.method);
      reply.send({ ok: true });
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('missing app address');

    const conn = await createSshConnection(serverProfile(ssh.port, ssh.privateKeyPath, ssh.username));
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('tcp connection', (_info, accept) => {
          const ch = accept();
          const sock = net.connect(address.port, '127.0.0.1');
          ch.pipe(sock);
          sock.pipe(ch);
        });
        conn.forwardIn('127.0.0.1', address.port, (err) => err ? reject(err) : resolve());
      });
      const curl = process.platform === 'win32'
        ? `curl -sS --noproxy "*" -X POST -H "Content-Type: application/json" -d "{\\"kind\\":\\"stop\\"}" http://127.0.0.1:${address.port}/hook/sess`
        : `curl -sS --noproxy '*' -X POST -H "Content-Type: application/json" -d '{"kind":"stop"}' http://127.0.0.1:${address.port}/hook/sess`;
      const result = await execRemote(conn, curl);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('ok');
      expect(received).toEqual(['POST']);
    } finally {
      conn.end();
      await app.close();
      await ssh.close();
      await rm(keyDir, { recursive: true, force: true });
    }
  });
});
