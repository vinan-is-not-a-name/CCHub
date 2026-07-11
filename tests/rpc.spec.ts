import { test, expect } from '@playwright/test';
import { Rpc } from '../src/client/net/rpc.js';

interface FakeConn {
  sent: any[];
  send(msg: any): void;
}

function makeConn(): FakeConn {
  const sent: any[] = [];
  return {
    sent,
    send(msg: any) { sent.push(msg); },
  };
}

// Polyfill crypto.randomUUID for the Node test runtime.
if (typeof (globalThis as any).crypto === 'undefined') {
  (globalThis as any).crypto = require('crypto').webcrypto;
}

test.describe('Rpc', () => {
  test('cancelAll rejects every pending request and clears the map', async () => {
    const conn = makeConn();
    const rpc = new Rpc(conn as any);
    const p1 = rpc.request<any>('launch.conda.list.result', (requestId) => ({ type: 'launch.conda.list', requestId }));
    const p2 = rpc.request<any>('launch.cwd.list.result', (requestId) => ({ type: 'launch.cwd.list', path: '/', requestId }));
    expect(rpc.pendingSize()).toBe(2);
    rpc.cancelAll('connection lost');
    expect(rpc.pendingSize()).toBe(0);
    await expect(p1).rejects.toThrow('connection lost');
    await expect(p2).rejects.toThrow('connection lost');
  });

  test('timeout rejects with rpc timeout: <type>', async () => {
    const conn = makeConn();
    const rpc = new Rpc(conn as any);
    const p = rpc.request<any>('launch.conda.list.result', (id) => ({ type: 'launch.conda.list', requestId: id }), { timeoutMs: 50 });
    await expect(p).rejects.toThrow(/rpc timeout: launch\.conda\.list\.result/);
    expect(rpc.pendingSize()).toBe(0);
  });

  test('dispatch resolves the matching request and clears its timer', async () => {
    const conn = makeConn();
    const rpc = new Rpc(conn as any);
    const p = rpc.request<any>('launch.conda.list.result', (id) => ({ type: 'launch.conda.list', requestId: id }), { timeoutMs: 5000 });
    const requestId = (conn.sent[0] as any).requestId;
    const dispatched = rpc.dispatch({ type: 'launch.conda.list.result', requestId, envs: [] } as any);
    expect(dispatched).toBe(true);
    const result = await p;
    expect(result.envs).toEqual([]);
    expect(rpc.pendingSize()).toBe(0);
  });

  test('dispatch ignores wrong-type results for a request id', async () => {
    const conn = makeConn();
    const rpc = new Rpc(conn as any);
    const p = rpc.request<any>('launch.conda.list.result', (id) => ({ type: 'launch.conda.list', requestId: id }), { timeoutMs: 200 });
    const requestId = (conn.sent[0] as any).requestId;
    const dispatched = rpc.dispatch({ type: 'launch.cwd.list.result', requestId, path: '/', entries: [] } as any);
    expect(dispatched).toBe(false);
    expect(rpc.pendingSize()).toBe(1);
    await expect(p).rejects.toThrow(/rpc timeout/); // still pending → eventually times out
  });
});
