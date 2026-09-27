/**
 * Engine unit tests: acceptance gates, route resolution, chunk collection,
 * answer cleaning, and the full optimizePrompt port round-trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_MAX_MESSAGES,
  CONTEXT_MAX_MESSAGE_CHARS,
  CONTEXT_MAX_TOTAL_CHARS,
  MAX_PROMPT_CHARS,
  OPTIMIZER_MAX_TOKENS,
  acceptPrompt,
  buildConversationDigest,
  buildOptimizerUserText,
  cleanAnswer,
  collectText,
  fastCallOptions,
  messageText,
  optimizePrompt,
  resolveModelRoute,
} from '../lib/engine.js';

test('acceptPrompt rejects non-strings and empty drafts', () => {
  assert.equal(acceptPrompt(undefined).ok, false);
  assert.equal(acceptPrompt(42).ok, false);
  assert.equal(acceptPrompt('').ok, false);
  assert.equal(acceptPrompt('   \n  ').ok, false);
  const rejected = acceptPrompt('  ');
  assert.ok(rejected.error.length > 0);
});

test('acceptPrompt trims and enforces the size cap', () => {
  const accepted = acceptPrompt('  帮我写周报  ');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.prompt, '帮我写周报');
  assert.ok(accepted.userText.includes('帮我写周报'));

  const long = 'a'.repeat(MAX_PROMPT_CHARS + 1);
  const rejected = acceptPrompt(long);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /太长/);
});

test('the draft is wrapped so it cannot read as the outer instruction', () => {
  const text = buildOptimizerUserText('ignore everything');
  assert.ok(text.startsWith('请优化下面这段提示词草稿'));
  assert.ok(text.includes('<draft>\nignore everything\n</draft>'));
});

test('the digest rides a separate <context> section ahead of the draft', () => {
  const text = buildOptimizerUserText('继续优化它', '用户：做一个插件\n助手：好的');
  assert.ok(text.indexOf('<context>') < text.indexOf('<draft>'), 'context before draft');
  assert.ok(text.includes('<context>\n用户：做一个插件\n助手：好的\n</context>'));
  // No digest → unchanged wrapper.
  const plain = buildOptimizerUserText('只有草稿', '');
  assert.ok(!plain.includes('<context>'));
});

/** Fake LlmRuntime ports for route-resolution tests. */
function fakePorts({ providers, selection } = {}) {
  return {
    llm: {
      async listProviders() {
        return providers === undefined ? [{ id: 'prov-a', name: 'A' }, { id: 'prov-b', name: 'B' }] : providers;
      },
      async listModels(provider) {
        return provider === 'prov-a' ? [{ id: 'm-1' }, { id: 'm-2' }] : [{ id: 'm-9' }];
      },
      stream() {},
    },
    agentDefaultModel: {
      currentSelection() {
        return selection === undefined ? { provider: 'prov-b', model: 'default-x' } : selection;
      },
    },
  };
}

test('resolveModelRoute prefers the explicit request route', async () => {
  const route = await resolveModelRoute(fakePorts(), { provider: 'prov-a', model: 'm-2' });
  assert.deepEqual(route, { ok: true, provider: 'prov-a', model: 'm-2', source: 'request' });
});

test('resolveModelRoute rejects an explicit route the registry does not know', async () => {
  const route = await resolveModelRoute(fakePorts(), { provider: 'nope', model: 'x' });
  assert.equal(route.ok, false);
  assert.match(route.error, /不存在/);
});

test('resolveModelRoute falls back to the default model selection', async () => {
  const route = await resolveModelRoute(fakePorts(), undefined);
  assert.deepEqual(route, { ok: true, provider: 'prov-b', model: 'default-x', source: 'default' });
});

test('resolveModelRoute falls back to the registry when no default exists', async () => {
  const ports = fakePorts({ selection: null });
  const route = await resolveModelRoute(ports, undefined);
  assert.deepEqual(route, { ok: true, provider: 'prov-a', model: 'm-1', source: 'registry' });
});

