import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { cpus, totalmem } from 'os';
import { readFileSync, readdirSync } from 'fs';
import type { SessionManager } from '../../application/session.js';

/** One row of the outbound broadcast — units chosen so the client renders
 * without touching them:
 *  - `cpuPct` is 0..100, normalized across ALL host cores exactly the way
 *    Task Manager reports per-process CPU: 100% means every core is pegged,
 *    and a single fully-busy core on an 8-core box reads ~12.5%. An earlier
 *    version sent raw core-percent (0..100*cpuCount, up to 800% on 8 cores)
 *    which didn't line up with Task Manager and routinely showed >100% — a
 *    confusing "is this broken?" number. `total.cpuPct` therefore stays
 *    within 0..100 (modulo negligible sampling skew).
 *  - `memBytes` is the aggregate RSS in bytes for the WHOLE process tree
 *    rooted at the session pid: the pty-bridge process, its shell, the
 *    Claude CLI node process it spawned, and any subagents that CLI
 *    started. Sampling the pty-bridge pid alone (what an earlier draft
 *    did) reported ~8 MB and hid the real cost of a session — the bridge
 *    itself is tiny, everything user-visible lives in its descendants.
 *  - `pid` is `null` for SSH sessions (no local process to sample).
 *
 * Sample cadence is 2s (see MetricsCollector.INTERVAL_MS). At 5–10 open
 * sessions the message body is ~500 bytes; broadcasting to every connected
 * browser is cheap. */
export interface MetricsSnapshot {
  /** ms epoch when this sample was taken; useful for freshness gating. */
  ts: number;
  /** CPUs the host reports — sent so the widget can show a "N cores" hint
   * in the tooltip. `cpuPct` is ALREADY normalized by this on the server,
   * so the client renders it directly without dividing. */
  cpuCount: number;
  /** Physical RAM total in bytes — the widget can render "1.2 GB / 32 GB"
   * if it wants. Sent every sample (constant, but cheap and lets the client
   * skip a separate probe). */
  memTotalBytes: number;
  /** Total = cchub main process + every LOCAL session's whole process tree.
   * SSH sessions contribute 0 (their work happens on the remote). */
  total: { cpuPct: number; memBytes: number };
  /** cchub Node process itself — split from total so the widget can show
   * "server: 40MB, sessions: 320MB" if we ever want that; currently the
   * widget just sums, but keeping the split preserves optionality. */
  main: { cpuPct: number; memBytes: number };
  sessions: {
    id: string;
    /** Human-readable session name — preset name when the launch had one,
     * otherwise falls back to `${server}:${cwd}` so a preset-less session
     * still shows something identifying. */
    label: string;
    /** Subordinate detail (typically the raw `${server}:${cwd}` path) when
     * `label` is a preset name; undefined when the two would be identical.
     * The client renders this as a hover tooltip on the row name, not a
     * second visible line — keeps the popover compact. */
    sub?: string;
    pid: number | null;
    /** `null` when no local process (SSH), or when the pid died between
     * sample scheduling and probe read. */
    cpuPct: number | null;
    memBytes: number | null;
  }[];
}

/** Per-pid sample state carried across ticks. CPU% is a delta so every pid
 * we see gets its own baseline — a pid that appears mid-session (Claude
 * spawning a subagent) gets a proper zero on its first sample rather than
 * an artificial spike computed against the tree's earlier state. */
interface PidSample {
  /** 100ns FILETIME ticks on Windows; user+sys jiffies on Linux. */
  cpuTicks: number;
  /** ms wall clock of when this sample was taken; the next tick uses it
   *  as the denominator for cpu%. */
  ts: number;
}

/** One row of a whole-system process snapshot. Windows fills these from
 *  `Get-CimInstance Win32_Process`; Linux from `/proc/<pid>/stat`. The
 *  ppid field is what lets the collector expand each session root into
 *  the tree of descendants that shares a session's real cost. */
