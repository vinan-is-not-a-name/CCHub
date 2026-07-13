import { test, expect } from '@playwright/test';
import {
  MetricsCollector,
  parseWin32ProcessCsv,
  aggregateProcessTree,
  treeCpuPct,
  type ProcessSample,
} from '../src/server/infrastructure/metrics/metricsCollector.js';

// parseWin32ProcessCsv locks the shape of `Get-CimInstance Win32_Process |
// Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,
// UserModeTime | ConvertTo-Csv -NoTypeInformation`. This replaced an
// earlier Get-Process probe that couldn't return the parent pid — without
// the ppid we couldn't walk the process tree, and each session pill
// reported only the pty-bridge process (~8 MB) instead of the full CLI
// tree beneath it (hundreds of MB).

test.describe('parseWin32ProcessCsv', () => {
  test('parses the standard 5-column ConvertTo-Csv response', () => {
    // Real shape captured from Win32_Process on Windows 11: header row +
    // quoted cells + Kernel/User times as UInt64 100ns FILETIME ticks.
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"',
      '"13220","12800","52428800","1200000","2200000"',
    ].join('\r\n');
    const rows = parseWin32ProcessCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: 13220,
      ppid: 12800,
      // Already in 100ns ticks, no unit conversion — kernel + user summed.
      cpuTicks: 3_400_000,
      memBytes: 52_428_800,
    });
  });

  test('batches every process on the host in one CSV', () => {
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"',
      '"1234","1000","1000","0","1000000"',
      '"5678","1234","2000","500000","1000000"',
      '"9999","1","500","0","0"',
    ].join('\r\n');
    const rows = parseWin32ProcessCsv(csv);
    expect(rows.map(r => r.pid).sort()).toEqual([1234, 5678, 9999]);
    const byPid = new Map(rows.map(r => [r.pid, r]));
    expect(byPid.get(5678)!.ppid).toBe(1234);
    expect(byPid.get(5678)!.cpuTicks).toBe(1_500_000);
    expect(byPid.get(5678)!.memBytes).toBe(2000);
  });

  test('robust to LF-only line endings', () => {
    // ConvertTo-Csv emits CRLF by default but a pipeline handling the
    // child stdout might rewrite line endings; parser shouldn't care.
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"',
      '"42","1","4096","5000000","0"',
    ].join('\n');
    expect(parseWin32ProcessCsv(csv)).toEqual([
      { pid: 42, ppid: 1, cpuTicks: 5_000_000, memBytes: 4096 },
    ]);
  });

  test('returns empty on an empty / header-only response', () => {
    // If CIM returns nothing (unusual but possible on a broken WMI service)
    // we get just the header — parser must not blow up on that.
    expect(parseWin32ProcessCsv('')).toEqual([]);
    expect(parseWin32ProcessCsv('"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"')).toEqual([]);
    expect(parseWin32ProcessCsv('   \r\n  ')).toEqual([]);
  });

  test('treats empty Kernel/User cells as 0', () => {
    // A process that just spawned has no accumulated CPU time yet; CIM
    // may render KernelModeTime / UserModeTime as blank. Must map to 0
    // rather than NaN so downstream delta math stays finite.
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"',
      '"1234","1","1000","",""',
    ].join('\r\n');
    expect(parseWin32ProcessCsv(csv)).toEqual([
      { pid: 1234, ppid: 1, cpuTicks: 0, memBytes: 1000 },
    ]);
  });

  test('parses when Select-Object reorders columns', () => {
    // A future PowerShell could reorder Select-Object's output. Header-
    // name-indexed parsing guarantees the values line up regardless.
    const csv = [
      '"KernelModeTime","UserModeTime","ParentProcessId","ProcessId","WorkingSetSize"',
      '"2000000","0","1","77","8192"',
    ].join('\r\n');
    expect(parseWin32ProcessCsv(csv)).toEqual([
      { pid: 77, ppid: 1, cpuTicks: 2_000_000, memBytes: 8192 },
    ]);
  });

  test('skips rows with an invalid ProcessId or ParentProcessId', () => {
    // Bad rows must not silently poison the tree with NaN. Row with a
    // non-numeric pid is dropped; the following valid row survives.
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"',
      '"notapid","1","1000","0","0"',
      '"42","notappid","4096","5000000","0"',
      '"77","1","4096","6000000","0"',
    ].join('\r\n');
    expect(parseWin32ProcessCsv(csv)).toEqual([
      { pid: 77, ppid: 1, cpuTicks: 6_000_000, memBytes: 4096 },
    ]);
  });
});