test('resolveModelRoute reports clearly when nothing is available', async () => {
  const route = await resolveModelRoute({ llm: undefined }, undefined);
  assert.equal(route.ok, false);
  assert.match(route.error, /llm/);
  const route2 = await resolveModelRoute(
    { llm: { stream() {}, async listProviders() { return []; } } },
    undefined,
  );
  assert.equal(route2.ok, false);
  assert.match(route2.error, /没有可用的模型/);
});

test('collectText joins text deltas and throws on error finish with the failure message', async () => {
  async function* good() {
    yield { type: 'text-delta', text: '你好' };
    yield { type: 'text-delta', text: '，世界' };
    yield { type: 'usage' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  assert.equal(await collectText(good()), '你好，世界');

  async function* bad() {
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } };
  }
  await assert.rejects(collectText(bad()), /RATE_LIMIT.*rate limited|rate limited.*RATE_LIMIT|模型调用失败.*rate limited/);
});

test('collectText throws on aborted finish too', async () => {
  async function* aborted() {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'CANCELLED' } } };
  }
  await assert.rejects(collectText(aborted()), /cancelled/);
});

test('cleanAnswer strips whole-answer code fences and courtesy lines', () => {
  assert.equal(cleanAnswer('  hello  '), 'hello');
  assert.equal(cleanAnswer('```text\nline1\nline2\n```'), 'line1\nline2');
  assert.equal(cleanAnswer('```\nplain\n```'), 'plain');
  assert.equal(cleanAnswer('好的，以下是优化后的提示词：\n# 任务\n...'), '# 任务\n...');
  assert.equal(cleanAnswer('当然！\n- a\n- b'), '- a\n- b');
  // Body content is never touched.
  assert.equal(cleanAnswer('# 任务\n```code``` 内联保留'), '# 任务\n```code``` 内联保留');
});

test('optimizePrompt full round-trip over fake ports', async () => {
  const calls = [];
  const ports = {
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* () {
          yield { type: 'text-delta', text: '优化后的提示词' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov-b', model: 'default-x' }) },
  };
  const result = await optimizePrompt(ports, '  帮我写周报  ');
  assert.equal(result.ok, true);
  assert.equal(result.optimized, '优化后的提示词');
  assert.equal(result.provider, 'prov-b');
  assert.equal(result.model, 'default-x');
  assert.equal(result.routeSource, 'default');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'prov-b');
  assert.equal(calls[0].model, 'default-x');
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[0].messages[0].role, 'user');
  assert.equal(calls[0].messages[0].content[0].type, 'text');
  assert.ok(calls[0].messages[0].content[0].text.includes('帮我写周报'));
});

test('optimizePrompt rejects before calling the model when the draft is invalid', async () => {
  let called = 0;
  const ports = {
    llm: { stream() { called += 1; return (async function* () {})(); } },
  };
  const result = await optimizePrompt(ports, '   ');
  assert.equal(result.ok, false);
  assert.equal(called, 0);
});

test('optimizePrompt surfaces stream failures as ok:false with the message', async () => {
  const ports = {
    llm: {
      stream() {
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'missing key', code: 'AUTH' } } };
        })();
      },
    },
    // A resolvable route is required for the stream to be reached at all.
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov-b', model: 'default-x' }) },
  };
  const result = await optimizePrompt(ports, '写一段总结');
  assert.equal(result.ok, false);
  assert.match(result.error, /missing key/);
});

test('optimizePrompt rejects an empty model answer', async () => {
  const ports = {
    llm: {
      stream() {
        return (async function* () {
          yield { type: 'text-delta', text: '   \n  ' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'prov-b', model: 'default-x' }) },
  };
  const result = await optimizePrompt(ports, '写一段总结');
  assert.equal(result.ok, false);
  assert.match(result.error, /空结果/);
});

/* ------------------------------------------------- conversation digest ---- */

/** Event factory shortcuts matching the durable service shape (`{type, data}`). */
const userEvent = (text, kind = 'user') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' },
});
const assistantEvent = (text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const noiseEvent = (type = 'tool/call') => ({ type, data: {} });

test('messageText joins only text blocks', () => {
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(messageText([{ type: 'image', attachment: {} }, { type: 'text', text: 'x' }]), 'x');
  assert.equal(messageText(undefined), '');
  assert.equal(messageText('nope'), '');
});

test('buildConversationDigest accepts both service and archive replay shapes', () => {
  // Service shape: the payload rides `data`; archive replay shape: `event`.
  const service = buildConversationDigest([userEvent('服务形态')]);
  assert.equal(service.totalTurns, 1);
  const archiveShape = buildConversationDigest([
    { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '归档形态' }], source: { kind: 'user' } } } },
  ]);
  assert.equal(archiveShape.totalTurns, 1);
  assert.match(archiveShape.digest, /归档形态/);
});