export interface ProcessSample {
  pid: number;
  ppid: number;
  /** 100ns FILETIME ticks on Windows, jiffies on Linux. Aggregation is
   *  additive within a single platform; the platform-specific tick→ms
   *  conversion happens in the delta math below, not here. */
  cpuTicks: number;
  memBytes: number;
}

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/** Aggregates cchub-host process metrics and broadcasts a snapshot on a
 * fixed cadence. Not per-connection — one shared collector serves every
 * attached browser. The rate is deliberately modest (5s feels sluggish;
 * 2s is the sweet spot where the widget looks live and the sampler is
 * under a percent of background CPU on the host).
 *
 * Emits `snapshot` (MetricsSnapshot) after each successful tick. A tick
 * that fails to probe children (CIM missing, /proc unavailable, etc.)
 * still emits — main process + N/A children — so the widget doesn't
 * mysteriously go blank on a degraded host.
 *
 * Windows sampling uses one `Get-CimInstance Win32_Process` invocation
 * per tick to snapshot the WHOLE system (typically 200–500 processes
 * on a workstation); the CSV lists (ProcessId, ParentProcessId, WS,
 * KernelModeTime, UserModeTime) and the collector expands each session
 * pid into its descendant tree locally. Full-system was chosen over the
 * layered BFS `WHERE ParentProcessId IN (...)` because one PowerShell
 * spawn is cheaper than 3–4 (typical tree depth), and CIM's per-invoke
 * WMI init dominates over the extra rows.
 *
 * Linux does the equivalent by reading every `/proc/<pid>/stat` once;
 * proc files are virtual and complete in tens of microseconds, so full
 * scan is <5 ms even on a busy host.
 *
 * Main-process CPU comes from `process.cpuUsage()` and RSS from
 * `process.memoryUsage().rss`, so the cchub Node process itself doesn't
 * need an external probe. Its children (pty bridges) are NOT double-
 * counted in `main` — they're attributed to their owning session's
 * tree, whose root is the pty bridge pid. */
export class MetricsCollector extends EventEmitter {
  static readonly INTERVAL_MS = 2000;
  private timer: NodeJS.Timeout | null = null;
  private lastMainCpu = process.cpuUsage();
  private lastMainTs = Date.now();
  private samples = new Map<number, PidSample>();
  private latest: MetricsSnapshot | null = null;
  private readonly cpuCount = Math.max(1, cpus().length);
  private readonly memTotal = totalmem();

  constructor(private readonly manager: SessionManager) { super(); }

  /** Latest snapshot for a newly-connecting client so it doesn't stare at
   * an empty pill for up to `INTERVAL_MS` before the next tick. `null`
   * until the first tick completes (~2s after start()). */
  getLatest(): MetricsSnapshot | null { return this.latest; }

