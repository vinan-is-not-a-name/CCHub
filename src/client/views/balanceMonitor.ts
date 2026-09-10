import type { AppDeps } from '../deps.js';
import { el } from '../dom.js';
import { subscribeLocale, t } from '../i18n.js';
import type { BalanceSiteView } from '../../shared/protocol.js';

/**
 * Topbar relay-balance pill + hover dropdown, sitting next to the CPU/mem
 * monitor and behaving exactly like it: mouseover opens (with the same 200ms
 * grace so a fast cursor across the border doesn't flicker), mouseleave
 * closes. The resource monitor proved this model — zero cost when idle, never
 * fights the terminal for focus — and the balance panel has the same usage
 * pattern, so it inherits it rather than inventing a click-driven variant.
 *
 * The server probes every distinct (baseUrl, authToken) site — several
 * presets sharing one relay collapse into one row — and sorts by remaining
 * balance descending, failures last. Results auto-refresh on a fixed cadence
 * (AUTO_REFRESH_MS, shown next to the update time); the dropdown's Refresh
 * button forces one.
 *
 * The pill shows the summed USD balance of successful sites plus the site
 * count; non-USD sites (DeepSeek's CNY endpoint) still count toward `n` but
 * their amount stays out of the sum — summing across currencies would be a
 * lie. A failed site counts toward `n` too, so the number matches the table.
 */

const STALE_MS = 60_000;
const AUTO_REFRESH_MS = 60_000;
const CLOSE_GRACE_MS = 200;

export function mountBalanceMonitor(deps: AppDeps): void {
  const host = el<HTMLDivElement>('balance-monitor');

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'bal-pill';
  host.appendChild(pill);

  const dropdown = document.createElement('div');
  dropdown.className = 'bal-dropdown';
  dropdown.hidden = true;
  host.appendChild(dropdown);

  let sites: BalanceSiteView[] | null = null;
  let lastProbed = 0;
  let requestSeq = 0;
  let inFlightRequestId: string | null = null;
  let hoverOpen = false;

  const updatePill = () => {
    const ok = (sites ?? []).filter((s) => s.remain !== null);
    const total = ok.reduce((a, s) => a + (s.currency === 'USD' ? (s.remain ?? 0) : 0), 0);
    const n = sites?.length ?? 0;
    if (n === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    pill.textContent = `${fmtMoney(total)} · ${n}`;
    pill.title = t('balance.pill.aria').replace('{n}', String(n));
  };

  const refresh = () => {
    inFlightRequestId = `bal-${++requestSeq}`;
    deps.conn.send({ type: 'balance.query', requestId: inFlightRequestId });
    updatePill();
    if (hoverOpen) renderDropdown();
  };

  let booted = false;
  deps.conn.onMessage((msg) => {
    // Mount happens before conn.connect() (main.ts), so a mount-time probe
    // would be sent into an unopened socket and dropped. Fire it on the first
    // authenticated frame instead — and only once, so reconnects don't spam.
    if (msg.type === 'auth.ok' && !booted) {
      booted = true;
      refresh();
      return;
    }
    if (msg.type !== 'balance.result' || msg.requestId !== inFlightRequestId) return;
    // Two frames per request: `final:false` carries the process-wide cache
    // (rendered immediately, stale values with their age), `final:true` the
    // fresh probe. Only the final frame ends the in-flight state, so the
    // "refreshing" label stays up across the cached frame.
    sites = msg.sites;
    if (msg.final !== false) {
      inFlightRequestId = null;
      lastProbed = Date.now();
    }
    updatePill();
    if (hoverOpen) renderDropdown();
  });

  // Hover model, same as the resource monitor: enter opens (refreshing when
  // the data is stale), leave closes after a short grace so a fast cursor
  // across the border doesn't flicker. The dropdown is a child of host, so
  // moving from pill to dropdown never leaves host's boundary box.
  let closeTimer: number | null = null;
  const cancelClose = () => {
    if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      hoverOpen = false;
      dropdown.hidden = true;
    }, CLOSE_GRACE_MS);
  };
  host.addEventListener('mouseenter', () => {
    cancelClose();
    hoverOpen = true;
    if (sites === null || Date.now() - lastProbed > STALE_MS) refresh();
    else renderDropdown();
    dropdown.hidden = false;
  });
  host.addEventListener('mouseleave', scheduleClose);

  // Auto-refresh on a fixed cadence once there is something to show. The
  // interval survives regardless (cheap: one WS message when data exists).
  window.setInterval(() => {
    if (booted && sites !== null && sites.length > 0) refresh();
  }, AUTO_REFRESH_MS);

  subscribeLocale(() => { updatePill(); if (hoverOpen) renderDropdown(); });

  function renderDropdown(): void {
    dropdown.textContent = '';
    dropdown.classList.remove('empty');

    const head = document.createElement('div');
    head.className = 'bal-head';

    const title = document.createElement('span');
    title.className = 'bal-title';
    title.textContent = t('balance.title');
    head.appendChild(title);

    if (lastProbed > 0 && sites !== null) {
      const updated = document.createElement('span');
      updated.className = 'bal-updated';
      const when = new Date(lastProbed).toLocaleTimeString();
      // The refresh cadence is part of the data contract the user sees —
      // "updated at 16:30" without "auto-refreshes every 60s" reads as a
      // one-shot snapshot.
      updated.textContent = `${t('balance.updated').replace('{time}', when)} · ${t('balance.interval').replace('{s}', String(AUTO_REFRESH_MS / 1000))}`;
      head.appendChild(updated);
    }

    // Refreshing while old data is on screen: keep showing the stale rows
    // (better than a blank "loading" flicker every auto-refresh) and mark the
    // in-flight probe instead.
    if (sites !== null && inFlightRequestId !== null) {
      const refreshing = document.createElement('span');
      refreshing.className = 'bal-refreshing';
      refreshing.textContent = t('balance.refreshing');
      head.appendChild(refreshing);
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'bal-refresh';
    refreshBtn.textContent = t('balance.refresh');
    refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); refresh(); });
    head.appendChild(refreshBtn);
    dropdown.appendChild(head);

    // No data at all (first probe in flight): nothing to show yet — loading.
    if (sites === null) {
      const loading = document.createElement('div');
      loading.className = 'bal-empty';
      loading.textContent = t('balance.loading');
      dropdown.appendChild(loading);
      return;
    }

    if (sites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bal-empty';
      empty.textContent = t('balance.empty');
      dropdown.appendChild(empty);
      return;
    }

    const header = document.createElement('div');
    header.className = 'bal-row bal-header';
    header.appendChild(makeCell(t('balance.site'), 'bal-site'));
    header.appendChild(makeCell(t('balance.key'), 'bal-key'));
    header.appendChild(makeCell(t('balance.remain'), 'bal-bal'));
    header.appendChild(makeCell(t('balance.preset'), 'bal-preset'));
    dropdown.appendChild(header);

    // Server already sorts (remain desc, failures last); render as-is.
    for (const site of sites) {
      const row = document.createElement('div');
      row.className = 'bal-row';
      row.appendChild(makeCell(displaySite(site.baseUrl), 'bal-site'));
      row.appendChild(makeCell(site.keyPreview, 'bal-key'));
      row.appendChild(makeCell(balanceText(site), 'bal-bal', balanceClass(site)));
      row.appendChild(makeCell(site.presetNames.join(', '), 'bal-preset'));
      dropdown.appendChild(row);
    }
  }
}