// aggregateProcessTree is the core of the "attribute cost to the whole
// session, not just the pty bridge" fix. Locked here in isolation from
// CSV parsing so a break in either half is diagnostic.

test.describe('aggregateProcessTree', () => {
  const mk = (pid: number, ppid: number, memBytes: number): ProcessSample =>
    ({ pid, ppid, cpuTicks: 0, memBytes });

  test('returns only the root when there are no children', () => {
    const rows = [mk(100, 1, 10 * 1024 * 1024)];
    const trees = aggregateProcessTree(rows, [100]);
    expect(trees.size).toBe(1);
    expect(trees.get(100)).toEqual({
      members: [100],
      memBytes: 10 * 1024 * 1024,
    });
  });

  test('aggregates RSS across every descendant', () => {
    // Realistic-ish cchub shape: root=pty-bridge (tiny), child=shell
    // (small), grandchild=claude CLI (big). Before this fix the pill
    // showed only the root's ~8 MB; it should now report the sum.
    const rows = [
      mk(100, 1, 8 * 1024 * 1024),      // pty bridge
      mk(200, 100, 12 * 1024 * 1024),   // shell
      mk(300, 200, 480 * 1024 * 1024),  // claude CLI (the real cost)
    ];
    const trees = aggregateProcessTree(rows, [100]);
    const t = trees.get(100)!;
    expect(new Set(t.members)).toEqual(new Set([100, 200, 300]));
    expect(t.memBytes).toBe((8 + 12 + 480) * 1024 * 1024);
  });

  test('aggregates multiple roots independently', () => {
    // Two live sessions. Each gets its own tree; a child of one root is
    // NOT accidentally summed into the other.
    const rows = [
      mk(100, 1, 10),
      mk(101, 100, 20),
      mk(200, 1, 30),
      mk(201, 200, 40),
    ];
    const trees = aggregateProcessTree(rows, [100, 200]);
    expect(trees.get(100)!.memBytes).toBe(30);
    expect(trees.get(200)!.memBytes).toBe(70);
  });

  test('omits a root that is not in the snapshot rows', () => {
    // Root died between snapshotPids() and the CIM query — session is
    // reported as absent (caller renders N/A) rather than as a zero.
    const rows = [mk(100, 1, 10)];
    const trees = aggregateProcessTree(rows, [999]);
    expect(trees.has(999)).toBe(false);
  });

  test('breaks pid-ppid cycles safely', () => {
    // Windows quirk: pid=0 (System Idle) has ppid=0, and pid reuse can
    // occasionally produce a stale ppid pointing to a descendant. The
    // BFS carries a visited set so a cycle terminates instead of hanging.
    const rows = [
      mk(10, 20, 5),
      mk(20, 10, 7),
    ];
    const trees = aggregateProcessTree(rows, [10]);
    const t = trees.get(10)!;
    expect(new Set(t.members)).toEqual(new Set([10, 20]));
    expect(t.memBytes).toBe(12);
  });

  test('self-parenting root does not infinite-loop', () => {
    // System Idle Process (pid=0 ppid=0). We guard by ignoring self-
    // parenting edges when building the children map.
    const rows = [mk(0, 0, 0)];
    const trees = aggregateProcessTree(rows, [0]);
    expect(trees.get(0)).toEqual({ members: [0], memBytes: 0 });
  });
});

// treeCpuPct is the delta+normalization math behind the pill's CPU number.
// It's the piece the "shows >100% and disagrees with Task Manager" bug lived
// in: the value is normalized to 0..100 across all cores (Task Manager scale)
// and divided by each pid's REAL elapsed wall time so a late tick can't
// inflate it. Locked here without a real OS probe.

