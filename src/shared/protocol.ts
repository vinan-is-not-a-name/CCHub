// Aggregate barrel — kept so existing `from '../shared/protocol.js'` imports
// continue to work. Prefer importing from the more specific module when adding
// new code (domain.ts / dto.ts / messages.ts / envKeys.ts).
export * from './envKeys.js';
export * from './domain.js';
export * from './dto.js';
export * from './messages.js';
