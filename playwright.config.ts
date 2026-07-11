import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir, homedir, platform } from 'os';
import { join } from 'path';
import { startSshTestServer } from './tests/sshTestServer.js';

// Test config dir — fresh per CI run, fixed locally for debugging.
const testConfigDir = process.env.CI
  ? mkdtempSync(join(tmpdir(), 'cchub-e2e-'))
  : join(homedir(), '.cchub-e2e');
mkdirSync(testConfigDir, { recursive: true });
const testConfigPath = join(testConfigDir, 'config.json');

// In-process SSH server: replaces the host's sshd so SSH-path tests are not
// gated on environment setup. The server lives until playwright tears the
// global runner down (`globalTeardown`).
const ssh = await startSshTestServer({ keyDir: join(testConfigDir, 'ssh') });
process.on('exit', () => { void ssh.close(); });

// Test cwd safety: keep all session-runs inside D:\temp (or /tmp on POSIX) so
// a runaway claude can't write into the project tree.
const TEST_CWD = platform() === 'win32' ? 'D:\\temp' : '/tmp';
mkdirSync(TEST_CWD, { recursive: true });

// Seed the test config so both 'cchub' and 'cchub ssh' presets are
// always present. The server consumes this on first boot.
const now = Date.now();
const localServerId = 'local-default';
const sshServerId = 'ssh-test';
const localPresetId = 'preset-cchub';
const sshPresetId = 'preset-cchub-ssh';
writeFileSync(testConfigPath, JSON.stringify({
  version: 1,
  profiles: [],
  servers: [
    {
      id: localServerId, name: 'Local', kind: 'local',
      os: platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux',
      createdAt: now, updatedAt: now,
    },
    {
      id: sshServerId, name: 'ssh-test', kind: 'ssh',
      os: platform() === 'win32' ? 'windows' : 'linux',
      host: ssh.host, port: ssh.port, username: ssh.username,
      auth: { method: 'privateKeyPath', privateKeyPath: ssh.privateKeyPath },
      createdAt: now, updatedAt: now,
    },
  ],
  presets: [
    {
      id: localPresetId, name: 'cchub', serverId: localServerId,
      cwd: TEST_CWD,
      resume: 'continue', createdAt: now, updatedAt: now,
    },
    {
      id: sshPresetId, name: 'cchub ssh', serverId: sshServerId,
      cwd: TEST_CWD,
      resume: 'continue', createdAt: now, updatedAt: now,
    },
  ],
  defaults: { serverId: localServerId, presetId: localPresetId },
}, null, 2));

// Env propagated to all test workers + the cchub webServer.
const TEST_ENV = {
  TEST_HAS_CLAUDE: 'true',
  TEST_LOCAL_PRESET: 'cchub',
  TEST_REMOTE_PRESET: 'cchub ssh',
  TEST_SSH_KEY_PATH: ssh.privateKeyPath,
  TEST_SSH_USER: ssh.username,
  TEST_SSH_HOST: ssh.host,
  TEST_SSH_PORT: String(ssh.port),
  TEST_SSH_SERVER_ID: sshServerId,
};
for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/globalSetup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:3001',
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Exclusion-based: any *.spec.ts that isn't integration/e2e is a unit test
      // and runs here automatically. New unit specs need no config change — the
      // old explicit allowlist silently skipped any spec not listed.
      name: 'unit',
      testMatch: /.*\.spec\.ts$/,
      testIgnore: ['**/integration.spec.ts', '**/e2e.spec.ts', '**/*.e2e.spec.ts'],
      use: {},
    },
    {
      name: 'integration',
      testMatch: '**/integration.spec.ts',
      use: {},
    },
    {
      name: 'chromium',
      testMatch: [/e2e\.spec\.ts$/],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: [/e2e\.spec\.ts$/],
      use: {
        ...devices['Desktop Firefox'],
        // This host has a system PAC (AutoConfigURL) that routes even loopback
        // through a local proxy. Playwright's Firefox defaults to
        // allow_hijacking_localhost=true, so 127.0.0.1 gets sent to that proxy
        // and page.goto hangs. Force a direct connection for the test browser.
        launchOptions: { firefoxUserPrefs: { 'network.proxy.type': 0 } },
      },
    },
    {
      name: 'webkit',
      testMatch: [/e2e\.spec\.ts$/],
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: `node dist/server/entry/index.js`,
    url: 'http://127.0.0.1:3001',
    reuseExistingServer: false,
    env: { CCHUB_CONFIG: testConfigPath, CCHUB_PORT: '3001', ...TEST_ENV },
  },
});
