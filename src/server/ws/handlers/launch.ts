import { ClientMessage, PROFILE_FIELD_TO_ENV } from '../../../shared/protocol.js';
import { listCondaEnvs, listTargetDirectories } from '../../infrastructure/discovery/index.js';
import { probeProfileConnection } from '../../infrastructure/transport/profileProbe.js';
import { WsCtx } from '../connection.js';

type LaunchMessage = Extract<ClientMessage, { type: 'config.profile.test' | 'launch.cwd.list' | 'launch.conda.list' }>;

export function handleLaunchMessage(ctx: WsCtx, msg: LaunchMessage): void {
  switch (msg.type) {
    case 'config.profile.test': {
      const saved = msg.profile.id ? ctx.store.listProfiles().find(p => p.id === msg.profile.id) : undefined;
      const baseUrl = msg.profile.baseUrl ?? saved?.env[PROFILE_FIELD_TO_ENV.baseUrl];
      const authToken = msg.profile.authToken ?? saved?.env[PROFILE_FIELD_TO_ENV.authToken];
      const model = msg.profile.model ?? saved?.env[PROFILE_FIELD_TO_ENV.model];
      if (!baseUrl) {
        ctx.send({ type: 'config.profile.test.result', requestId: msg.requestId, ok: false, message: 'Base URL is required' });
        return;
      }
      if (!authToken) {
        ctx.send({ type: 'config.profile.test.result', requestId: msg.requestId, ok: false, message: 'Auth token is required for test' });
        return;
      }
      if (!model) {
        ctx.send({ type: 'config.profile.test.result', requestId: msg.requestId, ok: false, message: 'Model is required for test' });
        return;
      }
      probeProfileConnection({ baseUrl, authToken, model })
        .then(() => ctx.send({ type: 'config.profile.test.result', requestId: msg.requestId, ok: true, message: 'Connection ok' }))
        .catch((error) => ctx.send({ type: 'config.profile.test.result', requestId: msg.requestId, ok: false, message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    case 'launch.cwd.list': {
      const server = ctx.store.resolveServer({ preferredIds: [msg.serverId], fallbackTarget: ctx.defaultTarget });
      listTargetDirectories(server, msg.path, msg.exact, msg.includeFiles)
        .then((result) => ctx.send({ type: 'launch.cwd.list.result', requestId: msg.requestId, ...result }))
        .catch(() => ctx.send({ type: 'launch.cwd.list.result', requestId: msg.requestId, path: msg.path, entries: [] }));
      return;
    }
    case 'launch.conda.list': {
      const server = ctx.store.resolveServer({ preferredIds: [msg.serverId], fallbackTarget: ctx.defaultTarget });
      listCondaEnvs(server)
        .then((result) => ctx.send({ type: 'launch.conda.list.result', requestId: msg.requestId, ...result }))
        .catch((error) => ctx.send({ type: 'launch.conda.list.result', requestId: msg.requestId, envs: [], error: error instanceof Error ? error.message : String(error) }));
      return;
    }
  }
}
