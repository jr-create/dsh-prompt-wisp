/**
 * Watch analyzer tests: the four failure shapes, the healthy signal, and
 * degradation on garbage input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWatch, STALL_MS, NO_OUTPUT_STEPS, TOOL_LOOP_COUNT, toolCallSignature } from '../lib/watch.js';

const NOW = 1700000000000;
/** Build an event with service-shape fields. */
const ev = (type, time, extra = {}) => ({ type, time, seq: time / 1000, data: { ...extra } });

test('healthy: completed turn, no findings', () => {
  const events = [
    ev('turn/start', NOW - 60000),
    ev('step/start', NOW - 59000),
    ev('assistant/message', NOW - 58000, { content: [{ type: 'text', text: 'done' }] }),
    ev('turn/end', NOW - 57000, { reason: { kind: 'completed' } }),
  ];
  const result = analyzeWatch(events, { now: NOW });
  assert.equal(result.status, 'healthy');
  assert.equal(result.findings.length, 0);
});

test('stalled: open turn, no events for STALL_MS → alert', () => {
  const events = [
    ev('turn/start', NOW - STALL_MS - 20000),
    ev('step/start', NOW - STALL_MS - 10000),
    ev('tool/call', NOW - STALL_MS - 5000, { name: 'pwsh', arguments: '{"command":"long thing"}' }),
    // No turn/end; last event is STALL_MS+ old.
    ev('tool/result', NOW - STALL_MS - 1000, { content: [] }),
  ];
  const result = analyzeWatch(events, { now: NOW });
  assert.equal(result.status, 'alert');
  const stalled = result.findings.find((f) => f.kind === 'stalled');
  assert.ok(stalled, 'stalled finding present');
  assert.match(stalled.message, /秒没有任何新事件/);
});

test('stalled does not fire on a young open turn', () => {
  const events = [
    ev('turn/start', NOW - 10000),
    ev('step/start', NOW - 5000),
    ev('assistant/message', NOW - 2000, { content: [{ type: 'text', text: 'working…' }] }),
  ];
  const result = analyzeWatch(events, { now: NOW });
  assert.equal(result.status, 'healthy');
});

test('no-output: many steps in an open turn, zero visible text → warn', () => {
  const events = [ev('turn/start', NOW - 12000)];
  for (let i = 0; i < NO_OUTPUT_STEPS; i += 1) {
    events.push(ev('step/start', NOW - 11000 + i * 1000));
    // Tool calls produce no visible text.
    events.push(ev('tool/call', NOW - 10500 + i * 1000, { name: 'pwsh', arguments: `{"command":"do ${i}"}` }));
    events.push(ev('tool/result', NOW - 10000 + i * 1000, { content: [] }));
  }
  const result = analyzeWatch(events, { now: NOW });
  const noOutput = result.findings.find((f) => f.kind === 'no-output');
  assert.ok(noOutput, 'no-output finding present');
  assert.equal(result.status, 'warn');
});

test('no-output does not fire when the turn has visible text', () => {
  const events = [ev('turn/start', NOW - 12000)];
  for (let i = 0; i < NO_OUTPUT_STEPS; i += 1) {
    events.push(ev('step/start', NOW - 11000 + i * 1000));
    if (i === 0) {
      events.push(ev('assistant/message', NOW - 10900, { content: [{ type: 'text', text: '先说明一下计划' }] }));
    }
    events.push(ev('tool/call', NOW - 10500 + i * 1000, { name: 'pwsh', arguments: `{"command":"do ${i}"}` }));
  }
  const result = analyzeWatch(events, { now: NOW });
  assert.equal(result.findings.find((f) => f.kind === 'no-output'), undefined);
});

test('tool-loop: same tool, near-identical args, TOOL_LOOP_COUNT times → warn', () => {
  const events = [ev('turn/start', NOW - 60000)];
  for (let i = 0; i < TOOL_LOOP_COUNT; i += 1) {
    // Args differ only by a counter — normalization collapses them.
    events.push(ev('tool/call', NOW - 50000 + i, { name: 'pwsh', arguments: `{"command":"Get-ChildItem C:\\temp file-${i}"}` }));
  }
  const result = analyzeWatch(events, { now: NOW });
  const loop = result.findings.find((f) => f.kind === 'tool-loop');
  assert.ok(loop, 'tool-loop finding present');
  assert.match(loop.message, /pwsh/);
});

test('tool-loop does not fire on genuinely different commands', () => {
  const events = [ev('turn/start', NOW - 60000)];
  const commands = ['Get-ChildItem', 'Set-Location other', 'Remove-Item x', 'New-Item y', 'Write-Output z'];
  for (let i = 0; i < TOOL_LOOP_COUNT; i += 1) {
    events.push(ev('tool/call', NOW - 50000 + i, { name: 'pwsh', arguments: JSON.stringify({ command: commands[i] }) }));
  }
  const result = analyzeWatch(events, { now: NOW });
  assert.equal(result.findings.find((f) => f.kind === 'tool-loop'), undefined);
});

test('turn-err: a fresh error turn-end surfaces; an old one does not', () => {
  const fresh = [ev('turn/start', NOW - 20000), ev('turn/end', NOW - 10000, { reason: { kind: 'error', error: { message: 'rate limited' } } })];
  const result = analyzeWatch(fresh, { now: NOW });
  const turnErr = result.findings.find((f) => f.kind === 'turn-err');
  assert.ok(turnErr);
  assert.match(turnErr.message, /rate limited/);

  const old = [ev('turn/start', NOW - STALL_MS * 10), ev('turn/end', NOW - STALL_MS * 9, { reason: { kind: 'error', error: { message: 'old' } } })];
  assert.equal(analyzeWatch(old, { now: NOW }).findings.length, 0);
});

test('degrades on empty or garbage input', () => {
  assert.deepEqual(analyzeWatch([]), { status: 'healthy', findings: [] });
  assert.deepEqual(analyzeWatch(undefined), { status: 'healthy', findings: [] });
  assert.deepEqual(analyzeWatch([null, 'string', 42]), { status: 'healthy', findings: [] });
});

test('toolCallSignature normalizes counters, guids, and whitespace', () => {
  const a = toolCallSignature({ data: { name: 'pwsh', arguments: '{"command":"select 1 from x where id=12345678-1234-1234-1234-123456789abc and n=42"}' } });
  const b = toolCallSignature({ data: { name: 'pwsh', arguments: '{"command":"select 2 from x where id=87654321-4321-4321-4321-cba987654321 and n=77"}' } });
  assert.equal(a.shape, b.shape, 'counter-only differences collapse');
  assert.equal(toolCallSignature(undefined), undefined);
  assert.equal(toolCallSignature({ data: { name: '' } }), undefined);
});

test('archive replay shape (event wrapper) works the same', () => {
  const events = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: NOW - 60000 } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: NOW - 59000, data: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'event', event: { type: 'turn/end', seq: 3, time: NOW - 58000, data: { reason: { kind: 'completed' } } } },
  ];
  assert.equal(analyzeWatch(events, { now: NOW }).status, 'healthy');
});