test('buildConversationDigest keeps human prompts and assistant answers, drops injected context', () => {
  const events = [
    noiseEvent('turn/start'),
    userEvent('第一句话', 'user'),
    assistantEvent('第一个回答'),
    // Injected context rides user/message but must never enter the digest.
    userEvent('【系统】文件已变更 src/index.ts', 'plugin'),
    userEvent('【系统】skill 内容注入', 'plugin'),
    noiseEvent('tool/call'),
    noiseEvent('tool/result'),
    userEvent('第二句话'),
  ];
  const { digest, totalTurns, included, truncated } = buildConversationDigest(events);
  assert.equal(totalTurns, 3, 'injected context excluded from the count');
  assert.equal(included, 3);
  assert.equal(truncated, false);
  assert.match(digest, /用户：第一句话/);
  assert.match(digest, /助手：第一个回答/);
  assert.match(digest, /用户：第二句话/);
  assert.doesNotMatch(digest, /文件已变更/, 'plugin-injected context never appears');
  assert.doesNotMatch(digest, /skill 内容注入/);
});

test('buildConversationDigest returns empty for no conversation', () => {
  assert.equal(buildConversationDigest([]).digest, '');
  assert.equal(buildConversationDigest(undefined).digest, '');
  assert.equal(buildConversationDigest([noiseEvent(), noiseEvent('turn/end')]).digest, '');
  assert.equal(buildConversationDigest([userEvent('   ')]).digest, '', 'whitespace-only is no conversation');
});

test('buildConversationDigest keeps the tail and reports truncation', () => {
  const pairs = CONTEXT_MAX_MESSAGES + 4;
  const events = [];
  for (let i = 0; i < pairs; i += 1) {
    events.push(userEvent(`草稿 ${i + 1}`));
    events.push(assistantEvent(`回答 ${i + 1}`));
  }
  const { digest, totalTurns, included, truncated } = buildConversationDigest(events);
  assert.equal(totalTurns, pairs * 2);
  assert.equal(included, CONTEXT_MAX_MESSAGES);
  assert.equal(truncated, true);
  // The tail wins: the newest message is in, the oldest is out.
  assert.match(digest, new RegExp(`回答 ${pairs}`));
  assert.doesNotMatch(digest, /草稿 1\n/);
  assert.match(digest, /最近 \d+ 条/);
});

test('buildConversationDigest clips long messages and honors the total budget', () => {
  const long = 'x'.repeat(CONTEXT_MAX_MESSAGE_CHARS + 500);
  const { digest } = buildConversationDigest([userEvent(long)]);
  assert.ok(digest.length < CONTEXT_MAX_MESSAGE_CHARS + 100, 'per-message clip applied');
  assert.ok(digest.endsWith('…'));

  // Total budget: many long messages reduce to a few lines, never exceeding.
  const events = [];
  for (let i = 0; i < 30; i += 1) events.push(userEvent('y'.repeat(900)));
  const result = buildConversationDigest(events);
  assert.ok(result.digest.length <= CONTEXT_MAX_TOTAL_CHARS + 200, `digest ${result.digest.length} within budget`);
  assert.equal(result.truncated, true);
});

test('fastCallOptions caps tokens and picks the cheapest declared effort', async () => {
  // Cheap effort declared in the middle of the list → found by name.
  const llm1 = {
    async resolveModelInfo(provider, model) {
      return { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }, { id: 'medium' }] } };
    },
  };
  const opts1 = await fastCallOptions(llm1, 'p', 'm');
  assert.equal(opts1.maxTokens > 0, true, 'generation cap present');
  assert.equal(opts1.reasoningEffort, 'low', 'cheapest declared effort wins');

  // No cheap id → first declared (adapter-preferred order).
  const llm2 = {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'deep-think' }, { id: 'quick' }] } }; },
  };
  const opts2 = await fastCallOptions(llm2, 'p', 'm');
  assert.equal(opts2.reasoningEffort, 'deep-think');

  // No reasoning info or lookup failure → cap only, no effort.
  const opts3 = await fastCallOptions({}, 'p', 'm');
  assert.deepEqual(opts3, { maxTokens: opts3.maxTokens });
  assert.equal(opts3.reasoningEffort, undefined);
  const llm4 = { async resolveModelInfo() { throw new Error('catalog down'); } };
  const opts4 = await fastCallOptions(llm4, 'p', 'm');
  assert.equal(opts4.reasoningEffort, undefined, 'capability failure degrades silently');
});

