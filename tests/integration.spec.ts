import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

async function connectWs(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    // Server pushes `metrics.snapshot` on its own timer (see
    // src/server/ws/connection.ts — the CPU/memory topbar badge subscribes to
    // it and refreshes ~1 Hz). It fires immediately after `auth.ok` if the
    // metrics collector already has a sample, so a naive `once('message', …)`
    // captures the push instead of the actual request response. Skip
    // metrics.snapshot events transparently; every request in this file is a
    // strict req/reply on config/launch handlers that never emits metrics.
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'metrics.snapshot') {
        ws.once('message', onMessage);
        return;
      }
      resolve(msg);
    };
    ws.once('message', onMessage);
  });
}

function send(ws: WebSocket, msg: any) {
  ws.send(JSON.stringify(msg));
}

/** Send one client message and await the single server reply (these handlers
 * are strictly request/response on the config/launch paths). */
async function request(ws: WebSocket, msg: any): Promise<any> {
  send(ws, msg);
  return nextMsg(ws);
}

/** Unique per-call name so a test never collides with residue from a prior run.
 * Combined with the per-test cleanup below, this keeps the shared config from
 * accumulating entities even though the suite writes to a real config file. */
let seq = 0;
function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function authed(): Promise<WebSocket> {
  const ws = await connectWs('ws://127.0.0.1:3001/ws');
  send(ws, { type: 'auth' });
  await nextMsg(ws);
  return ws;
}

