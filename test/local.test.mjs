/**
 * Local (no-model) optimizer tests: the compact path's rules, their meaning
 * preservation, and their speed budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeLocally } from '../lib/local.js';
import { optimizeCompactLocally } from '../lib/engine.js';

test('trims stacked leading interjections and trailing gratitude', () => {
  const { optimized } = optimizeLocally('好的，帮我写个周报，麻烦你了非常感谢！', { trimFiller: true });
  assert.equal(optimized, '帮我写个周报。');
});

test('trims mid-sentence softeners and vague hedges', () => {
  const { optimized } = optimizeLocally('我就是想让你帮我随便写个总结，大概三句话就行', { trimFiller: true });
  assert.equal(optimized, '帮我写个总结，三句话。');
});

test('leaves a clean draft untouched in shape (changed=false, identical text)', () => {
  const draft = '帮我写一份上周工作总结。要求：\n1. 分条列出；\n2. 每条一句话。';
  const { optimized, changed } = optimizeLocally(draft, { trimFiller: true });
  assert.equal(changed, false);
  assert.equal(optimized, draft);
});

test('with trimFiller off, only shape normalization runs (gratitude stays)', () => {
  const { optimized } = optimizeLocally('帮我写个周报，麻烦你了', {});
  assert.match(optimized, /麻烦你了/);
  assert.match(optimized, /。$/);
});

test('collapses adjacent duplicate sentences', () => {
  const { optimized } = optimizeLocally('帮我写总结。帮我写总结。', {});
  assert.equal(optimized, '帮我写总结。');
});

test('never returns empty — a whitespace/unknown draft comes back as-is', () => {
  const { optimized, changed } = optimizeLocally('，。！', { trimFiller: true });
  assert.equal(optimized, '，。！');
  assert.equal(changed, false);
});

test('runs the full rule chain on a 20k-char draft well under the 2s budget', () => {
  const draft = ('好的麻烦你了，我就是想让你帮我随便写个东西总结一下上周的工作，大概几句话就行，非常感谢！'.repeat(400)).slice(0, 20000);
  const started = performance.now();
  optimizeLocally(draft, { trimFiller: true });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `local pass took ${elapsed.toFixed(1)}ms (budget 200ms)`);
});

test('optimizeCompactLocally gates through acceptPrompt and reports the local engine', () => {
  const rejected = optimizeCompactLocally('   ');
  assert.equal(rejected.ok, false);
  const ok = optimizeCompactLocally('帮我写周报', { trimFiller: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, 'local');
  assert.equal(ok.model, 'rules-v1');
  assert.equal(ok.contextUsed, false);
});
