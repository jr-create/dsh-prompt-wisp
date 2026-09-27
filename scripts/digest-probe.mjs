/**
 * Dev-only probe: replay buildConversationDigest against a real archived
 * session's normalized event stream (exported via dsh-session-vault).
 * Not shipped in `files`; run manually with `node scripts/digest-probe.mjs <archive>`.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildConversationDigest, CONTEXT_SCAN_EVENTS } from '../lib/engine.js';

const archive = process.argv[2];
if (!archive) {
  console.error('usage: node scripts/digest-probe.mjs <path/to/export.dshsession>');
  process.exit(1);
}
const raw = gunzipSync(readFileSync(archive));
const records = raw.toString('utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);
console.log('archive records:', records.length);
// Record shapes: {type:'header'|'session'|'event'|'session-end'|'footer', ...}
const evs = records
  .filter((r) => r && r.type === 'event')
  .map((r) => (r.event !== undefined ? r.event : r));
console.log('event records:', evs.length);
const typeCounts = {};
for (const e of evs) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
console.log('event types:', JSON.stringify(typeCounts));
const result = buildConversationDigest(evs.slice(-CONTEXT_SCAN_EVENTS));
console.log('totalTurns:', result.totalTurns, '| included:', result.included, '| truncated:', result.truncated);
console.log('--- digest head ---');
console.log(result.digest.split('\n').slice(0, 8).join('\n').slice(0, 700));
