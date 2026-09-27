/**
 * Config tests: normalization discipline, directive composition, and the
 * durable store (against a temp DSH_HOME — the store resolves via env).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  buildConfigDirectives,
  composeSystemPrompt,
  normalizeConfig,
} from '../lib/config.js';
import { configFilePath, readConfig, writeConfig } from '../lib/store.js';

test('normalizeConfig is liberal: unknown keys drop, wrong types coerce to defaults', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig('nonsense'), DEFAULT_CONFIG);
  assert.deepEqual(
    normalizeConfig({ trimFiller: true, detailMode: 'yes', unknown: 1 }),
    { trimFiller: true, detailMode: false },
    'non-boolean detailMode falls back, unknown key drops',
  );
  assert.deepEqual(normalizeConfig({ trimFiller: 1 }), { trimFiller: false, detailMode: false });
});

test('buildConfigDirectives is empty on defaults and encodes each mode', () => {
  assert.equal(buildConfigDirectives({ trimFiller: false, detailMode: false }), '');
  const both = buildConfigDirectives({ trimFiller: true, detailMode: true });
  assert.match(both, /A\. 去废话/);
  assert.match(both, /B\. 详细优化/);
  const trimOnly = buildConfigDirectives({ trimFiller: true, detailMode: false });
  assert.match(trimOnly, /A\. 去废话/);
  assert.doesNotMatch(trimOnly, /B\. 详细优化/);
});

test('composeSystemPrompt picks the compact or detail face by mode', async () => {
  const { OPTIMIZER_SYSTEM_PROMPT } = await import('../lib/engine.js');
  // Detail mode: the full base prompt (plus trim directive when on).
  const detail = composeSystemPrompt({ detailMode: true, trimFiller: true });
  assert.ok(detail.startsWith(OPTIMIZER_SYSTEM_PROMPT));
  assert.match(detail, /A\. 去废话/);
  assert.doesNotMatch(detail, /B\. 详细优化/, 'detail directive is the mode itself, not re-added');
  // Compact mode: the lean face — short, no structure scaffolding.
  const compact = composeSystemPrompt({ detailMode: false, trimFiller: true });
  assert.match(compact, /提示词工程师/);
  assert.match(compact, /1~3 句话/);
  assert.match(compact, /去废话/);
  assert.doesNotMatch(compact, /结构化：用简短的标题/);
  const plain = composeSystemPrompt(undefined);
  assert.match(plain, /1~3 句话/);
  assert.doesNotMatch(plain, /去废话/);
});

test('the store persists atomically and survives a hand-broken file', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'wisp-config-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = tempHome;
  try {
    // Absent file → defaults.
    assert.deepEqual(await readConfig(), { trimFiller: false, detailMode: false });

    // Write a patch; the document lands and reads back.
    const saved = await writeConfig({ trimFiller: true, detailMode: true });
    assert.deepEqual(saved, { trimFiller: true, detailMode: true });
    const onDisk = JSON.parse(readFileSync(configFilePath(), 'utf8'));
    assert.deepEqual(onDisk, { trimFiller: true, detailMode: true });
    assert.equal(existsSync(configFilePath() + '.' + process.pid + '.tmp'), false, 'temp file renamed away');

    // Merge semantics: a partial patch keeps the other key.
    const merged = await writeConfig({ detailMode: false });
    assert.deepEqual(merged, { trimFiller: true, detailMode: false });

    // A hand-edited nonsense document normalizes instead of throwing.
    writeFileSync(configFilePath(), '{this is not json');
    assert.deepEqual(await readConfig(), { trimFiller: false, detailMode: false });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(tempHome, { recursive: true, force: true });
  }
});
