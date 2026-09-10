import { test, expect } from '@playwright/test';
import * as http from 'node:http';
import { requestText } from '../src/server/infrastructure/transport/httpRequest.js';

/** Run `fn(baseUrl)` against a throwaway local HTTP server. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    // A hung request holds its socket open; without this the close() below
    // waits for it forever.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test.describe('requestText', () => {
  test('returns status and body', async () => {
    await withServer((req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, async (base) => {
      const res = await requestText(`${base}/x`, { timeoutMs: 3000 });
      expect(res.status).toBe(201);
      expect(JSON.parse(res.text)).toEqual({ ok: true });
    });
  });

  test('posts a body with headers', async () => {
    await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'x-echo-auth': String(req.headers.authorization ?? '') });
        res.end(body);
      });
    }, async (base) => {
      const res = await requestText(`${base}/echo`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok' },
        body: 'hello',
        timeoutMs: 3000,
      });
      expect(res.text).toBe('hello');
    });
  });

  test('rejects when the peer never responds (timeout)', async () => {
    await withServer(() => { /* never respond */ }, async (base) => {
      await expect(requestText(`${base}/hang`, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    });
  });

  test('retries a timed-out attempt and succeeds on the next one', async () => {
    let calls = 0;
    await withServer((req, res) => {
      calls += 1;
      if (calls === 1) return; // hang → client times out on attempt 1
      res.end('second');
    }, async (base) => {
      const res = await requestText(`${base}/flaky`, { timeoutMs: 300, attempts: 2 });
      expect(res.text).toBe('second');
      expect(calls).toBe(2);
    });
  });

  test('does not retry an HTTP error status — a 500 is an answer, not a flake', async () => {
    let calls = 0;
    await withServer((req, res) => {
      calls += 1;
      res.writeHead(500);
      res.end('boom');
    }, async (base) => {
      const res = await requestText(`${base}/broken`, { timeoutMs: 300, attempts: 3 });
      expect(res.status).toBe(500);
      expect(calls).toBe(1);
    });
  });

  test('resolves a HOSTNAME (exercises the lookup wrapper, not just IP literals)', async () => {
    // IP-literal URLs skip name resolution entirely — every other test here
    // uses 127.0.0.1, so this is the only one that would catch a broken
    // lookup wrapper (e.g. dropping options.all and returning a bare string
    // where node expects an array → "Invalid IP address: undefined").
    await withServer((req, res) => res.end('via-hostname'), async (base) => {
      const hostnameBase = base.replace('127.0.0.1', 'localhost');
      const res = await requestText(`${hostnameBase}/host`, { timeoutMs: 3000 });
      expect(res.text).toBe('via-hostname');
    });
  });

  test('opens a fresh connection per request — no socket reuse', async () => {
    // The whole point of agent:false: a long-running process must not keep
    // reusing sockets that a proxy/VPN killed. Distinct client ports prove a
    // new connection per call; a pooled agent (the previous fetch behavior)
    // reuses the socket and reports the same port twice.
    const clientPorts: number[] = [];
    await withServer((req, res) => {
      clientPorts.push(req.socket.remotePort ?? 0);
      res.end('ok');
    }, async (base) => {
      await requestText(`${base}/a`, { timeoutMs: 3000 });
      await requestText(`${base}/b`, { timeoutMs: 3000 });
    });
    expect(clientPorts).toHaveLength(2);
    expect(clientPorts[0]).not.toBe(clientPorts[1]);
  });
});