test.describe('集成测试 - WebSocket 协议', () => {
  test('未认证 → UNAUTHORIZED', async () => {
    const ws = await connectWs('ws://127.0.0.1:3001/ws');
    const msg = await request(ws, { type: 'session.list' });
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('UNAUTHORIZED');
    ws.close();
  });

  test('auth → auth.ok', async () => {
    const ws = await connectWs('ws://127.0.0.1:3001/ws');
    const msg = await request(ws, { type: 'auth' });
    expect(msg.type).toBe('auth.ok');
    ws.close();
  });

  test('config.get → 返回 snapshot，密钥被掩码', async () => {
    const ws = await authed();
    const msg = await request(ws, { type: 'config.get' });
    expect(msg.type).toBe('config.snapshot');
    expect(msg.config).toHaveProperty('profiles');
    expect(msg.config).toHaveProperty('servers');
    expect(msg.config).toHaveProperty('presets');
    for (const p of msg.config.profiles) {
      expect(p.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      expect(p).toHaveProperty('hasAuthToken');
    }
    ws.close();
  });

  test('新建 profile → 出现在 snapshot', async () => {
    const ws = await authed();
    const name = uniqueName('test');
    let id: string | undefined;
    try {
      const msg = await request(ws, { type: 'config.profile.save', profile: { name, authToken: 'tok', model: 'gpt' } });
      expect(msg.type).toBe('config.profile.saved');
      const saved = msg.config.profiles.find((p: any) => p.name === name); // by unique name, not position
      expect(saved).toBeDefined();
      expect(saved.env.ANTHROPIC_MODEL).toBe('gpt');
      expect(saved.hasAuthToken).toBe(true);
      id = saved.id;
    } finally {
      if (id) await request(ws, { type: 'config.profile.delete', id });
      ws.close();
    }
  });

  test('删除 profile', async () => {
    const ws = await authed();
    const name = uniqueName('del');
    const saved = await request(ws, { type: 'config.profile.save', profile: { name } });
    const id = saved.config.profiles.find((p: any) => p.name === name).id; // locate by name, not last index
    const deleted = await request(ws, { type: 'config.profile.delete', id });
    expect(deleted.config.profiles.find((p: any) => p.id === id)).toBeUndefined();
    ws.close();
  });

  test('新建 local server', async () => {
    const ws = await authed();
    const name = uniqueName('srv');
    let id: string | undefined;
    try {
      const msg = await request(ws, { type: 'config.server.save', server: { name, kind: 'local' } });
      expect(msg.type).toBe('config.server.saved');
      const saved = msg.config.servers.find((s: any) => s.name === name);
      expect(saved).toBeDefined();
      id = saved.id;
    } finally {
      if (id) await request(ws, { type: 'config.server.delete', id });
      ws.close();
    }
  });

  test('新建 SSH server → password 掩码', async () => {
    const ws = await authed();
    const name = uniqueName('ssh');
    let id: string | undefined;
    try {
      const msg = await request(ws, { type: 'config.server.save', server: { name, kind: 'ssh', host: '1.2.3.4', port: 22, username: 'u', password: 'pw' } });
      const s = msg.config.servers.find((x: any) => x.name === name); // by name, not last index
      expect(s).toBeDefined();
      expect(s.auth.password).toBeUndefined();
      expect(s.auth.hasPassword).toBe(true);
      id = s.id;
    } finally {
      if (id) await request(ws, { type: 'config.server.delete', id });
      ws.close();
    }
  });

  test('新建 preset', async () => {
    const ws = await authed();
    const snap = await request(ws, { type: 'config.get' });
    const serverId = snap.config.servers[0].id;
    const name = uniqueName('preset');
    let id: string | undefined;
    try {
      const msg = await request(ws, { type: 'config.preset.save', preset: { name, serverId, cwd: process.platform === 'win32' ? 'D:\\' : '/tmp' } });
      expect(msg.type).toBe('config.preset.saved');
      id = msg.config.presets.find((p: any) => p.name === name)?.id;
      expect(id).toBeDefined();
    } finally {
      if (id) await request(ws, { type: 'config.preset.delete', id });
      ws.close();
    }
  });

  test('preset 缺 serverId → error', async () => {
    const ws = await authed();
    const msg = await request(ws, { type: 'config.preset.save', preset: { name: 'no-server', cwd: '/tmp' } });
    expect(msg.type).toBe('error');
    ws.close();
  });

  test('preset 缺 cwd → error', async () => {
    const ws = await authed();
    const snap = await request(ws, { type: 'config.get' });
    const serverId = snap.config.servers[0].id;
    const msg = await request(ws, { type: 'config.preset.save', preset: { name: 'no-cwd', serverId } });
    expect(msg.type).toBe('error');
    ws.close();
  });

  test('引用不存在 serverId → error', async () => {
    const ws = await authed();
    const msg = await request(ws, { type: 'config.preset.save', preset: { name: 'bad', serverId: 'nonexistent' } });
    expect(msg.type).toBe('error');
    ws.close();
  });

  test('session.list → 空数组', async () => {
    const ws = await authed();
    const msg = await request(ws, { type: 'session.list' });
    expect(msg.type).toBe('session.list');
    expect(Array.isArray(msg.sessions)).toBe(true);
    ws.close();
  });

  test('launch.cwd.list', async () => {
    const ws = await authed();
    const path = process.platform === 'win32' ? 'C:\\' : '/tmp';
    const msg = await request(ws, { type: 'launch.cwd.list', path, requestId: 'r1', exact: true });
    expect(msg.type).toBe('launch.cwd.list.result');
    expect(msg.requestId).toBe('r1');
    expect(Array.isArray(msg.entries)).toBe(true);
    ws.close();
  });

  test('launch.conda.list', async () => {
    const ws = await authed();
    const msg = await request(ws, { type: 'launch.conda.list', requestId: 'c1' });
    expect(msg.type).toBe('launch.conda.list.result');
    expect(Array.isArray(msg.envs)).toBe(true);
    ws.close();
  });
});

// SSH 测试：通过 TEST_SSH_KEY_PATH 注入私钥路径连接本机
// playwright.config.ts 启动了一个内置 ssh2 测试服务器并设置全部 TEST_SSH_* 环境变量。
test.describe('集成测试 - SSH 连接', () => {
  const sshKey = process.env.TEST_SSH_KEY_PATH!;
  const sshUser = process.env.TEST_SSH_USER!;
  const sshHost = process.env.TEST_SSH_HOST ?? '127.0.0.1';
  const sshPort = Number(process.env.TEST_SSH_PORT ?? 22);

  test('SSH server 保存 → cwd.list via SSH', async () => {
    const ws = await authed();
    const name = uniqueName('localhost-ssh'); // unique so re-runs don't pile up duplicate servers
    let id: string | undefined;
    try {
      const saved = await request(ws, { type: 'config.server.save', server: {
        name, kind: 'ssh', host: sshHost, port: sshPort, username: sshUser, privateKeyPath: sshKey,
      }});
      const server = saved.config.servers.find((s: any) => s.name === name);
      expect(server).toBeDefined();
      id = server.id;

      const result = await request(ws, { type: 'launch.cwd.list', serverId: id, path: process.platform === 'win32' ? 'C:\\' : '/tmp', requestId: 'ssh-r1', exact: true });
      expect(result.type).toBe('launch.cwd.list.result');
      expect(Array.isArray(result.entries)).toBe(true);
    } finally {
      if (id) await request(ws, { type: 'config.server.delete', id });
      ws.close();
    }
  });

  test('SSH conda.list via 本机', async () => {
    const ws = await authed();
    const name = uniqueName('localhost-ssh-conda');
    let id: string | undefined;
    try {
      const saved = await request(ws, { type: 'config.server.save', server: {
        name, kind: 'ssh', host: sshHost, port: sshPort, username: sshUser, privateKeyPath: sshKey,
      }});
      id = saved.config.servers.find((s: any) => s.name === name).id;
      const result = await request(ws, { type: 'launch.conda.list', serverId: id, requestId: 'ssh-c1' });
      expect(result.type).toBe('launch.conda.list.result');
      expect(Array.isArray(result.envs)).toBe(true);
    } finally {
      if (id) await request(ws, { type: 'config.server.delete', id });
      ws.close();
    }
  });
});
