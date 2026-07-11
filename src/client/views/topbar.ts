import themes from 'xterm-theme';
import type { RecentLaunch, SafeConfigSnapshot } from '../../shared/protocol.js';
import { getStoredTheme } from '../terminal.js';
import { getThemeCatalog } from '../themeCatalog.js';
import { el } from '../dom.js';
import type { AppDeps } from '../deps.js';
import { subscribeLocale, t } from '../i18n.js';
import {
  FONT_SCALES,
  DEFAULT_SCALE,
  loadFontScale,
  saveFontScale,
  scaleToPx,
} from './fontScale.js';

export function mountTopbar(deps: AppDeps) {
  const connectionBadge = el('connection-badge');
  const themeSelect = el<HTMLSelectElement>('theme-select');
  const fontSelect = el<HTMLSelectElement>('font-scale');
  const configButton = el<HTMLButtonElement>('config-button');
  const settingsButton = el<HTMLButtonElement>('settings-button');
  const newButton = el<HTMLButtonElement>('new-session');
  const splitHost = el<HTMLDivElement>('new-split');
  const menuToggle = el<HTMLButtonElement>('new-menu-toggle');
  const menu = el<HTMLDivElement>('new-menu');
  let currentThemeName = getStoredTheme();

  // Split the list into two <optgroup>s so the ~150 shipped themes are
  // scannable: the "Popular" cluster is 20 curated names at the top, then
  // an alphabetized "More" cluster carries everything else. Native <select>
  // renders both groups without help; keeps the picker keyboard-navigable
  // without introducing a searchbox.
  const catalog = getThemeCatalog();
  const appendOption = (group: HTMLElement, name: string) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === currentThemeName) opt.selected = true;
    group.appendChild(opt);
  };
  const popularGroup = document.createElement('optgroup');
  popularGroup.label = t('topbar.themeGroup.popular');
  for (const name of catalog.popular) appendOption(popularGroup, name);
  themeSelect.appendChild(popularGroup);
  const othersGroup = document.createElement('optgroup');
  othersGroup.label = t('topbar.themeGroup.more');
  for (const name of catalog.others) appendOption(othersGroup, name);
  themeSelect.appendChild(othersGroup);

  const currentScale = loadFontScale();
  for (const scale of FONT_SCALES) {
    const opt = document.createElement('option');
    opt.value = String(scale);
    opt.textContent = `${scale}%`;
    if (scale === currentScale) opt.selected = true;
    fontSelect.appendChild(opt);
  }
  // If the persisted scale isn't one of the presets, still reflect it.
  if (![...FONT_SCALES].includes(currentScale as any)) fontSelect.value = String(DEFAULT_SCALE);

  applyPageTheme();
  function applyPageTheme() {
    const theme = (themes as any)[currentThemeName] || (themes as any).OneHalfLight;
    document.documentElement.style.setProperty('--term-bg', theme.background || '#fff');
  }

  themeSelect.onchange = () => {
    currentThemeName = themeSelect.value;
    localStorage.setItem('cchub-theme', currentThemeName);
    const theme = (themes as any)[currentThemeName];
    // Route through setBaseTheme so each session preserves its own cursor mode
    // (Hidden for legacy cc, Visible for DECTCEM-emitting cc — see terminal.ts).
    // A direct `term.options.theme = ...` would clobber the cursor override.
    for (const s of deps.store.get().sessions.values()) s.terminal.setBaseTheme(theme);
    document.documentElement.style.setProperty('--term-bg', theme.background || '#fff');
  };

  // Resize the glyphs of every live terminal and refit so the PTY learns its
  // new cols/rows. New terminals pick the stored scale up in createTerminal.
  fontSelect.onchange = () => {
    const scale = Number(fontSelect.value);
    saveFontScale(scale);
    const px = scaleToPx(scale);
    for (const s of deps.store.get().sessions.values()) {
      s.terminal.term.options.fontSize = px;
      requestAnimationFrame(() => s.terminal.fit.fit());
    }
  };

  newButton.onclick = () => deps.bus.emit('launch:open');
  configButton.onclick = () => deps.bus.emit('config:open');
  settingsButton.onclick = () => deps.bus.emit('settings:open');
  mountRecentMenu();

  const applyStatus = (status: string) => {
    connectionBadge.textContent = t(`status.${status}`) ?? status;
    connectionBadge.className = `connection-badge ${status}`;
  };
  let lastStatus = 'connecting';
  deps.conn.onStatus((status) => {
    lastStatus = status;
    applyStatus(status);
  });

  // The transport reports 'connecting' / 'offline'; 'online' is the *authenticated* state.
  deps.conn.onMessage((msg) => {
    if (msg.type === 'auth.ok') {
      lastStatus = 'online';
      connectionBadge.textContent = t('status.online');
      connectionBadge.className = 'connection-badge idle';
    }
  });

  subscribeLocale(() => {
    connectionBadge.textContent = t(`status.${lastStatus}`) ?? lastStatus;
    popularGroup.label = t('topbar.themeGroup.popular');
    othersGroup.label = t('topbar.themeGroup.more');
  });

  /** Recent-launches dropdown attached to the `▾` caret of the split button.
   * Hover opens; hover-leave with a short grace period closes; click on the
   * caret toggles (touch fallback and keyboard entry). Chip click re-launches
   * verbatim, Shift+click opens the launch dialog pre-filled, `×` forgets one
   * entry, "Clear all" nukes the list. */
  function mountRecentMenu(): void {
    let open = false;
    let closeTimer: number | null = null;

    const setOpen = (next: boolean) => {
      if (open === next) return;
      open = next;
      menu.hidden = !next;
      menuToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    };
    const cancelClose = () => {
      if (closeTimer !== null) { window.clearTimeout(closeTimer); closeTimer = null; }
    };
    const scheduleClose = () => {
      cancelClose();
      // 200 ms grace so mouse can travel from caret to menu without a flicker
      closeTimer = window.setTimeout(() => setOpen(false), 200);
    };

    menuToggle.addEventListener('mouseenter', () => { renderMenu(); cancelClose(); setOpen(true); });
    menuToggle.addEventListener('click', (e) => {
      // Touch/keyboard fallback: click toggles. mouseenter already handled mouse.
      e.preventDefault();
      renderMenu();
      setOpen(!open);
    });
    menu.addEventListener('mouseenter', cancelClose);
    splitHost.addEventListener('mouseleave', scheduleClose);
    document.addEventListener('click', (e) => {
      if (!splitHost.contains(e.target as Node)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) setOpen(false);
    });

    // Re-render when the config snapshot updates (e.g. we just recorded a
    // new launch, or the user forgot one). Cheap enough to redraw on every
    // config change — the menu is small and usually hidden.
    deps.store.subscribe(() => { if (open) renderMenu(); });
    subscribeLocale(() => { if (open) renderMenu(); });

    function renderMenu(): void {
      const config = deps.store.get().config;
      menu.textContent = '';
      menu.classList.remove('empty');
      const recents = config?.recentLaunches ?? [];
      if (recents.length === 0) {
        menu.classList.add('empty');
        menu.textContent = t('recent.empty');
        return;
      }
      for (const recent of recents.slice(0, 6)) menu.appendChild(recentItem(config!, recent));
      const sep = document.createElement('div');
      sep.className = 'new-menu-sep';
      menu.appendChild(sep);
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'recent-clear';
      clear.textContent = t('recent.clearAll');
      clear.onclick = (e) => { e.stopPropagation(); deps.conn.send({ type: 'launch.recent.clear' }); };
      menu.appendChild(clear);
      const custom = document.createElement('button');
      custom.type = 'button';
      custom.className = 'recent-custom';
      custom.textContent = t('recent.custom');
      custom.onclick = () => { setOpen(false); deps.bus.emit('launch:open'); };
      menu.appendChild(custom);
    }

    function recentItem(config: SafeConfigSnapshot, recent: RecentLaunch): HTMLElement {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'recent-item';
      item.setAttribute('role', 'menuitem');
      const livePreset = recent.presetId ? config.presets.find(p => p.id === recent.presetId) : undefined;
      // Three cases: (a) preset still exists → show its current name;
      // (b) preset id was recorded but the preset has since been deleted →
      // show the recorded name with a removed hint + stale styling;
      // (c) launch never carried a preset (Custom launch) → show the
      // localized "New session" placeholder, no removed hint.
      let presetLabel: string;
      if (livePreset) {
        presetLabel = livePreset.name;
      } else if (recent.presetId) {
        presetLabel = `${recent.presetNameSnapshot} (${t('recent.removed')})`;
        item.classList.add('stale');
      } else {
        presetLabel = t('session.new');
      }

      const main = document.createElement('span');
      main.className = 'recent-main';
      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = presetLabel;
      const sub = document.createElement('span');
      sub.className = 'recent-sub';
      sub.textContent = recent.cwd ? basename(recent.cwd) : t('recent.noCwd');
      main.appendChild(title);
      main.appendChild(sub);
      item.appendChild(main);

      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = formatRelTime(recent.lastUsedAt);
      item.appendChild(time);

      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'recent-forget';
      forget.title = t('recent.forget');
      forget.setAttribute('aria-label', t('recent.forget'));
      forget.textContent = '×';
      forget.onclick = (e) => { e.stopPropagation(); deps.conn.send({ type: 'launch.recent.forget', key: recent.key }); };
      item.appendChild(forget);

      const tooltip: string[] = [];
      const server = recent.serverId ? config.servers.find(s => s.id === recent.serverId) : undefined;
      const profile = recent.profileId ? config.profiles.find(p => p.id === recent.profileId) : undefined;
      const proxy = recent.proxyId ? config.proxies.find(p => p.id === recent.proxyId) : undefined;
      if (server) tooltip.push(`${t('launch.server')}: ${server.name}`);
      if (profile) tooltip.push(`${t('launch.profile')}: ${profile.name}`);
      if (recent.cwd) tooltip.push(`${t('launch.cwd')}: ${recent.cwd}`);
      if (recent.condaEnv) tooltip.push(`${t('launch.conda')}: ${recent.condaEnv}`);
      if (recent.resume) tooltip.push(`${t('launch.resume')}: ${recent.resume}`);
      if (proxy) tooltip.push(`${t('preset.proxy')}: ${proxy.name}`);
      tooltip.push(t('recent.tip'));
      item.title = tooltip.join('\n');

      item.onclick = (e) => {
        if ((e.target as HTMLElement).closest('.recent-forget')) return;
        setOpen(false);
        if (e.shiftKey) deps.bus.emit('launch:prefill', { recent });
        else deps.bus.emit('launch:relaunch', { recent });
      };
      return item;
    }
  }
}

function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function formatRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('recent.time.now');
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}
