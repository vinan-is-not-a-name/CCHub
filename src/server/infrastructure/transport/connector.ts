import * as pty from 'node-pty';
import * as net from 'net';
import { Client, ClientChannel } from 'ssh2';
import { EventEmitter } from 'events';
import { ProxyTunnel, ServerProfile, SshServerProfile } from '../../../shared/protocol.js';
import { createSshConnection } from './sshFactory.js';
import { buildRemoteEnv } from './remoteEnv.js';
import { ShellAdapter } from '../shell/shellAdapter.js';
import { shellQuote } from '../../utils/shellEscape.js';

export interface ConnectorSpawnArgs {
  /** Compiled shell command (already encoded for the target shell). */
  command: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Local PTY needs the shell adapter to know the executable; SSH does not. */
  shell: ShellAdapter;
  /** SSH reverse tunnel to establish before exec. SSH-only; LocalConnector
   * ignores it. Equivalent to `ssh -R bindPort:host:port`. */
  proxy?: ProxyTunnel;
  /** SSH reverse tunnel for Claude Code hook POSTs back to cc-remote. */
  hookTunnel?: ProxyTunnel;
}

export interface ConnectorChannel extends EventEmitter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Local pid of the process that carries THIS session's I/O on the cchub
   * host, or undefined if there is no such process visible locally. Local
   * sessions return the node-pty child; SSH sessions have no local child (the
   * cc CLI runs on the remote), so they return undefined and the metrics
   * collector reports them as N/A. */
  getPid(): number | undefined;
}

export interface Connector {
  /** Spawn a process/stream that emits 'data' (string), 'exit' (code|null). */
  spawn(args: ConnectorSpawnArgs): ConnectorChannel;
}

export class LocalConnector implements Connector {
  spawn(args: ConnectorSpawnArgs): ConnectorChannel {
    const { file, args: spawnArgs } = args.shell.spawnArgs(args.command);
    const cwd = args.cwd.replace(/\\/g, '/');
    const proc = pty.spawn(file, spawnArgs, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: args.env,
    });
    return new LocalChannel(proc);
  }
}

class LocalChannel extends EventEmitter implements ConnectorChannel {
  private closed = false;
  constructor(private proc: pty.IPty) {
    super();
    proc.onData((data) => this.emit('data', data));
    proc.onExit(({ exitCode }) => {
      this.closed = true;
      this.emit('exit', exitCode);
    });
  }
  write(data: string) { if (!this.closed) try { this.proc.write(data); } catch {} }
  resize(cols: number, rows: number) { if (!this.closed) try { this.proc.resize(cols, rows); } catch {} }
  kill() { try { this.proc.kill(); } catch {} }
  getPid(): number | undefined { return this.closed ? undefined : this.proc.pid; }
}

export class SshConnector implements Connector {
  constructor(private server: SshServerProfile) {}

  spawn(args: ConnectorSpawnArgs): ConnectorChannel {
    const channel = new SshChannel();
    const wrapped = wrapForRemoteShell(this.server, args.command);
    createSshConnection(this.server).then((conn) => {
      conn.on('close', () => channel.emitExit(null));
      setupReverseTunnels(conn, [
        ...(args.proxy ? [{ name: 'proxy', tunnel: args.proxy }] : []),
        ...(args.hookTunnel ? [{ name: 'hook', tunnel: args.hookTunnel }] : []),
      ], channel);
      conn.exec(wrapped, { env: buildRemoteEnv(args.env), pty: { term: 'xterm-256color', cols: args.cols, rows: args.rows } }, (err, stream) => {
        if (err) {
          channel.emit('data', `SSH exec error: ${err.message}\r\n`);
          channel.emitExit(1);
          try { conn.end(); } catch {}
          return;
        }
        channel.attachStream(stream, conn);
      });
    }).catch((error: Error) => {
      channel.emit('data', `SSH connection error: ${error.message}\r\n`);
      channel.emitExit(1);
    });
    return channel;
  }
}

/** Establish SSH reverse tunnels (`ssh -R bindPort:host:port`) before exec. */
function setupReverseTunnels(conn: Client, tunnels: Array<{ name: string; tunnel: ProxyTunnel }>, channel: SshChannel): void {
  if (tunnels.length === 0) return;
  const byPort = new Map(tunnels.map(({ tunnel }) => [tunnel.bindPort, tunnel]));
  conn.on('tcp connection', (info, accept) => {
    const tunnel = byPort.get(info.destPort);
    if (!tunnel) return;
    const ch = accept();
    const sock = net.connect(tunnel.port, tunnel.host);
    ch.on('error', () => { try { sock.destroy(); } catch {} });
    sock.on('error', () => { try { ch.close(); } catch {} });
    ch.pipe(sock);
    sock.pipe(ch);
  });
  for (const { name, tunnel } of tunnels) {
    conn.forwardIn('127.0.0.1', tunnel.bindPort, (err) => {
      if (err) channel.emit('data', `${name} tunnel bind failed on 127.0.0.1:${tunnel.bindPort}: ${err.message}\r\n`);
    });
  }
}

class SshChannel extends EventEmitter implements ConnectorChannel {
  private stream: ClientChannel | null = null;
  private conn: Client | null = null;
  private closed = false;

  attachStream(stream: ClientChannel, conn: Client) {
    this.stream = stream;
    this.conn = conn;
    stream.on('data', (data: Buffer) => this.emit('data', data.toString('utf8')));
    stream.stderr.on('data', (data: Buffer) => this.emit('data', data.toString('utf8')));
    stream.on('close', () => this.emitExit(null));
    stream.on('error', (e: Error) => this.emit('data', `SSH stream error: ${e.message}\r\n`));
  }

  emitExit(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', code);
    try { this.conn?.end(); } catch {}
  }

  write(data: string) { this.stream?.write(data); }
  resize(cols: number, rows: number) { this.stream?.setWindow(rows, cols, 0, 0); }
  kill() {
    try { this.stream?.close(); } catch {}
    try { this.conn?.end(); } catch {}
    this.emitExit(null);
  }
  getPid(): number | undefined { return undefined; }
}

function wrapForRemoteShell(server: SshServerProfile, command: string): string {
  return server.os === 'windows'
    ? `cmd.exe /c ${shellQuote(command)}`
    : `bash -lc ${shellQuote(command)}`;
}

export function makeConnector(server: ServerProfile): Connector {
  return server.kind === 'ssh' ? new SshConnector(server) : new LocalConnector();
}
