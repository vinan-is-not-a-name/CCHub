/**
 * Pre-seed a Claude Code user config so it boots straight into the REPL
 * without any interactive first-run UI.
 *
 * CI installs the latest claude via `npm install -g @anthropic-ai/claude-code`
 * with no ANTHROPIC_API_KEY secret. In that state the native CLI (2.1.223+)
 * shows first-run dialogs that block the e2e suite:
 *
 *   1. "Select login method" onboarding           -> hasCompletedOnboarding
 *   2. "Welcome back / What's new" banner         -> lastReleaseNotesSeen
 *   3. "Do you trust this folder?" dialog         -> projects[<cwd>].hasTrustDialogAccepted
 *
 * All three live in the user-level ~/.claude.json that cc itself writes, so
 * this mirrors a finished first run instead of inventing new variables.
 * Version fields are set to '99.0.0' — beyond any real release — so the
 * banner logic never fires again as claude updates. Trust covers the cwd
 * spellings the e2e suite uses (/tmp on POSIX, D:\temp / D:\ on Windows),
 * plus their canonical variants, because the native cc's exact project-key
 * form is not documented.
 *
 * CCHUB_ONBOARD_HOME overrides the home dir — used by the unit test and for
 * local dry-runs; CI runs it unset against the real runner home.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = process.env.CCHUB_ONBOARD_HOME || os.homedir();
const configPath = path.join(home, '.claude.json');
fs.mkdirSync(home, { recursive: true });

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  // Fresh home — start from the empty shape.
}

const TRUST = { hasTrustDialogAccepted: true };
const trusted = {
  '/tmp': TRUST,
  'D:\\temp': TRUST,
  'D:\\': TRUST,
  'D:/temp': TRUST,
  'D:/': TRUST,
  'd:\\temp': TRUST,
  'd:\\': TRUST,
};

config.hasCompletedOnboarding = true;
config.lastOnboardingVersion = '99.0.0';
config.lastReleaseNotesSeen = '99.0.0';
config.projects = { ...(config.projects || {}), ...trusted };

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`onboarded claude config at ${configPath}`);
