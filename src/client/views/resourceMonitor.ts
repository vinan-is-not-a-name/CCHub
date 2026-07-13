import type { AppDeps } from '../deps.js';
import { el } from '../dom.js';
import { subscribeLocale, t } from '../i18n.js';

/** Topbar CPU/memory pill + hover popover.
 *
 * The server broadcasts a full `metrics.snapshot` every 2s to every
 * authenticated connection (see MetricsCollector). We render the latest
 * snapshot to the pill on every message and re-render the popover contents
 * whenever it's open. The popover is a lightweight hover UI: no auto-open on
 * click, no keyboard nav — the tradeoff is that it's zero-cost when idle and
 * doesn't fight the terminal for focus.
 *
 * Units the server sends (see MetricsSnapshotMsg):
 *  - `cpuPct` is 0..100, already normalized across all host cores the way
 *    Task Manager reports it (100% = whole machine saturated). We show it
 *    directly and add a "N cores" hint in the tooltip; the client does NOT
 *    divide by cpuCount — the server already did.
 *  - `memBytes` is bytes; formatMem picks MB/GB.
 *
 * Sessions with `pid: null` are SSH sessions — the cc CLI runs on the remote
 * host, invisible locally. Rendered as "N/A (remote)" so the user isn't
 * misled into thinking the widget is broken.
 */
export function mountResourceMonitor(deps: AppDeps): void {
  const host = el<HTMLDivElement>('resource-monitor');

  // Structure once, then swap textContent per tick. Building nodes on every
  // 2s message would churn the DOM for no visible benefit; the row count in
  // the popover is small (~1–10) so full rebuild there is fine, but the
  // pill itself never changes structure.
  host.textContent = '';
  const cpuValue = document.createElement('span');
  const sep = document.createElement('span');
  sep.className = 'rm-sep';
  sep.textContent = '·';
  const memValue = document.createElement('span');
  host.appendChild(cpuValue);
  host.appendChild(sep);
  host.appendChild(memValue);
  // Accessible label lives on the host — screen readers hear "CPU 0.0% ·
  // 102 MB" via title, since the pill itself just shows "0.0% · 102 MB".
  host.title = '';

  const popover = document.createElement('div');
  popover.className = 'rm-popover';
  popover.hidden = true;
  host.appendChild(popover);

  let latest: Snapshot | null = null;
  let hoverOpen = false;

  const rerender = () => {
    if (hoverOpen && latest) renderPopover(popover, latest);
  };
  subscribeLocale(rerender);

  // Hover model: mouseenter opens, mouseleave (with a short grace so a
  // fast cursor across the border doesn't flicker) closes. Same 200ms grace
  // as the recent-launches menu — feels consistent.
  let closeTimer: number | null = null;
  const cancelClose = () => {
    if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      hoverOpen = false;
      popover.hidden = true;
    }, 200);
  };
  host.addEventListener('mouseenter', () => {
    cancelClose();
    hoverOpen = true;
    if (latest) renderPopover(popover, latest);
    popover.hidden = false;
  });
  host.addEventListener('mouseleave', scheduleClose);

  deps.conn.onMessage((msg) => {
    if (msg.type !== 'metrics.snapshot') return;
    latest = msg;
    host.hidden = false;
    const cpu = msg.total.cpuPct;
    const cpuStr = formatCpu(cpu);
    const memStr = formatMem(msg.total.memBytes);
    cpuValue.textContent = cpuStr;
    memValue.textContent = memStr;
    // Screen readers hear the full label via native title; the pill itself
    // stays visually terse. Rebuilt every tick so it tracks live values.
    host.title = `${t('metrics.cpu')} ${cpuStr}  ·  ${t('metrics.mem')} ${memStr}`;
    // Heat classes: mostly cosmetic. `cpu` is already whole-machine percent
    // (0..100), so the thresholds read as "half the box busy" / "nearly
    // pegged" without any per-core conversion.
    host.classList.toggle('hot', cpu >= 50 && cpu < 85);
    host.classList.toggle('crit', cpu >= 85);
    if (hoverOpen) renderPopover(popover, msg);
  });

  // When the ws drops we don't clear the pill — the last known value is more
  // useful than a blank space, and the reconnect will refresh it.
}

type Snapshot = {
  ts: number;
  cpuCount: number;
  memTotalBytes: number;
  total: { cpuPct: number; memBytes: number };
  main: { cpuPct: number; memBytes: number };
  sessions: { id: string; label: string; sub?: string; pid: number | null; cpuPct: number | null; memBytes: number | null }[];
};

