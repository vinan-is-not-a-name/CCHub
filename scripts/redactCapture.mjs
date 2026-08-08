/**
 * Turn a raw CCHUB_RECORD_PTY capture into a committable fixture.
 *
 *   node scripts/redactCapture.mjs <in.raw> <out.raw> [--user <name>]
 *
 * Redaction is length-preserving (see tests/support/redactPty.ts for why), and
 * the output is re-scanned before it is written: if anything identifying is
 * still there, nothing is written and the command exits non-zero. That ordering
 * is the point — a capture that can't be cleaned must not land on disk in the
 * repo, where the next `git add -A` would sweep it in.
 *
 * Run through tsx so the redactor stays a single .ts module shared with the
 * specs rather than being duplicated in JS.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { redactPtyCapture, assertRedacted } from '../tests/support/redactPty.ts';

const argv = process.argv.slice(2);
const flagAt = argv.indexOf('--user');
const userName = flagAt >= 0 ? argv[flagAt + 1] : undefined;
const positional = argv.filter((a, i) => a !== '--user' && i !== flagAt + 1);
const [input, output] = positional;

if (!input || !output) {
  console.error('usage: node scripts/redactCapture.mjs <in.raw> <out.raw> [--user <name>]');
  process.exit(2);
}

const raw = readFileSync(resolve(input), 'utf8');
const { text, redactions } = redactPtyCapture(raw, { userName });

// Verify before writing, so a failure leaves no partially-clean artifact.
assertRedacted(text, input);

writeFileSync(resolve(output), text, 'utf8');

const byKind = new Map();
for (const r of redactions) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
const summary = [...byKind].map(([k, n]) => `${k}=${n}`).join(' ') || 'nothing matched';
console.log(`${input} -> ${output}`);
console.log(`  ${raw.length} bytes in, ${text.length} bytes out (length preserved)`);
console.log(`  redactions: ${summary}`);
