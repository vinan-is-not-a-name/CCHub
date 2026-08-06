import { test, expect } from '@playwright/test';
import { requirePlatform } from './support/strictSkip.js';
import * as fs from 'fs';
import { spawn as realSpawn } from 'node-pty';
import { EventEmitter } from 'events';
import {
  LocalConnector,
  bundledConptyDll,
  ConnectorSpawnArgs,
} from '../src/server/infrastructure/transport/connector.js';
import { ShellAdapter } from '../src/server/infrastructure/shell/shellAdapter.js';

/**
 * Regression for the invisible-bold bug — and, upstream of it, for the whole
 * class of "same code, same cc version, different machine, different rendering"
 * failures.
 *
 * Root cause, byte-verified on two hosts with one fixed input: Windows' built-in
 * ConPTY does not forward the child's bytes, it re-serialises them, and the
 * rewrite differs per OS build. conhost 10.0.19041.4522 (Win10 19045) turns a
 * bare `CSI 1m` into `CSI 1m CSI 97m` — its attribute model reads bold as
 * "brighten the foreground", and brightWhite on a light xterm theme is
 * invisible. The same conhost also drops `CSI 2m`, rewrites `CSI 7m` to
 * `CSI 30m CSI 47m`, and swallows `?1049h`. conhost 10.0.26100.7306 (Win11)
 * forwards all of it untouched. No cc setting can affect this: the rewrite
 * happens after cc has written and before cc-remote reads.
 *
 * LocalConnector therefore prefers the far newer conpty.dll node-pty ships,
 * which is effectively pass-through. These tests pin the two properties that
 * matter: the dll is actually selected when present, and a spawn is still
 * produced when it isn't.
 */

/** Runs the compiled command straight through, no shell wrapper — keeps the
 * assertion about ConPTY, not about cmd.exe quoting. */
const passthroughShell: ShellAdapter = {
  compile: () => '',
  spawnArgs: (command: string) => ({ file: process.execPath, args: ['-e', command] }),
};

function spawnArgsFor(script: string): ConnectorSpawnArgs {
  return {
    command: script,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    cols: 120,
    rows: 40,
    shell: passthroughShell,
  };
}

/** node -e payload emitting a bare bold run, then idling briefly so ConPTY has
 * a chance to flush its own re-serialisation before the child exits. */
const EMIT_BOLD = `process.stdout.write('<S>\\x1b[1mAA\\x1b[22m<E>'); setTimeout(()=>process.exit(0), 400);`;

/** Enough of node-pty's IPty for LocalChannel's constructor to wire up. */
function fakePty() {
  const emitter = new EventEmitter();
  return {
    pid: 1234,
    onData: (cb: (d: string) => void) => emitter.on('data', cb),
    onExit: (cb: (e: { exitCode: number }) => void) => emitter.on('exit', cb),
    write: () => {},
    resize: () => {},
    kill: () => {},
  } as never;
}

function collect(args: ConnectorSpawnArgs, connector: LocalConnector): Promise<string> {
  return new Promise((resolve) => {
    const channel = connector.spawn(args);
    let out = '';
    channel.on('data', (d: string) => { out += d; });
    channel.on('exit', () => resolve(out));
  });
}

