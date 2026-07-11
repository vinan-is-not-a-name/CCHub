// playwright.config.ts now writes the complete test config (local + ssh server,
// both presets, ssh test server keys) before each run, so this hook is a no-op.
// Kept as a placeholder so config: { globalSetup } stays valid.
export default async function globalSetup() {}