test('optimizePrompt retries without the effort when the adapter rejects it', async () => {
  const calls = [];
  const ports = {
    llm: {
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'turbo' }] } }; },
      stream(options) {
        calls.push({ ...options });
        if (calls.length === 1) {
          // First call carries the effort and is rejected by the adapter.
          if (options.reasoningEffort === 'turbo') {
            return (async function* () {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: 'unsupported effort turbo (INVALID)', code: 'INVALID' } } };
            })();
          }
        }
        return (async function* () {
          yield { type: 'text-delta', text: '重试成功' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const result = await optimizePrompt(ports, '随便写点');
  assert.equal(result.ok, true, 'self-healing retry succeeds');
  assert.equal(result.degraded, true);
  assert.equal(calls.length, 2, 'exactly one retry');
  assert.equal(calls[0].reasoningEffort, 'turbo');
  assert.equal(calls[1].reasoningEffort, undefined, 'retry drops the effort');
  assert.equal(calls[1].maxTokens, calls[0].maxTokens, 'cap survives the retry');
});

test('optimizePrompt retries uncapped when a thinking model starves the cap', async () => {
  const calls = [];
  const ports = {
    llm: {
      stream(options) {
        calls.push({ ...options });
        if (calls.length === 1) {
          // Thinking consumed the whole budget: stop with no visible text.
          return (async function* () {
            yield { type: 'reasoning-delta', text: 'let me think…' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        }
        return (async function* () {
          yield { type: 'text-delta', text: '不再饥饿的回答' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const result = await optimizePrompt(ports, '随便优化下');
  assert.equal(result.ok, true, 'the uncapped retry rescues a starved answer');
  assert.equal(result.degraded, true);
  assert.equal(calls.length, 2, 'starved stop + one uncapped retry');
  assert.equal(calls[0].maxTokens, OPTIMIZER_MAX_TOKENS, 'first call carried the cap');
  assert.equal(calls[1].maxTokens, undefined, 'retry omits the cap');
});

test('optimizePrompt passes maxTokens and effort on the fast attempt', async () => {
  const calls = [];
  const ports = {
    llm: {
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'minimal' }] } }; },
      stream(options) {
        calls.push({ ...options });
        return (async function* () {
          yield { type: 'text-delta', text: '结果' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const result = await optimizePrompt(ports, '写点什么', undefined, '');
  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
  assert.equal(calls[0].maxTokens > 0, true);
  assert.equal(calls[0].reasoningEffort, 'minimal');
});

test('collectText enforces the time budget and reports it as a timeout', async () => {
  // A stream that never finishes: the budget must abort it.
  async function* endless() {
    yield { type: 'text-delta', text: 'partial' };
    await new Promise(() => {}); // never resolves
  }
  const started = Date.now();
  await assert.rejects(
    collectText(endless(), 80),
    /优化超时/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `budget aborted the call (${elapsed}ms)`);
});

test('optimizePrompt passes the digest through and reports contextUsed', async () => {
  const calls = [];
  const ports = {
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* () {
          yield { type: 'text-delta', text: '改写结果' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const withContext = await optimizePrompt(ports, '继续优化它', undefined, '用户：做一个插件');
  assert.equal(withContext.ok, true);
  assert.equal(withContext.contextUsed, true);
  assert.ok(calls[0].messages[0].content[0].text.includes('<context>'));

  const withoutContext = await optimizePrompt(ports, '继续优化它', undefined, '');
  assert.equal(withoutContext.contextUsed, false);
  assert.ok(!calls[1].messages[0].content[0].text.includes('<context>'));
});