  start(): void {
    if (this.timer) return;
    // Prime the CPU baseline so the FIRST snapshot has a defined delta.
    // Without this, the initial tick would compute cpuPct against
    // process-start, giving a bogus one-off high number.
    this.lastMainCpu = process.cpuUsage();
    this.lastMainTs = Date.now();
    void this.tick().catch(() => { /* first tick fail is non-fatal */ });
    this.timer = setInterval(() => {
      void this.tick().catch(() => { /* keep the loop alive */ });
    }, MetricsCollector.INTERVAL_MS);
    // `unref` so the collector doesn't keep the Node event loop alive on
    // its own — cchub's ws server / http server are what should hold the
    // process open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Emit ONE sample. Split from start() so tests can drive the loop
   * deterministically without waiting real time. */
  async tick(): Promise<MetricsSnapshot> {
    const now = Date.now();

    // ── Main cchub process ───────────────────────────────────────────
    const cpuUsage = process.cpuUsage(this.lastMainCpu); // μs since last
    const dtMs = now - this.lastMainTs;
    this.lastMainCpu = process.cpuUsage(); // absolute since process start
    this.lastMainTs = now;
    // cpuUsage.user/system are microseconds of CPU time; convert to a
    // fraction of the wall interval, then divide by core count so the
    // result is 0..100 across the whole machine (Task Manager scale). Raw
    // core-percent would exceed 100% whenever the Node process spans more
    // than one core (libuv threadpool, GC, JIT), which is what made the
    // pill disagree with Task Manager.
    const mainCpuPct = dtMs > 0
      ? ((cpuUsage.user + cpuUsage.system) / 1000) / dtMs * 100 / this.cpuCount
      : 0;
    const mainMem = process.memoryUsage().rss;

    // ── Session trees ────────────────────────────────────────────────
    const roster = this.manager.snapshotPids();
    const rootPids = roster.filter(r => r.pid !== undefined).map(r => r.pid!);
    const probed = rootPids.length > 0
      ? await this.probeTrees(rootPids, now)
      : new Map<number, { cpuPct: number; memBytes: number }>();

    const sessions: MetricsSnapshot['sessions'] = roster.map(r => {
      // Prefer the preset name over the `${server}:${cwd}` path so the row
      // reads "my-preset" (or the localized "New session") instead of a
      // long path. When a preset name is present the path becomes `sub`
      // so the widget can surface it via tooltip without cluttering the
      // primary line. When there's no preset the path is the only name
      // we have — it stays in `label` and `sub` is undefined.
      const label = r.presetName || r.label;
      const sub = r.presetName ? r.label : undefined;
      if (r.pid === undefined) {
        return { id: r.id, label, sub, pid: null, cpuPct: null, memBytes: null };
      }
      const m = probed.get(r.pid);
      if (!m) {
        // pid exists locally but the probe missed it (died mid-tick, or
        // its process record was dropped between snapshot and traversal).
        // Show N/A rather than a stale 0.
        return { id: r.id, label, sub, pid: r.pid, cpuPct: null, memBytes: null };
      }
      return { id: r.id, label, sub, pid: r.pid, cpuPct: m.cpuPct, memBytes: m.memBytes };
    });

    const sessCpu = sessions.reduce((a, s) => a + (s.cpuPct ?? 0), 0);
    const sessMem = sessions.reduce((a, s) => a + (s.memBytes ?? 0), 0);

    const snap: MetricsSnapshot = {
      ts: now,
      cpuCount: this.cpuCount,
      memTotalBytes: this.memTotal,
      total: { cpuPct: mainCpuPct + sessCpu, memBytes: mainMem + sessMem },
      main: { cpuPct: mainCpuPct, memBytes: mainMem },
      sessions,
    };
    this.latest = snap;
    this.emit('snapshot', snap);
    return snap;
  }

  /** For each session root pid, expand its descendant tree and aggregate
   * CPU% + RSS across all live processes in that tree. CPU% is computed
   * per-pid (delta vs previous sample) then summed and normalized to
   * 0..100 across all host cores (see treeCpuPct) — that way a short-lived
   * child that appears and disappears within a window still contributes
   * what it burned during its lifetime, and a persistent child that exits
   * mid-window doesn't cause the aggregate to move backwards. */
  private async probeTrees(rootPids: number[], now: number): Promise<Map<number, { cpuPct: number; memBytes: number }>> {
    const result = new Map<number, { cpuPct: number; memBytes: number }>();
    const rows = await this.sampleAllProcesses();
    if (rows.length === 0) return result;

    const trees = aggregateProcessTree(rows, rootPids);
    // 100ns FILETIME ticks per ms on Windows; 1 jiffy = 10 ms on Linux
    // (CLK_TCK=100). Baked into the delta math via one constant.
    const ticksPerMs = IS_WIN ? 10_000 : 0.1;
    const rowByPid = new Map(rows.map(r => [r.pid, r]));

    // Track every descendant seen across all roots this tick — anything in
    // this.samples not in this set is a dead pid we should drop from the
    // sample map so it doesn't grow unbounded across a long-running server.
    const seen = new Set<number>();

    for (const [root, tree] of trees) {
      // Compute % against the PREVIOUS baselines (this.samples) before we
      // overwrite them below — treeCpuPct reads prev, so ordering matters.
      const cpuPct = treeCpuPct(tree.members, rowByPid, this.samples, now, ticksPerMs, this.cpuCount);
      for (const pid of tree.members) {
        seen.add(pid);
        const row = rowByPid.get(pid);
        if (row) this.samples.set(pid, { cpuTicks: row.cpuTicks, ts: now });
      }
      result.set(root, { cpuPct, memBytes: tree.memBytes });
    }

    for (const key of this.samples.keys()) {
      if (!seen.has(key)) this.samples.delete(key);
    }
    return result;
  }

  /** One-shot snapshot of every process on the host. Windows path spawns
   * one PowerShell to run a Get-CimInstance query and parses the CSV;
   * Linux path reads /proc directly. Non-Windows/Linux hosts (macOS
   * dev) return an empty list — the widget then shows N/A for every
   * session, which is honest. */
  private async sampleAllProcesses(): Promise<ProcessSample[]> {
    if (IS_WIN) return this.sampleAllProcessesWindows();
    if (IS_LINUX) return this.sampleAllProcessesLinux();
    return [];
  }

  /** Windows: one PowerShell invocation returns every process's pid,
   * ppid, working set, and CPU ticks. Historically this probe used
   * `wmic`, but Windows 11 24H2 removed the `wmic` executable from
   * the default install; we then briefly used `Get-Process` (fast,
   * ~200ms) which doesn't expose the parent pid — a session showed
   * only its pty-bridge pid and reported ~8 MB instead of the ~500 MB
   * actually in use by the CLI beneath it. `Get-CimInstance
   * Win32_Process` returns ppid, so we can walk the tree and
   * attribute the real cost to each session. It costs ~400 ms per
   * invocation (empirical, Windows 11 24H2), which is a fifth of the
   * sample window and negligible against a background CPU budget. */
  private sampleAllProcessesWindows(): Promise<ProcessSample[]> {
    // Single-quoted WQL string so no character in the query has to be
    // escaped by any of the layers between JS and CIM. Ordering the
    // Select-Object columns explicitly (matching the WQL SELECT) makes
    // the CSV shape stable and the tests deterministic — even though
    // we parse by header name for robustness, aligning the two avoids
    // surprising a reader.
    const pscmd =
      "Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime FROM Win32_Process'"
      + " | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime"
      + " | ConvertTo-Csv -NoTypeInformation";
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', pscmd],
        // 8s timeout because CIM occasionally spikes when the WMI
        // service is busy; 4MB buffer to comfortably hold a couple
        // thousand rows of CSV.
        { windowsHide: true, timeout: 8000, maxBuffer: 4 << 20 },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          resolve(parseWin32ProcessCsv(stdout));
        },
      );
    });
  }

  /** Linux: scan `/proc` and read every `<pid>/stat`. Everything under
   * `/proc` is virtual — no disk I/O, no seek — so the whole scan is
   * cheap even at ~1000 processes. We ignore `/proc/self` traversal
   * cost (stat parse is a few hundred nanoseconds per file). */
  private sampleAllProcessesLinux(): ProcessSample[] {
    let names: string[];
    try {
      names = readdirSync('/proc');
    } catch {
      return [];
    }
    const rows: ProcessSample[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const r = this.readProcStat(pid);
      if (r) rows.push(r);
    }
    return rows;
  }

  /** Parse `/proc/<pid>/stat` into (pid, ppid, cpuTicks, rssBytes).
   *
   * The stat format is: `pid (comm) state ppid pgrp ...`. The comm
   * field is parenthesised and may contain spaces or embedded ')' —
   * we scan from the LAST ')' to skip over that safely. After the
   * closing paren:
   *   fields[0] = state (char)
   *   fields[1] = ppid
   *   fields[11] = utime (clock ticks)
   *   fields[12] = stime (clock ticks)
   *   fields[21] = rss (in pages) */
  private readProcStat(pid: number): ProcessSample | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat.slice(closeParen + 2).split(' ');
      const ppid = Number(fields[1]);
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      const rssPages = Number(fields[21]) || 0;
      if (!Number.isFinite(ppid)) return null;
      // Page size: Node exposes no sysconf(_SC_PAGESIZE) binding but every
      // Linux we care about (x86_64, aarch64) defaults to 4 KiB pages.
      // If a host is running with a different page size we under- or
      // over-report by a constant factor — visible but non-fatal.
      const PAGE_BYTES = 4096;
      return { pid, ppid, cpuTicks: utime + stime, memBytes: rssPages * PAGE_BYTES };
    } catch {
      return null;
    }
  }
}

