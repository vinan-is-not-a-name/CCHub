import type { ClientMessage, ServerOs } from '../../../shared/protocol.js';

/**
 * Pure form-value → protocol-message serializers for the config cards. Kept free
 * of DOM access so the field-mapping and create/edit conditional logic can be
 * unit tested directly; the card views gather raw input values and delegate the
 * message construction here.
 */

export interface CardContext {
  editing: boolean;
  selectedId: string;
}

export interface ProfileFormValues {
  name: string;
  baseUrl: string;
  authToken: string;
  model: string;
  subagentModel: string;
  smallFastModel: string;
  clearAuthToken: boolean;
}

export interface ServerFormValues {
  name: string;
  kind: 'local' | 'ssh';
  os: string;
  host: string;
  port: string;
  username: string;
  password: string;
  key: string;
  clearPassword: boolean;
}

export interface PresetFormValues {
  name: string;
  serverId: string;
  profileId: string;
  cwd: string;
  conda: string;
  resume: string;
  skipPermissions: boolean;
  proxyId: string;
}

export interface ProxyFormValues {
  name: string;
  bindPort: string;
  host: string;
  port: string;
}

const idFor = (ctx: CardContext) => (ctx.editing ? ctx.selectedId || undefined : undefined);

export function buildProfileSaveMessage(form: ProfileFormValues, ctx: CardContext): ClientMessage {
  return { type: 'config.profile.save', profile: {
    id: idFor(ctx),
    name: form.name || 'Profile',
    clearAuthToken: ctx.editing && form.clearAuthToken,
    baseUrl: form.baseUrl || undefined,
    authToken: form.authToken || undefined,
    model: form.model || undefined,
    subagentModel: form.subagentModel || undefined,
    smallFastModel: form.smallFastModel || undefined,
  }};
}

export function buildProfileTestMessage(form: ProfileFormValues, ctx: CardContext, requestId: string): ClientMessage {
  return { type: 'config.profile.test', requestId, profile: {
    id: idFor(ctx),
    name: form.name || 'Provider',
    baseUrl: form.baseUrl || undefined,
    authToken: form.authToken || undefined,
    model: form.model || undefined,
  }};
}

export function buildServerSaveMessage(form: ServerFormValues, ctx: CardContext): ClientMessage {
  const id = idFor(ctx);
  const os = (form.os || 'linux') as ServerOs;
  if (form.kind === 'local') {
    return { type: 'config.server.save', server: { id, name: form.name || 'Local', kind: 'local', os } };
  }
  return { type: 'config.server.save', server: {
    id,
    name: form.name || form.host || 'SSH',
    kind: 'ssh',
    os,
    host: form.host,
    port: Number(form.port || 22),
    username: form.username,
    clearPassword: ctx.editing && form.clearPassword,
    password: form.password || undefined,
    privateKeyPath: form.key || undefined,
  }};
}

export function buildPresetSaveMessage(form: PresetFormValues, ctx: CardContext): ClientMessage {
  return { type: 'config.preset.save', preset: {
    id: idFor(ctx),
    name: form.name || 'Preset',
    serverId: form.serverId || undefined,
    anthropicProfileId: form.profileId || undefined,
    cwd: form.cwd || undefined,
    condaEnv: form.conda || undefined,
    resume: (form.resume as 'continue' | '') || undefined,
    skipPermissions: form.skipPermissions || undefined,
    proxyId: form.proxyId || undefined,
  }};
}

export function buildProxySaveMessage(form: ProxyFormValues, ctx: CardContext): ClientMessage {
  return { type: 'config.proxy.save', proxy: {
    id: idFor(ctx),
    name: form.name || 'Proxy',
    bindPort: Number(form.bindPort || 0),
    host: form.host,
    port: Number(form.port || 0),
  }};
}