/** Host (+ path) without the protocol — https:// is pure noise in a table of
 * relay sites and its ~8 characters are better spent on the name itself. The
 * full URL stays one hover away via makeCell's title. */
function displaySite(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '');
}

function makeCell(text: string, cls: string, extraCls?: string): HTMLElement {
  const cell = document.createElement('span');
  cell.className = cls + (extraCls ? ` ${extraCls}` : '');
  cell.textContent = text;
  // Long names fold via ellipsis; the full value is one hover away.
  cell.title = text;
  return cell;
}

/** Success → "$50.00" / "¥18.46" per currency; failed → '—' with the reason
 * in a hover-explained `title`. Stale rows (failed this round, showing the
 * previous balance) append the age of the stale value so the user knows it's
 * not fresh, e.g. "$50.00 (5 min ago)". */
function balanceText(site: BalanceSiteView): string {
  if (site.remain !== null) {
    const text = fmtMoney(site.remain, site.currency);
    if (site.stale) {
      const ago = relativeAge(site.at);
      return `${text} (${ago})`;
    }
    return text;
  }
  // 'pending' = the cached first frame, probe still running for this site.
  if (site.error === 'pending') return '…';
  return site.error === 'unsupported' ? t('balance.unsupported') : t('balance.error').replace('{error}', site.error ?? '?');
}

/** Human-readable age from an epoch ms, e.g. "5 min ago", "1h ago", "2d ago",
 * "just now". Matches the format the topbar dropdown uses. */
function relativeAge(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return t('balance.justNow');
  const min = Math.floor(diff / 60_000);
  if (min < 60) return t('balance.minAgo').replace('{n}', String(min));
  const h = Math.floor(min / 60);
  if (h < 24) return t('balance.hourAgo').replace('{n}', String(h));
  const d = Math.floor(h / 24);
  return t('balance.dayAgo').replace('{n}', String(d));
}

/** Colour the balance cell by health: red when the site failed or reported
 * zero/near-zero remaining, amber when low, muted while a probe is pending,
 * plain otherwise. */
function balanceClass(site: BalanceSiteView): string {
  if (site.error === 'pending') return 'bal-pending';
  if (site.remain === null) return 'bal-err';
  if (site.remain <= 5) return 'bal-err';
  if (site.remain <= 20) return 'bal-warn';
  return '';
}

function fmtMoney(n: number, currency = 'USD'): string {
  const symbol = currency === 'CNY' ? '¥' : '$';
  return symbol + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
