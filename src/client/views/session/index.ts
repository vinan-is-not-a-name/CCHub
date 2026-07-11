import { buildLaunchOverrides } from '../../../shared/launchOverrides.js';
import { el } from '../../dom.js';
import { measureSize, applyLayout, reportedRows } from '../terminal.js';
import { isGridLayout } from '../layout.js';
import type { AppDeps } from '../../deps.js';
import { makeAttachController } from './attach.js';
import { makeMessageRouter, type NotifyHandle } from './messageRouter.js';

export function mountSessionView(deps: AppDeps, params: URLSearchParams, notify?: NotifyHandle): void {
  const launchDialog = el<HTMLDialogElement>('launch-dialog');
  const attach = makeAttachController(deps);
  const openLaunchDialog = () => { if (!launchDialog.open) deps.bus.emit('launch:open'); };

  // Reflect the persisted layout on the empty container before any session
  // exists, so the toggle's initial highlight matches what's on screen.
  applyLayout(deps.container, deps.store.get().ui.layoutMode);

  deps.bus.on('session:activate', (id) => attach.activate(id, true));
  deps.bus.on('layout:change', (mode) => attach.setLayout(mode));

  deps.bus.on('launch:create', (input) => {
    const launch = buildLaunchOverrides({
      serverId: input.serverId,
      profileId: input.profileId,
      cwd: input.cwd,
      condaEnv: input.condaEnv,
      resume: input.resume,
    });
    create({ presetId: input.presetId, launch });
  });

  // Recent-chip re-launch bypasses the form: the RecentLaunch already carries
  // resolved identity (preset/server/profile/cwd/conda/resume), so we hand it
  // straight to session.create instead of round-tripping through the dialog.
  deps.bus.on('launch:relaunch', ({ recent }) => {
    create({
      presetId: recent.presetId,
      launch: {
        serverId: recent.serverId,
        anthropicProfileId: recent.profileId,
        cwd: recent.cwd,
        condaEnv: recent.condaEnv ?? '',
        resume: recent.resume ?? '',
      },
    });
  });

  function create(options: { presetId?: string; launch?: ReturnType<typeof buildLaunchOverrides> } = {}) {
    const state = deps.store.get();
    if (state.creatingSession) return;
    deps.store.set('creatingSession', true);
    deps.store.patchUi({ preserveLaunchValues: false });
    const { cols, rows } = measureSize(deps.container);
    const target = params.get('target') === 'ssh' ? 'ssh' : undefined;
    const cwd = params.get('sshCwd') ?? params.get('cwd') ?? undefined;
    deps.conn.send({ type: 'session.create', cols, rows: reportedRows(rows), target, cwd, ...options });
  }

  deps.conn.onMessage(makeMessageRouter(deps, attach, openLaunchDialog, notify));

  window.addEventListener('resize', () => {
    const s = deps.store.get();
    // Grid mode shows every terminal at once, so all of them must refit; tabs
    // mode only needs the active one.
    if (isGridLayout(s.ui.layoutMode)) {
      for (const session of s.sessions.values()) session.terminal.fit.fit();
    } else {
      const active = s.activeId ? s.sessions.get(s.activeId) : null;
      if (active) active.terminal.fit.fit();
    }
  });
}