/** Parse the CSV emitted by `Get-CimInstance Win32_Process | Select-Object
 * ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime |
 * ConvertTo-Csv -NoTypeInformation`. Shape:
 *
 *   "ProcessId","ParentProcessId","WorkingSetSize","KernelModeTime","UserModeTime"
 *   "13220","12800","52428800","1200000","2200000"
 *
 * Every cell is quoted (ConvertTo-Csv default). CIM emits KernelModeTime
 * and UserModeTime already in 100ns FILETIME ticks — no unit conversion
 * needed on the JS side. Parse-by-header-name so a future PowerShell
 * reordering the Select-Object output doesn't silently swap columns. */
export function parseWin32ProcessCsv(csv: string): ProcessSample[] {
  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]!);
  const iPid = header.indexOf('ProcessId');
  const iPpid = header.indexOf('ParentProcessId');
  const iMem = header.indexOf('WorkingSetSize');
  const iKernel = header.indexOf('KernelModeTime');
  const iUser = header.indexOf('UserModeTime');
  if (iPid < 0 || iPpid < 0 || iMem < 0 || iKernel < 0 || iUser < 0) return [];
  const rows: ProcessSample[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i]!);
    const pid = Number(cols[iPid]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const ppid = Number(cols[iPpid]);
    if (!Number.isFinite(ppid)) continue;
    const mem = Number(cols[iMem]) || 0;
    // Kernel/User times can be empty for a just-spawned process that
    // hasn't accumulated any CPU time yet — treat as 0 rather than
    // NaN, matching Get-Process's behaviour and keeping delta math
    // well-behaved.
    const k = cols[iKernel] === '' ? 0 : (Number(cols[iKernel]) || 0);
    const u = cols[iUser] === '' ? 0 : (Number(cols[iUser]) || 0);
    rows.push({ pid, ppid, cpuTicks: k + u, memBytes: mem });
  }
  return rows;
}

