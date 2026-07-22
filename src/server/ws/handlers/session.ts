import { ClientMessage, ResolvedLaunch } from '../../../shared/protocol.js';
import { resolveLaunch } from '../../application/launch.js';
import { WsCtx } from '../connection.js';

type SessionMessage = Extract<ClientMessage, { type: 'input' | 'resize' | 'session.create' | 'session.attach' | 'session.destroy' | 'session.reorder' | 'session.list' }>;
type CreateMessage = Extract<ClientMessage, { type: 'session.create' }>;

export function handleSessionMessage(ctx: WsCtx, msg: SessionMessage): void {
  switch (msg.type) {
    case 'input': {
      const session = ctx.targetSession(msg.id);
      session?.recordUserInput();
      session?.write(msg.data);
      return;
    }
    case 'resize':
      ctx.targetSession(msg.id)?.resize(msg.cols, msg.rows);
      return;
    case 'session.create': {
      const launch = resolveLaunch(msg, ctx.store, ctx.defaultTarget);
      const session = ctx.manager.create(launch, msg.cols, msg.rows);
      recordRecent(ctx, msg, launch);
      ctx.send({ type: 'session.created', session: session.getInfo() });
      // Push the updated snapshot so the topbar dropdown picks up the new
      // recent entry without needing a manual config.get. Mirrors the same
      // send-after-mutate contract config.*.saved handlers use.
      ctx.send({ type: 'config.snapshot', config: ctx.store.getSnapshot() });
      return;
    }
    case 'session.attach': {
      const session = ctx.manager.get(msg.id);
      if (session) ctx.subscribe(session, { focus: msg.focus ?? true, history: msg.history ?? true });
      else ctx.send({ type: 'error', message: 'session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }
    case 'session.destroy': {
      ctx.unsubscribe(msg.id);
      ctx.manager.destroy(msg.id);
      ctx.send({ type: 'session.destroyed', id: msg.id });
      return;
    }
    case 'session.reorder':
      // Fire-and-forget: the client already applied the reorder optimistically
      // via Store.reorderSession. Server persistence is what makes the order
      // survive a page refresh — a subsequent session.list echoes it back.
      ctx.manager.reorder(msg.id, msg.toIndex);
      return;
    case 'session.list':
      ctx.send({ type: 'session.list', sessions: ctx.manager.list() });
      return;
  }
}

/** Snapshot the just-launched identity into recentLaunches so the topbar
 * dropdown can re-launch the same combination in one click. Uses the raw
 * request for identity ids (resolveLaunch drops them) and the ResolvedLaunch
 * for the fields it authoritatively decides (cwd/condaEnv/resume/name). Any
 * ambiguous id falls through the same defaults ladder resolveLaunch used, so
 * a chip built here re-resolves back to the same server/profile/proxy. */
function recordRecent(ctx: WsCtx, msg: CreateMessage, launch: ResolvedLaunch): void {
  const defaults = ctx.store.getDefaults();
  // Preset is opt-in — same rule as resolveLaunch. If the caller didn't
  // pass presetId, the entry is a genuine Custom launch and its history
  // chip renders as "New session" (see topbar recentItem three-case).
  const presetId = msg.presetId;
  const preset = ctx.store.getPreset(presetId);
  ctx.store.recordRecentLaunch({
    presetId,
    serverId: msg.launch?.serverId ?? preset?.serverId ?? defaults.serverId,
    profileId: msg.launch?.anthropicProfileId ?? preset?.anthropicProfileId ?? defaults.profileId,
    // Effective proxy the launch used: override wins over preset (mirrors
    // resolveLaunch's `launch.proxyId ?? preset?.proxyId`). An explicit '' —
    // "None over a preset proxy" — is preserved so re-launch reproduces it
    // rather than falling back to the preset's proxy.
    proxyId: msg.launch?.proxyId ?? preset?.proxyId,
    cwd: launch.cwd,
    condaEnv: launch.condaEnv,
    resume: launch.resume === 'continue' ? 'continue' : undefined,
    // Snapshot the resolved skip/effort (already layered launch>preset by
    // resolveLaunch) so a re-launch reproduces them.
    skipPermissions: launch.skipPermissions,
    effort: launch.effort,
    presetNameSnapshot: launch.presetName ?? 'Custom',
  });
}
