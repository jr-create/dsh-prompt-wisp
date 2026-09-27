/**
 * Dev-only probe: inspect the raw shape of user/message and assistant/message
 * records in a real archive, so the digest filter can be checked against the
 * durable reality (not just the type contract).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const archive = process.argv[2];
const raw = gunzipSync(readFileSync(archive));
const records = raw.toString('utf8').split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);
const evs = records.filter((r) => r && r.type === 'event');
const um = evs.filter((r) => (r.event ?? r).type === 'user/message').slice(0, 3);
const am = evs.filter((r) => (r.event ?? r).type === 'assistant/message').slice(0, 2);
for (const r of um) console.log('USER:', JSON.stringify(r).slice(0, 500), '\n---');
for (const r of am) console.log('ASSISTANT:', JSON.stringify(r).slice(0, 500), '\n---');