test.describe('LocalConnector ConPTY selection', () => {
  test('bundled conpty.dll is present in the installed node-pty on win32', () => {
    const dll = bundledConptyDll();
    if (process.platform !== 'win32') {
      expect(dll).toBeNull();
      return;
    }
    // If this ever goes null on Windows, every session silently drops back to
    // the rewriting system ConPTY — which is the bug, not a degraded mode.
    expect(dll).not.toBeNull();
    expect(fs.existsSync(dll as string)).toBe(true);
  });

  test('a bare CSI 1m survives to the consumer, not folded into brightWhite', async () => {
    const out = await collect(spawnArgsFor(EMIT_BOLD), new LocalConnector());
    const between = out.slice(out.indexOf('<S>'), out.indexOf('<E>') + 3);
    expect(between).toContain('\x1b[1m');
    // The Win10 conhost signature. Asserted on every platform: on POSIX it can
    // never appear, on Windows it appears only if the system ConPTY got used.
    //
    // Measured limitation, so nobody reads more into a green than it carries:
    // this assertion is VACUOUS on Win11 26100. Probed on conhost
    // 10.0.26100.7306 with this exact input through both paths, the SGR run came
    // back byte-identical either way — `CSI 1m`/`2m`/`7m` all preserved, no
    // `97m`. It can only go red on a host whose conhost rewrites, i.e. the
    // Win10 19045 box this bug was reported from. The test below is the part
    // that has teeth on both.
    expect(between).not.toContain('\x1b[97m');
  });

  test('the system ConPTY injects screen control the child never wrote', async () => {
    requirePlatform('win32', 'ConPTY is a Windows API');
    // Differential, and it bites on Win11 where the SGR assertion above cannot.
    // Same input, same machine, the two ConPTY paths compared against each
    // other rather than against a sequence I predicted.
    //
    // Measured on conhost 10.0.26100.7306 — the system ConPTY prepends
    // `?25l 2J m H` and appends an `OSC 0` title plus `?25h`, 114 bytes against
    // the bundled dll's 62 for a 25-byte payload. Two of those matter beyond
    // byte count: `CSI 2J` erases the screen the client is restoring a snapshot
    // onto, and the OSC 0 title carries the child executable's absolute path, so
    // the host injects a filesystem path into a stream cc never wrote.
    const withDll = await collect(spawnArgsFor(EMIT_BOLD), new LocalConnector());

    const systemOnly = new LocalConnector({
      // Force the fallback the way a missing/broken dll would, without touching
      // the installed node-pty.
      spawnPty: ((f: string, a: string[] | string, o: Record<string, unknown>) => {
        if (o.useConptyDll) throw new Error('probe: simulate a dll that will not load');
        return realSpawn(f, a as string[], o as never);
      }) as never,
      onNotice: () => {},
    });
    const withSystem = await collect(spawnArgsFor(EMIT_BOLD), systemOnly);

    // Both must deliver the payload — the fallback works, that is its job.
    expect(withDll, 'bundled dll lost the payload').toContain('<S>');
    expect(withSystem, 'system ConPTY lost the payload').toContain('<S>');

    // The bundled dll is pass-through: no erase, no title injection.
    expect(withDll, 'bundled dll must not erase the screen').not.toContain('\x1b[2J');
    expect(withDll, 'bundled dll must not inject a title').not.toContain('\x1b]0;');

    // And the system path is measurably not pass-through, which is why the dll
    // is preferred. If a future Windows build stops rewriting, this flips and
    // the finding is that the workaround is no longer load-bearing — worth
    // knowing either way.
    const systemInjects = withSystem.includes('\x1b[2J') || withSystem.includes('\x1b]0;');
    expect(systemInjects, 'system ConPTY unexpectedly matched the dll — re-measure before trusting it').toBe(true);
    expect(withSystem.length, 'system ConPTY should be the wordier path').toBeGreaterThan(withDll.length);
  });

  test('useConptyDll is requested when the dll exists', () => {
    requirePlatform('win32', 'ConPTY is a Windows API');
    const seen: Array<Record<string, unknown>> = [];
    const connector = new LocalConnector({
      spawnPty: ((_f: string, _a: string[] | string, o: Record<string, unknown>) => {
        seen.push(o);
        return fakePty();
      }) as never,
    });
    connector.spawn(spawnArgsFor(EMIT_BOLD));
    expect(seen).toHaveLength(1);
    expect(seen[0].useConptyDll).toBe(true);
  });

  test('a throwing dll spawn falls back to the system ConPTY and says so', () => {
    requirePlatform('win32', 'ConPTY is a Windows API');
    const notices: string[] = [];
    const attempts: Array<Record<string, unknown>> = [];
    const connector = new LocalConnector({
      onNotice: (m) => notices.push(m),
      spawnPty: ((_f: string, _a: string[] | string, o: Record<string, unknown>) => {
        attempts.push(o);
        if (o.useConptyDll) throw new Error('LoadLibrary conpty.dll failed');
        return fakePty();
      }) as never,
    });

    // Must not throw: a broken experimental dll cannot take sessions down.
    const channel = connector.spawn(spawnArgsFor(EMIT_BOLD));
    expect(channel).toBeTruthy();
    expect(attempts).toHaveLength(2);
    expect(attempts[0].useConptyDll).toBe(true);
    expect(attempts[1].useConptyDll).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('falling back to the system one');
    expect(notices[0]).toContain('LoadLibrary conpty.dll failed');
  });
});
