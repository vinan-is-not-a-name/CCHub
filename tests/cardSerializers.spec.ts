import { test, expect } from '@playwright/test';
import {
  buildProfileSaveMessage,
  buildProfileTestMessage,
  buildServerSaveMessage,
  buildPresetSaveMessage,
  buildProxySaveMessage,
  type ProfileFormValues,
  type ServerFormValues,
  type PresetFormValues,
  type ProxyFormValues,
} from '../src/client/views/cards/cardSerializers.js';

const profileForm: ProfileFormValues = {
  name: 'TestProfile',
  baseUrl: 'https://api.test',
  authToken: 'token123',
  model: 'claude-4',
  subagentModel: 'opus-3',
  smallFastModel: 'haiku-3',
  clearAuthToken: false,
};

const serverLocalForm: ServerFormValues = {
  name: 'Local',
  kind: 'local',
  os: 'linux',
  host: '',
  port: '',
  username: '',
  password: '',
  key: '',
  clearPassword: false,
};

const serverSshForm: ServerFormValues = {
  name: 'MySSH',
  kind: 'ssh',
  os: 'linux',
  host: '192.0.2.100',
  port: '2222',
  username: 'user',
  password: 'pass',
  key: '/path/to/key',
  clearPassword: false,
};

const presetForm: PresetFormValues = {
  name: 'MyPreset',
  serverId: 's1',
  profileId: 'p1',
  cwd: '/workspace',
  conda: 'myenv',
  resume: 'continue',
  skipPermissions: false,
  proxyId: '',
  effort: '',
};

const proxyForm: ProxyFormValues = {
  name: 'Corp',
  bindPort: '1080',
  host: '192.0.2.42',
  port: '7890',
};

test.describe('buildProfileSaveMessage', () => {
  test('create mode omits id and applies name default', () => {
    const msg = buildProfileSaveMessage({ ...profileForm, name: '' }, { editing: false, selectedId: 'p1' });
    expect(msg).toEqual({
      type: 'config.profile.save',
      profile: {
        id: undefined,
        name: 'Profile',
        clearAuthToken: false,
        baseUrl: 'https://api.test',
        authToken: 'token123',
        model: 'claude-4',
        subagentModel: 'opus-3',
        smallFastModel: 'haiku-3',
      },
    });
  });

  test('edit mode includes id and honors clearAuthToken', () => {
    const msg = buildProfileSaveMessage({ ...profileForm, clearAuthToken: true }, { editing: true, selectedId: 'p1' });
    expect(msg.profile.id).toBe('p1');
    expect(msg.profile.clearAuthToken).toBe(true);
  });

  test('empty optional fields become undefined', () => {
    const msg = buildProfileSaveMessage({ ...profileForm, baseUrl: '', authToken: '', model: '' }, { editing: false, selectedId: '' });
    expect(msg.profile.baseUrl).toBeUndefined();
    expect(msg.profile.authToken).toBeUndefined();
    expect(msg.profile.model).toBeUndefined();
  });
});

test.describe('buildProfileTestMessage', () => {
  test('includes requestId and subset of profile fields', () => {
    const msg = buildProfileTestMessage(profileForm, { editing: false, selectedId: '' }, 'req-123');
    expect(msg).toEqual({
      type: 'config.profile.test',
      requestId: 'req-123',
      profile: {
        id: undefined,
        name: 'TestProfile',
        baseUrl: 'https://api.test',
        authToken: 'token123',
        model: 'claude-4',
      },
    });
  });

  test('applies name default of Provider when empty', () => {
    const msg = buildProfileTestMessage({ ...profileForm, name: '' }, { editing: false, selectedId: '' }, 'r2');
    expect(msg.profile.name).toBe('Provider');
  });
});

