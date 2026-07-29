import * as pty from 'node-pty';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { StringDecoder } from 'string_decoder';
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

/** Absolute path to the conpty.dll node-pty ships, or null if it isn't there
 * (non-Windows install, pruned package, unresolvable module). */
export function bundledConptyDll(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = require_.resolve('node-pty/package.json');
    const dll = path.join(path.dirname(pkg), 'build', 'Release', 'conpty', 'conpty.dll');
    return fs.existsSync(dll) ? dll : null;
  } catch {
    return null;
  }
}

export interface LocalConnectorDeps {
  /** Defaults to a real warning rather than a no-op: silently degrading to the
   * rewriting ConPTY is the failure this whole path exists to make visible.
   * Nothing else in infrastructure/ imports the entry logger, so this stays on
   * console. Injectable so the fallback is assertable. */
  onNotice?: (message: string) => void;
  /** Seam for the fallback test — a bad conpty.dll can only be simulated by
   * making the useConptyDll spawn throw. Defaults to node-pty. */
  spawnPty?: typeof pty.spawn;
}

/** Windows ships a conhost whose ConPTY rewrites the child's byte stream on the
 * way out, and how it rewrites depends on the OS build. Measured with one fixed
 * input on two hosts: conhost 10.0.19041.4522 (Win10 19045) folds a bare
 * `CSI 1m` into `CSI 1m CSI 97m` because its attribute model reads bold as
 * "brighten the foreground" — and brightWhite on a light xterm theme is
 * invisible. That same conhost also drops `CSI 2m` (dim), rewrites `CSI 7m`
 * (reverse) to a hardcoded `CSI 30m CSI 47m`, swallows `?1049h` (alt screen,
 * which the snapshot-restore path in client/terminal.ts assumes cc has on), and
 * detaches OSC 8 hyperlinks from the text they wrap. conhost 10.0.26100.7306
 * (Win11) forwards all of it untouched. Nothing cc is configured with can
 * affect this: the rewrite happens after cc writes and before cc-remote reads.
 *
 * node-pty ships its own, far newer conpty.dll that is effectively
 * pass-through. With it, that same fixed input produced byte-identical output
 * on both hosts (sha256 86a3407d…b40cd0, 260 bytes, against the system path's
 * 458 on Win10 and 774 on Win11) — the host difference is removed rather than
 * compensated for. So prefer it whenever it is present, and let the terminal
 * layer see what cc actually wrote.
 *
 * `useConptyDll` is flagged EXPERIMENTAL upstream, so it must not become a
 * single point of failure: if the dll is absent, or the spawn throws with it,
 * fall back to the system ConPTY and say which path was taken. */
export class LocalConnector implements Connector {
  private onNotice: (message: string) => void;
  private spawnPty: typeof pty.spawn;

  constructor(deps: LocalConnectorDeps = {}) {
    this.onNotice = deps.onNotice ?? ((m) => console.warn(m));
    this.spawnPty = deps.spawnPty ?? pty.spawn;
  }

  spawn(args: ConnectorSpawnArgs): ConnectorChannel {
    const { file, args: spawnArgs } = args.shell.spawnArgs(args.command);
    const cwd = args.cwd.replace(/\\/g, '/');
    const base = {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: args.env,
    };
    const dll = bundledConptyDll();
    if (dll) {
      try {
        return new LocalChannel(this.spawnPty(file, spawnArgs, { ...base, useConptyDll: true }));
      } catch (error) {
        // Experimental path failed — the session still has to start.
        this.onNotice(
          `bundled ConPTY (${dll}) failed, falling back to the system one: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return new LocalChannel(this.spawnPty(file, spawnArgs, base));
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

export class SshChannel extends EventEmitter implements ConnectorChannel {
  private stream: ClientChannel | null = null;
  private conn: Client | null = null;
  private closed = false;
  // ssh2 emits raw Buffers sliced at TCP/packet boundaries, which can fall in
  // the middle of a multibyte UTF-8 char. Decoding each Buffer independently
  // yields U+FFFD for the split halves, which then corrupts cc's column-width
  // math and strands ghost text. StringDecoder holds the incomplete tail bytes
  // until the continuation arrives. stdout and stderr are independent byte
  // streams, so each needs its own decoder.
  private outDecoder = new StringDecoder('utf8');
  private errDecoder = new StringDecoder('utf8');

  attachStream(stream: ClientChannel, conn: Client) {
    this.stream = stream;
    this.conn = conn;
    stream.on('data', (data: Buffer) => this.emit('data', this.outDecoder.write(data)));
    stream.stderr.on('data', (data: Buffer) => this.emit('data', this.errDecoder.write(data)));
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
