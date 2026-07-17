import { ClientMessage, PROFILE_FIELD_TO_ENV } from '../../../shared/protocol.js';
import { createTargetDirectory, listCondaEnvs, listTargetDirectories } from '../../infrastructure/discovery/index.js';
import { MkdirError } from '../../infrastructure/discovery/directoryList.js';
import { probeProfileConnection } from '../../infrastructure/transport/profileProbe.js';
import { cchubKeyPaths, checkKeyInstalled, ensureCchubKeyPair, installKey, readCchubPublicKey, regenerateCchubKeyPair } from '../../infrastructure/shell/sshKeys.js';
import { WsCtx } from '../connection.js';

type LaunchMessage = Extract<ClientMessage, {
  type:
    | 'config.profile.test'
    | 'config.sshkey.get'
    | 'config.sshkey.generate'
    | 'config.sshkey.check'
    | 'config.sshkey.install'
    | 'launch.cwd.list'
    | 'launch.cwd.mkdir'
    | 'launch.conda.list';
}>;

/** Resolve a serverId to an SSH profile, or null when it's missing / local.
 * The XShell key only makes sense for SSH targets — a local server has no
 * remote authorized_keys to install into. */
function sshServerById(ctx: WsCtx, serverId: string) {
  const server = ctx.store.getServer(serverId);
  return server && server.kind === 'ssh' ? server : null;
}

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
    case 'config.sshkey.get': {
      const publicKey = readCchubPublicKey();
      ctx.send({ type: 'config.sshkey.info', publicKey, privateKeyPath: publicKey ? cchubKeyPaths().privatePath : null });
      return;
    }
    case 'config.sshkey.generate': {
      // First-time users have no pair yet, so `generate` doubles as `create`;
      // an existing pair is deliberately replaced (the user asked to
      // regenerate, accepting that they must re-import + re-install it).
      const publicKey = readCchubPublicKey() ? regenerateCchubKeyPair() : ensureCchubKeyPair();
      ctx.send({ type: 'config.sshkey.info', publicKey, privateKeyPath: cchubKeyPaths().privatePath });
      return;
    }
    case 'config.sshkey.check': {
      const server = sshServerById(ctx, msg.serverId);
      if (!server) {
        ctx.send({ type: 'config.sshkey.checked', serverId: msg.serverId, requestId: msg.requestId, installed: null, error: 'not an SSH server' });
        return;
      }
      checkKeyInstalled(server)
        .then((installed) => ctx.send({ type: 'config.sshkey.checked', serverId: msg.serverId, requestId: msg.requestId, installed }))
        .catch((error) => ctx.send({ type: 'config.sshkey.checked', serverId: msg.serverId, requestId: msg.requestId, installed: null, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    case 'config.sshkey.install': {
      const server = sshServerById(ctx, msg.serverId);
      if (!server) {
        ctx.send({ type: 'config.sshkey.installed', serverId: msg.serverId, requestId: msg.requestId, ok: false, error: 'not an SSH server' });
        return;
      }
      installKey(server)
        .then((result) => ctx.send({ type: 'config.sshkey.installed', serverId: msg.serverId, requestId: msg.requestId, ok: true, alreadyInstalled: result.alreadyInstalled }))
        .catch((error) => ctx.send({ type: 'config.sshkey.installed', serverId: msg.serverId, requestId: msg.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    case 'launch.cwd.list': {
      const server = ctx.store.resolveServer({ preferredIds: [msg.serverId], fallbackTarget: ctx.defaultTarget });
      listTargetDirectories(server, msg.path, msg.exact, msg.includeFiles)
        .then((result) => ctx.send({ type: 'launch.cwd.list.result', requestId: msg.requestId, ...result }))
        .catch(() => ctx.send({ type: 'launch.cwd.list.result', requestId: msg.requestId, path: msg.path, entries: [] }));
      return;
    }
    case 'launch.cwd.mkdir': {
      const server = ctx.store.resolveServer({ preferredIds: [msg.serverId], fallbackTarget: ctx.defaultTarget });
      createTargetDirectory(server, msg.parent, msg.name)
        .then((path) => ctx.send({ type: 'launch.cwd.mkdir.result', requestId: msg.requestId, ok: true, path }))
        .catch((error) => ctx.send({ type: 'launch.cwd.mkdir.result', requestId: msg.requestId, ok: false, error: error instanceof MkdirError ? error.code : 'failed' }));
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