test.describe('buildServerSaveMessage', () => {
  test('local server includes only kind, name, and os', () => {
    const msg = buildServerSaveMessage(serverLocalForm, { editing: false, selectedId: '' });
    expect(msg).toEqual({
      type: 'config.server.save',
      server: { id: undefined, name: 'Local', kind: 'local', os: 'linux' },
    });
  });

  test('local server applies os default when empty', () => {
    const msg = buildServerSaveMessage({ ...serverLocalForm, os: '' }, { editing: false, selectedId: '' });
    expect(msg.server.os).toBe('linux');
  });

  test('local server applies name default when empty', () => {
    const msg = buildServerSaveMessage({ ...serverLocalForm, name: '' }, { editing: false, selectedId: '' });
    expect(msg.server.name).toBe('Local');
  });

  test('ssh server includes host, port, auth fields', () => {
    const msg = buildServerSaveMessage(serverSshForm, { editing: false, selectedId: '' });
    expect(msg.server).toMatchObject({
      kind: 'ssh',
      host: '192.0.2.100',
      port: 2222,
      username: 'user',
      password: 'pass',
      privateKeyPath: '/path/to/key',
      clearPassword: false,
    });
  });

  test('ssh server applies port default of 22 when empty', () => {
    const msg = buildServerSaveMessage({ ...serverSshForm, port: '' }, { editing: false, selectedId: '' });
    expect(msg.server).toMatchObject({ port: 22 });
  });

  test('ssh server uses host as name fallback', () => {
    const msg = buildServerSaveMessage({ ...serverSshForm, name: '' }, { editing: false, selectedId: '' });
    expect(msg.server.name).toBe('192.0.2.100');
  });

  test('ssh server uses SSH as final name fallback', () => {
    const msg = buildServerSaveMessage({ ...serverSshForm, name: '', host: '' }, { editing: false, selectedId: '' });
    expect(msg.server.name).toBe('SSH');
  });

  test('ssh server clearPassword only true in edit mode', () => {
    const form = { ...serverSshForm, clearPassword: true };
    const createMsg = buildServerSaveMessage(form, { editing: false, selectedId: 's1' });
    const editMsg = buildServerSaveMessage(form, { editing: true, selectedId: 's1' });
    expect(createMsg.server).toMatchObject({ clearPassword: false });
    expect(editMsg.server).toMatchObject({ clearPassword: true });
  });

  test('edit mode includes id', () => {
    const msg = buildServerSaveMessage(serverLocalForm, { editing: true, selectedId: 's1' });
    expect(msg.server.id).toBe('s1');
  });
});

test.describe('buildPresetSaveMessage', () => {
  test('create mode omits id and includes all fields', () => {
    const msg = buildPresetSaveMessage(presetForm, { editing: false, selectedId: 'pr1' });
    expect(msg).toEqual({
      type: 'config.preset.save',
      preset: {
        id: undefined,
        name: 'MyPreset',
        serverId: 's1',
        anthropicProfileId: 'p1',
        cwd: '/workspace',
        condaEnv: 'myenv',
        resume: 'continue',
      },
    });
  });

  test('edit mode includes id', () => {
    const msg = buildPresetSaveMessage(presetForm, { editing: true, selectedId: 'pr1' });
    expect(msg.preset.id).toBe('pr1');
  });

  test('applies name default', () => {
    const msg = buildPresetSaveMessage({ ...presetForm, name: '' }, { editing: false, selectedId: '' });
    expect(msg.preset.name).toBe('Preset');
  });

  test('empty optional fields become undefined', () => {
    const msg = buildPresetSaveMessage({
      name: 'P', serverId: '', profileId: '', cwd: '', conda: '', resume: '', skipPermissions: false, proxyId: '',
    }, { editing: false, selectedId: '' });
    expect(msg.preset.serverId).toBeUndefined();
    expect(msg.preset.anthropicProfileId).toBeUndefined();
    expect(msg.preset.cwd).toBeUndefined();
    expect(msg.preset.condaEnv).toBeUndefined();
    expect(msg.preset.resume).toBeUndefined();
    expect(msg.preset.skipPermissions).toBeUndefined();
    expect(msg.preset.proxyId).toBeUndefined();
  });

  test('skipPermissions and proxyId pass through when set', () => {
    const msg = buildPresetSaveMessage({ ...presetForm, skipPermissions: true, proxyId: 'px1' }, { editing: false, selectedId: '' });
    expect(msg.preset.skipPermissions).toBe(true);
    expect(msg.preset.proxyId).toBe('px1');
  });

  test('effort passes through when set, undefined when empty', () => {
    const withEffort = buildPresetSaveMessage({ ...presetForm, effort: 'medium' }, { editing: false, selectedId: '' });
    expect(withEffort.preset.effort).toBe('medium');
    const withoutEffort = buildPresetSaveMessage({ ...presetForm, effort: '' }, { editing: false, selectedId: '' });
    expect(withoutEffort.preset.effort).toBeUndefined();
  });
});

test.describe('buildProxySaveMessage', () => {
  test('create mode omits id and coerces ports to numbers', () => {
    const msg = buildProxySaveMessage(proxyForm, { editing: false, selectedId: 'px1' });
    expect(msg).toEqual({
      type: 'config.proxy.save',
      proxy: { id: undefined, name: 'Corp', bindPort: 1080, host: '192.0.2.42', port: 7890 },
    });
  });

  test('edit mode includes id', () => {
    const msg = buildProxySaveMessage(proxyForm, { editing: true, selectedId: 'px1' });
    expect(msg.proxy.id).toBe('px1');
  });

  test('applies name default when empty', () => {
    const msg = buildProxySaveMessage({ ...proxyForm, name: '' }, { editing: false, selectedId: '' });
    expect(msg.proxy.name).toBe('Proxy');
  });
});
