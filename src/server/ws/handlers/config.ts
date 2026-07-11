import {
  ClientMessage,
  PresetWriteRequest,
  ProfileWriteRequest,
  ProxyWriteRequest,
  SafeConfigSnapshot,
  ServerWriteRequest,
  profileFieldsToEnv,
} from '../../../shared/protocol.js';
import { ConfigService } from '../../domain/config/index.js';
import { WsCtx } from '../connection.js';

type ConfigMessage = Extract<ClientMessage, {
  type:
    | 'config.get'
    | 'config.profile.save'
    | 'config.profile.delete'
    | 'config.profile.copy'
    | 'config.server.save'
    | 'config.server.delete'
    | 'config.server.copy'
    | 'config.preset.save'
    | 'config.preset.delete'
    | 'config.preset.copy'
    | 'config.proxy.save'
    | 'config.proxy.delete'
    | 'config.proxy.copy'
    | 'config.settings.save'
    | 'config.settings.detect'
    | 'launch.recent.forget'
    | 'launch.recent.clear';
}>;

export function handleConfigMessage(ctx: WsCtx, msg: ConfigMessage): void {
  switch (msg.type) {
    case 'config.get':
      ctx.send({ type: 'config.snapshot', config: ctx.store.getSnapshot() });
      return;
    case 'config.settings.save':
      ctx.send({
        type: 'config.snapshot',
        config: ctx.store.saveAppSettings({ xshellPath: msg.xshellPath, xftpPath: msg.xftpPath, vscodePath: msg.vscodePath }),
      });
      return;
    case 'config.settings.detect':
      void ctx.detectApps().then((paths) => {
        ctx.send({ type: 'config.settings.detected', requestId: msg.requestId, ...paths });
      });
      return;
    case 'config.profile.save':
      ctx.send({ type: 'config.profile.saved', config: saveProfile(ctx.store, msg.profile) });
      return;
    case 'config.profile.delete':
      ctx.send({ type: 'config.snapshot', config: ctx.store.deleteProfile(msg.id) });
      return;
    case 'config.profile.copy': {
      const copied = ctx.store.copyProfile(msg.id);
      ctx.send({ type: 'config.profile.saved', config: copied.config, selectedId: copied.selectedId });
      return;
    }
    case 'config.server.save':
      ctx.send({ type: 'config.server.saved', config: saveServer(ctx.store, msg.server) });
      return;
    case 'config.server.delete':
      ctx.send({ type: 'config.snapshot', config: ctx.store.deleteServer(msg.id) });
      return;
    case 'config.server.copy': {
      const copied = ctx.store.copyServer(msg.id);
      ctx.send({ type: 'config.server.saved', config: copied.config, selectedId: copied.selectedId });
      return;
    }
    case 'config.preset.save':
      ctx.send({ type: 'config.preset.saved', config: savePreset(ctx.store, msg.preset) });
      return;
    case 'config.preset.delete':
      ctx.send({ type: 'config.snapshot', config: ctx.store.deletePreset(msg.id) });
      return;
    case 'config.preset.copy': {
      const copied = ctx.store.copyPreset(msg.id);
      ctx.send({ type: 'config.preset.saved', config: copied.config, selectedId: copied.selectedId });
      return;
    }
    case 'config.proxy.save':
      ctx.send({ type: 'config.proxy.saved', config: saveProxy(ctx.store, msg.proxy) });
      return;
    case 'config.proxy.delete':
      ctx.send({ type: 'config.snapshot', config: ctx.store.deleteProxy(msg.id) });
      return;
    case 'config.proxy.copy': {
      const copied = ctx.store.copyProxy(msg.id);
      ctx.send({ type: 'config.proxy.saved', config: copied.config, selectedId: copied.selectedId });
      return;
    }
    case 'launch.recent.forget':
      ctx.send({ type: 'config.snapshot', config: ctx.store.forgetRecentLaunch(msg.key) });
      return;
    case 'launch.recent.clear':
      ctx.send({ type: 'config.snapshot', config: ctx.store.clearRecentLaunches() });
      return;
  }
}

function saveProfile(store: ConfigService, p: ProfileWriteRequest): SafeConfigSnapshot {
  return store.saveProfile({
    id: p.id,
    name: p.name,
    clearAuthToken: p.clearAuthToken,
    env: profileFieldsToEnv(p),
  });
}

function saveServer(store: ConfigService, s: ServerWriteRequest): SafeConfigSnapshot {
  return store.saveServer({
    id: s.id,
    name: s.name,
    kind: s.kind,
    os: s.os,
    host: s.host,
    port: s.port,
    username: s.username,
    clearPassword: s.clearPassword,
    auth: s.kind === 'ssh' ? {
      method: s.privateKeyPath ? 'privateKeyPath' : 'password',
      password: s.password || undefined,
      privateKeyPath: s.privateKeyPath || undefined,
    } : undefined,
  });
}

function savePreset(store: ConfigService, p: PresetWriteRequest): SafeConfigSnapshot {
  return store.savePreset({
    id: p.id,
    name: p.name,
    serverId: p.serverId,
    cwd: p.cwd,
    anthropicProfileId: p.anthropicProfileId,
    condaEnv: p.condaEnv,
    resume: p.resume,
    skipPermissions: p.skipPermissions,
    proxyId: p.proxyId,
  });
}

function saveProxy(store: ConfigService, p: ProxyWriteRequest): SafeConfigSnapshot {
  return store.saveProxy({
    id: p.id,
    name: p.name,
    bindPort: p.bindPort,
    host: p.host,
    port: p.port,
  });
}