/** Walk the ppid graph from each root and return the set of live
 * descendants plus the aggregate RSS. Exported for the spec — this is
 * the load-bearing piece the "session showed 8 MB" bug lived in and
 * we lock the traversal contract independently of the CSV parse. */
export function aggregateProcessTree(
  rows: ProcessSample[],
  rootPids: number[],
): Map<number, { members: number[]; memBytes: number }> {
  const byPid = new Map<number, ProcessSample>();
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    // Ignore self-parenting (Windows System Idle Process pid=0 ppid=0)
    // to keep the BFS visited-set overhead trivial for the common case.
    if (r.ppid !== r.pid) {
      const existing = childrenOf.get(r.ppid);
      if (existing) existing.push(r.pid);
      else childrenOf.set(r.ppid, [r.pid]);
    }
  }
  const result = new Map<number, { members: number[]; memBytes: number }>();
  for (const root of rootPids) {
    if (!byPid.has(root)) continue; // root dead — caller reports N/A
    const members: number[] = [];
    let memBytes = 0;
    const visited = new Set<number>();
    const stack: number[] = [root];
    // BFS/DFS both fine; iterative stack keeps us out of recursion depth
    // trouble on a pathological tree (won't happen in practice, tree
    // depth is <10, but it costs nothing to be safe).
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const s = byPid.get(pid);
      if (!s) continue;
      members.push(pid);
      memBytes += s.memBytes;
      const kids = childrenOf.get(pid);
      if (kids) {
        for (const k of kids) stack.push(k);
      }
    }
    result.set(root, { members, memBytes });
  }
  return result;
}

/** Sum the CPU% of every pid in a process tree, normalized to 0..100 across
 * all host cores — the same scale Task Manager uses for a process, so a
 * single fully-pegged core on an 8-core box reads ~12.5%.
 *
 * Per pid we take (Δcpu-ticks → ms) divided by that pid's OWN elapsed wall
 * time (`now - prev.ts`), giving its fraction of one core, and sum across
 * the tree. Using each pid's real elapsed time — not a nominal sample
 * interval — is what keeps a delayed or skipped tick from inflating the
 * reading: on a busy host the timer fires late, so the true gap is well
 * over INTERVAL_MS, and dividing by a fixed 2000ms used to double the
 * number (the ">100%" spike). Finally we divide the summed core-fraction
 * by `cpuCount` to land on the whole-machine percentage.
 *
 * Pure (no mutation): the caller records this tick's baselines and does the
 * dead-pid bookkeeping. A pid with no `prev` baseline (first sighting) and a
 * pid whose ticks went backwards (Windows pid-reuse) each contribute 0
 * rather than a spurious spike or a negative that eats a sibling's usage.
 * Exported for the spec so the delta math is locked without a real OS probe. */
export function treeCpuPct(
  members: number[],
  rowByPid: Map<number, ProcessSample>,
  prevByPid: Map<number, PidSample>,
  now: number,
  ticksPerMs: number,
  cpuCount: number,
): number {
  let coreFraction = 0;
  for (const pid of members) {
    const row = rowByPid.get(pid);
    const prev = prevByPid.get(pid);
    if (!row || !prev) continue;
    const dTicks = row.cpuTicks - prev.cpuTicks;
    const dtMs = now - prev.ts;
    if (dTicks > 0 && dtMs > 0) coreFraction += (dTicks / ticksPerMs) / dtMs;
  }
  return (coreFraction / Math.max(1, cpuCount)) * 100;
}

/** Minimal CSV cell splitter for the shape ConvertTo-Csv emits: quoted
 * cells, no embedded quotes in the numeric values we ask for. Handles
 * blank cells (`,,`) and strips surrounding quotes. Not a general CSV
 * parser — those cases don't appear in the Win32_Process output. */
function splitCsv(line: string): string[] {
  return line.split(',').map(c => c.replace(/^"|"$/g, ''));
}