test.describe('treeCpuPct', () => {
  // Windows FILETIME: 10_000 100ns-ticks per ms. A pid that consumed one
  // full core for `ms` milliseconds accrues `ms * WIN_TICKS_PER_MS` ticks.
  const WIN_TICKS_PER_MS = 10_000;
  const now = 1_000_000;
  const row = (pid: number, cpuTicks: number): ProcessSample => ({ pid, ppid: 1, cpuTicks, memBytes: 0 });
  const rowsMap = (...rs: ProcessSample[]) => new Map(rs.map(r => [r.pid, r]));

  test('one full core over the window reads (100 / cores)% — Task Manager scale', () => {
    // 2000ms of CPU across a 2000ms window = one full core. On 8 cores
    // Task Manager shows that process as 12.5%, not 100%.
    const prev = new Map([[100, { cpuTicks: 0, ts: now - 2000 }]]);
    const rows = rowsMap(row(100, 2000 * WIN_TICKS_PER_MS));
    expect(treeCpuPct([100], rows, prev, now, WIN_TICKS_PER_MS, 8)).toBeCloseTo(12.5, 5);
  });

  test('a delayed tick does not inflate the reading (the >100% spike bug)', () => {
    // Same one-full-core of CPU (2000ms), but the tick fired late so 4000ms
    // of wall time actually elapsed → only HALF a core of real load. Dividing
    // by the real 4000ms gives 6.25% on 8 cores; the old code divided by a
    // nominal 2000ms and would have doubled it to 12.5% (and worse on longer
    // stalls, which is how the pill blew past 100%).
    const prev = new Map([[100, { cpuTicks: 0, ts: now - 4000 }]]);
    const rows = rowsMap(row(100, 2000 * WIN_TICKS_PER_MS));
    expect(treeCpuPct([100], rows, prev, now, WIN_TICKS_PER_MS, 8)).toBeCloseTo(6.25, 5);
  });

  test('sums every pid in the tree, then normalizes once', () => {
    // Two pids each burning a full core over the window = 2 of 4 cores = 50%.
    const prev = new Map([
      [100, { cpuTicks: 0, ts: now - 2000 }],
      [200, { cpuTicks: 0, ts: now - 2000 }],
    ]);
    const rows = rowsMap(row(100, 2000 * WIN_TICKS_PER_MS), row(200, 2000 * WIN_TICKS_PER_MS));
    expect(treeCpuPct([100, 200], rows, prev, now, WIN_TICKS_PER_MS, 4)).toBeCloseTo(50, 5);
  });

  test('a pid with no previous baseline contributes 0 (first sighting)', () => {
    // No prev entry → the pid was just discovered this tick; it must read 0,
    // not a spike computed against process start.
    const rows = rowsMap(row(300, 5_000_000));
    expect(treeCpuPct([300], rows, new Map(), now, WIN_TICKS_PER_MS, 4)).toBe(0);
  });

  test('a backwards tick delta (Windows pid-reuse) clamps to 0, never negative', () => {
    // A dying pid's slot handed to a fresh process makes cpuTicks appear to
    // drop. That must contribute 0 rather than a negative that eats a
    // sibling's real usage.
    const prev = new Map([[100, { cpuTicks: 5_000_000, ts: now - 2000 }]]);
    const rows = rowsMap(row(100, 1_000_000));
    expect(treeCpuPct([100], rows, prev, now, WIN_TICKS_PER_MS, 4)).toBe(0);
  });

  test('Linux jiffy scale (0.1 ticks/ms) normalizes the same way', () => {
    // 1 jiffy = 10ms (CLK_TCK=100) → 0.1 jiffies/ms. 200 jiffies over 2000ms
    // wall = one full core = 25% on a 4-core host.
    const prev = new Map([[100, { cpuTicks: 0, ts: now - 2000 }]]);
    const rows = rowsMap(row(100, 200));
    expect(treeCpuPct([100], rows, prev, now, 0.1, 4)).toBeCloseTo(25, 5);
  });
});

// Collector semantics: what `tick()` produces WITHOUT going near CIM /proc.
// FakeManager returns a fixed roster; tests inspect the snapshot. Paths
// through the OS probe (Windows CIM spawn, Linux /proc read) are only
// exercised implicitly when a session pid is present — the specs
// deliberately use SSH or an impossibly large pid to keep the local
// path from taking a real CPU sample the assertion depends on.

class FakeManager {
  constructor(private roster: { id: string; label: string; presetName?: string; pid: number | undefined }[]) {}
  snapshotPids() { return this.roster; }
}