/** Render the popover — full rebuild each time. Row count is small
 * (main + sessions + total; typically 3–10 rows) so DOM diffing here would
 * cost more code than it saves. */
function renderPopover(popover: HTMLElement, snap: Snapshot): void {
  popover.textContent = '';

  const title = document.createElement('div');
  title.className = 'rm-pop-title';
  title.textContent = t('metrics.tooltip.title');
  popover.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'rm-pop-sub';
  sub.textContent = t('metrics.tooltip.cores').replace('{n}', String(snap.cpuCount))
    + '  ·  ' + formatMem(snap.memTotalBytes) + ' RAM';
  popover.appendChild(sub);

  // Column headers — labels the three data columns (name / CPU / mem) so a
  // first-time reader isn't guessing what "0.2%" or "78 MB" belongs to.
  // Uses the same 3-column grid as the data rows via .rm-pop-row, then a
  // dedicated .rm-header class styles it as a subordinate label strip
  // (muted, small caps-ish size). Keys are the ones we already ship for
  // the pill's aria title, so we're not introducing new i18n strings.
  const header = makeRow(
    t('metrics.tooltip.session'),
    t('metrics.cpu'),
    t('metrics.mem'),
  );
  header.classList.add('rm-header');
  popover.appendChild(header);

  popover.appendChild(makeRow(
    t('metrics.tooltip.main'),
    formatCpu(snap.main.cpuPct),
    formatMem(snap.main.memBytes),
  ));

  if (snap.sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rm-pop-empty';
    empty.textContent = t('metrics.tooltip.empty');
    popover.appendChild(empty);
  } else {
    // Sort by mem desc so the heaviest session is up top — matches how
    // users triage a suspicious pill ("what's eating my RAM?"). Sessions
    // with null memBytes (SSH) sink to the bottom.
    const rows = [...snap.sessions].sort((a, b) => (b.memBytes ?? -1) - (a.memBytes ?? -1));
    for (const s of rows) {
      // Two null cases to distinguish here:
      //  - pid=null: this is an SSH session; no local process exists to
      //    sample, and no future tick can fix that. Show "N/A (remote)".
      //  - pid present but cpuPct/memBytes null: the probe couldn't reach
      //    the pid THIS tick (died mid-tick, PowerShell timed out, etc.).
      //    Show "—" — a transient miss that the next tick may resolve.
      // Conflating them (as an earlier draft did) mislabels a live local
      // session's transient probe failure as "远程" and confuses the user.
      const isRemote = s.pid === null;
      const cpuStr = isRemote ? t('metrics.tooltip.remote') : (s.cpuPct === null ? '—' : formatCpu(s.cpuPct));
      const memStr = isRemote ? '' : (s.memBytes === null ? '—' : formatMem(s.memBytes));
      const name = s.label || `#${s.id.slice(0, 6)}`;
      // When the server sent a `sub` (raw `server:cwd` path for a preset
      // launch) surface it via a two-line title so the primary line stays
      // the preset name but the path is still one hover away. Without a
      // sub we fall back to the name itself for the title so long names
      // truncated by the row's ellipsis stay recoverable.
      const tooltip = s.sub ? `${name}\n${s.sub}` : undefined;
      popover.appendChild(makeRow(name, cpuStr, memStr, tooltip));
    }
  }

  const total = makeRow(
    t('metrics.tooltip.total'),
    formatCpu(snap.total.cpuPct),
    formatMem(snap.total.memBytes),
  );
  total.classList.add('rm-total');
  popover.appendChild(total);
}

function makeRow(name: string, cpu: string, mem: string, tooltip?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'rm-pop-row';
  const n = document.createElement('span');
  n.className = 'rm-pop-name';
  n.textContent = name;
  n.title = tooltip ?? name;
  const c = document.createElement('span');
  c.className = 'rm-pop-cpu';
  c.textContent = cpu;
  const m = document.createElement('span');
  m.className = 'rm-pop-mem';
  m.textContent = mem;
  row.appendChild(n);
  row.appendChild(c);
  row.appendChild(m);
  return row;
}

/** CPU% — one decimal at low values so a jittery idle isn't reported as
 * "0%" then "1%" then "0%" (readable if the widget felt broken otherwise);
 * integer at higher loads where a tenth of a percent is noise. */
export function formatCpu(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) return '—';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** Bytes → human-readable, one decimal for GB, whole MB otherwise.
 * We render at MB precision at minimum: a 3.2 KB report on the pill would
 * flicker between values within one sample of noise. */
export function formatMem(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}