test.describe('MetricsCollector.tick', () => {
  test('emits a snapshot with main process metrics on a fresh start', async () => {
    const manager = new FakeManager([]) as any;
    const collector = new MetricsCollector(manager);
    const snap = await collector.tick();
    expect(snap.sessions).toEqual([]);
    expect(snap.main.memBytes).toBeGreaterThan(0); // Node RSS is always > 0
    expect(typeof snap.main.cpuPct).toBe('number');
    expect(snap.cpuCount).toBeGreaterThan(0);
    expect(snap.memTotalBytes).toBeGreaterThan(0);
  });

  test('SSH-style session (pid=undefined) is surfaced as N/A (null cpu/mem)', async () => {
    // The metrics contract says: `pid: null` means "no local pid to
    // sample" (SSH). The widget renders this as "N/A (remote)".
    const manager = new FakeManager([
      { id: 's-ssh', label: 'edge-remote', pid: undefined },
    ]) as any;
    const collector = new MetricsCollector(manager);
    const snap = await collector.tick();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toEqual({
      id: 's-ssh',
      label: 'edge-remote',
      pid: null,
      cpuPct: null,
      memBytes: null,
    });
  });

  test('local session pid that the probe cannot reach still surfaces (null cpu/mem)', async () => {
    // A pid that doesn't exist on the host (impossibly large). The
    // whole-system snapshot won't contain it, aggregateProcessTree
    // returns no entry, and the session must appear with null cpu/mem
    // rather than being dropped from the roster — the tooltip stays
    // informative on a dead session instead of the row silently vanishing.
    const impossiblePid = 999_999_999;
    const manager = new FakeManager([
      { id: 's-dead', label: 'zombie', pid: impossiblePid },
    ]) as any;
    const collector = new MetricsCollector(manager);
    const snap = await collector.tick();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]!.id).toBe('s-dead');
    expect(snap.sessions[0]!.pid).toBe(impossiblePid);
    expect(snap.sessions[0]!.cpuPct).toBe(null);
    expect(snap.sessions[0]!.memBytes).toBe(null);
  });

  test('back-to-back tick() invocations both succeed (no first-tick priming bug)', async () => {
    // Regression fence: an earlier draft had a null-baseline for
    // process.cpuUsage() on the first tick which made cpuPct come back
    // as NaN. The pill contract requires cpuPct is always a finite
    // number for `main` (only per-session cpu can be null).
    const collector = new MetricsCollector(new FakeManager([]) as any);
    const first = await collector.tick();
    const second = await collector.tick();
    expect(Number.isFinite(first.main.cpuPct)).toBe(true);
    expect(Number.isFinite(second.main.cpuPct)).toBe(true);
    expect(first.main.cpuPct).toBeGreaterThanOrEqual(0);
    expect(second.main.cpuPct).toBeGreaterThanOrEqual(0);
  });

  test('total = main + sum(sessions) — SSH contributes 0 without breaking math', async () => {
    // Two SSH sessions (pid null) contribute 0 to the totals — verifies
    // the reducer's `?? 0` fallback and that the total still equals main.
    const manager = new FakeManager([
      { id: 's1', label: 'a', pid: undefined },
      { id: 's2', label: 'b', pid: undefined },
    ]) as any;
    const collector = new MetricsCollector(manager);
    const snap = await collector.tick();
    expect(snap.total.memBytes).toBe(snap.main.memBytes);
    expect(snap.total.cpuPct).toBeCloseTo(snap.main.cpuPct, 6);
  });

  test('getLatest returns the most recent snapshot after tick()', async () => {
    // Priming path: a newly-attached ws client asks for the cached snapshot
    // so the pill doesn't stay blank for 2s. Must be the SAME object the
    // last tick emitted, not a stale null.
    const collector = new MetricsCollector(new FakeManager([]) as any);
    expect(collector.getLatest()).toBeNull();
    const snap = await collector.tick();
    expect(collector.getLatest()).toBe(snap);
  });

  test('prefers preset name over server:cwd path when the launch had a preset', async () => {
    // Row primary name uses the preset (a friendly handle); the raw
    // `${server}:${cwd}` demotes to `sub` so the popover can surface it
    // as a hover tooltip without cluttering the visible line.
    const manager = new FakeManager([
      { id: 's1', label: 'edge-local:D:\\projects\\web', presetName: 'my-preset', pid: undefined },
    ]) as any;
    const collector = new MetricsCollector(manager);
    const snap = await collector.tick();
    expect(snap.sessions[0]!.label).toBe('my-preset');
    expect(snap.sessions[0]!.sub).toBe('edge-local:D:\\projects\\web');
  });

  test('falls back to server:cwd in label with no sub when no preset name is set', async () => {
    // Without a preset the label from snapshotPids IS the path, and
    // there's nothing extra to surface — sub must be undefined (echoing
    // the primary line into the tooltip would be useless noise).
    const manager = new FakeManager([
      { id: 's1', label: 'edge-local:D:\\projects\\web', pid: undefined },
    ]) as any;
    const collector = new MetricsCollector(manager);
    const snap = await collector.tick();
    expect(snap.sessions[0]!.label).toBe('edge-local:D:\\projects\\web');
    expect(snap.sessions[0]!.sub).toBeUndefined();
  });
});
