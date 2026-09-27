/**
 * HTTP layer tests: run the real route handlers against mock req/res objects
 * — no listening socket, no DSH host. Covers the trust fence, the JSON
 * envelope, and each endpoint's happy and unhappy paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutes, setConfigStore, setConversationDigestReader, isLoopbackRequest, ROUTE_PREFIX } from '../lib/http.js';
import { readConversationDigest } from '../lib/index.js';

/** Minimal IncomingMessage double. */
function fakeReq({ url = '/', headers = {}, socket = { remoteAddress: '127.0.0.1' }, body, method = 'GET' } = {}) {
  const listeners = {};
  const req = {
    url,
    headers,
    method,
    socket,
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
      return req;
    },
  };
  if (body !== undefined) {
    req.headers['content-length'] = String(Buffer.byteLength(JSON.stringify(body), 'utf8'));
  }
  // A real request always settles: fire end even with no body, otherwise a
  // bodyless request would hang the handler's readJsonBody forever.
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(body), 'utf8'));
    }
    for (const fn of listeners.end ?? []) fn();
  });
  return req;
}

/** Minimal ServerResponse double. */
function fakeRes() {
  const res = {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(payload) {
      res.writableEnded = true;
      res.body = payload === undefined ? undefined : JSON.parse(payload);
    },
    destroy() {
      res.destroyed = true;
    },
  };
  return res;
}

function fakeCtx({ llm, selection } = {}) {
  const services = {
    llm: llm === undefined
      ? {
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text: '结构化后的提示词' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      }
      : llm,
    agentDefaultModel: {
      currentSelection: () => selection === undefined ? { provider: 'prov-b', model: 'default-x' } : selection,
    },
  };
  return { get: (key) => services[key] };
}

function routesFor(ctx) {
  const log = { info() {}, warn() {}, error() {} };
  return createRoutes({ ctx, generator: { name: 'dsh-prompt-wisp', version: '0.1.0' }, log });
}

function findRoute(routes, path) {
  const found = routes.find((r) => r.path === `${ROUTE_PREFIX}${path}`);
  assert.ok(found, `route ${path} must exist`);
  return found.handler;
}

const LOOPBACK_HEADERS = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' };

test('isLoopbackRequest fences non-loopback peers, hosts, and cross-site origins', () => {
  const base = { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(isLoopbackRequest(fakeReq(base)), true);
  assert.equal(isLoopbackRequest(fakeReq({ ...base, socket: { remoteAddress: '192.168.1.5' } })), false);
  assert.equal(isLoopbackRequest(fakeReq({ ...base, headers: { host: 'evil.example' } })), false);
  assert.equal(
    isLoopbackRequest(fakeReq({ ...base, headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } })),
    false,
  );
  assert.equal(
    isLoopbackRequest(fakeReq({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } })),
    false,
  );
  // Same-origin origin header is fine.
  assert.equal(
    isLoopbackRequest(fakeReq({ ...base, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })),
    true,
  );
});

test('status reports capabilities and the default model', async () => {
  const handler = findRoute(routesFor(fakeCtx()), '/status');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, '0.1.0');
  assert.equal(res.body.capabilities.llm, true);
  assert.equal(res.body.capabilities.defaultModel, true);
  assert.deepEqual(res.body.defaultModel, { provider: 'prov-b', model: 'default-x' });
  assert.ok(res.body.maxPromptChars > 0);
});

test('route reports the resolved model route', async () => {
  const handler = findRoute(routesFor(fakeCtx()), '/route');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS }), res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.resolved, true);
  assert.equal(res.body.provider, 'prov-b');
  assert.equal(res.body.model, 'default-x');
});

test('route reports a resolution failure as data, not a crash', async () => {
  const handler = findRoute(routesFor(fakeCtx({ llm: undefined, selection: null })), '/route');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.resolved, false);
  assert.ok(res.body.error.length > 0);
});

test('optimize (compact default) races models with the lean prompt, no context read', async () => {
  let digestCalled = 0;
  setConversationDigestReader(async () => { digestCalled += 1; return { digest: '' }; });
  setConfigStore({
    read: async () => ({ trimFiller: true, detailMode: false }),
    write: async () => ({}),
    hooks: { composeSystemPrompt: (config) => (config?.detailMode ? 'DETAIL' : 'COMPACT+去废话') },
  });
  const seen = [];
  const llm = {
    async listProviders() { return [{ id: 'prov-b', name: 'B' }]; },
    stream(options) {
      seen.push({ system: options.system, model: options.model });
      return (async function* () {
        yield { type: 'text-delta', text: '更清晰的改写' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm })), '/optimize');
  const res = fakeRes();
  await handler(
    fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '好的，帮我写周报，谢谢', sessionId: 'session-abc' } }),
    res,
  );
  assert.equal(res.body.ok, true);
  assert.equal(res.body.engine, 'model-race', 'compact mode races models with the lean prompt');
  assert.equal(res.body.provider, 'prov-b');
  assert.equal(seen[0].system, 'COMPACT+去废话', 'the compact face reached the model call');
  assert.equal(digestCalled, 0, 'no context read in compact mode — the budget is for the model');
  setConversationDigestReader(undefined);
  setConfigStore(undefined);
});

test('optimize (compact) falls back to the local engine instantly when the race fails', async () => {
  const started = Date.now();
  setConfigStore({
    read: async () => ({ trimFiller: true, detailMode: false }),
    write: async () => ({}),
    hooks: {},
  });
  const llm = {
    async listProviders() { return []; },
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad key', code: 'AUTH' } } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm })), '/optimize');
  const res = fakeRes();
  await handler(
    fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '好的，帮我写周报，麻烦你了' } }),
    res,
  );
  assert.equal(res.body.ok, true, 'the local fallback answers instead of erroring');
  assert.equal(res.body.engine, 'local-fallback');
  assert.equal(res.body.degraded, true);
  assert.match(res.body.optimized, /帮我写周报/);
  assert.doesNotMatch(res.body.optimized, /麻烦你/);
  assert.ok(Date.now() - started < 3000, 'the fallback is instant');
  setConfigStore(undefined);
});

test('optimize (detail mode) races model routes and grounds with context', async () => {
  const seen = [];
  setConversationDigestReader(async (_ctx, sessionId) => {
    seen.push(sessionId);
    return { digest: '用户：做一个插件\n助手：好的' };
  });
  setConfigStore({
    read: async () => ({ trimFiller: false, detailMode: true }),
    write: async () => ({}),
    hooks: { composeSystemPrompt: () => 'BASE+详细' },
  });
  const seenSystems = [];
  const llm = {
    async listProviders() { return [{ id: 'prov-b', name: 'B' }]; },
    stream(options) {
      seenSystems.push(options.system);
      return (async function* () {
        yield { type: 'text-delta', text: '详细的结构化结果' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm })), '/optimize');
  const res = fakeRes();
  await handler(
    fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '继续优化它', sessionId: 'session-abc' } }),
    res,
  );
  assert.equal(res.body.ok, true);
  assert.equal(seen[0], 'session-abc', 'the browser-supplied session id reaches the reader');
  assert.equal(res.body.contextUsed, true);
  assert.equal(res.body.engine, 'model-race');
  assert.equal(res.body.provider, 'prov-b');
  assert.equal(seenSystems[0], 'BASE+详细', 'config-composed prompt reached the model call');
  setConversationDigestReader(undefined);
  setConfigStore(undefined);
});

test('optimize (detail mode) falls back to local rules when every route fails', async () => {
  setConfigStore({
    read: async () => ({ trimFiller: false, detailMode: true }),
    write: async () => ({}),
    hooks: {},
  });
  const failing = {
    async listProviders() { return []; },
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad key', code: 'AUTH' } } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm: failing })), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '总结一下' } }), res);
  // The local fallback answers with the unchanged-ish draft instead of an
  // error — a rule-passed "总结一下。" beats a dead provider.
  assert.equal(res.body.ok, true, 'local fallback prevents a hard failure');
  assert.equal(res.body.engine, 'local-fallback');
  setConfigStore(undefined);
});

test('optimize returns ok:false with the reason for client mistakes', async () => {
  const handler = findRoute(routesFor(fakeCtx()), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '   ' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /空/);
});

test('optimize rejects a non-JSON body', async () => {
  const handler = findRoute(routesFor(fakeCtx()), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /JSON/);
});

test('optimize (detail) grounds in the session digest when a reader is wired and sessionId is given', async () => {
  const seen = [];
  setConversationDigestReader(async (_ctx, sessionId) => {
    seen.push(sessionId);
    return { digest: '用户：做一个插件\n助手：好的' };
  });
  setConfigStore({
    read: async () => ({ trimFiller: false, detailMode: true }),
    write: async () => ({}),
    hooks: {},
  });
  const llm = {
    async listProviders() { return []; },
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '详细结果' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm })), '/optimize');
  const res = fakeRes();
  await handler(
    fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '继续优化它', sessionId: 'session-abc' } }),
    res,
  );
  assert.equal(res.body.ok, true);
  assert.equal(seen[0], 'session-abc', 'the browser-supplied session id reaches the reader');
  assert.equal(res.body.contextUsed, true);
  setConversationDigestReader(undefined);
  setConfigStore(undefined);
});

test('optimize degrades gracefully when no digest reader is wired', async () => {
  setConversationDigestReader(undefined);
  const handler = findRoute(routesFor(fakeCtx()), '/optimize');
  const res = fakeRes();
  await handler(
    fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '总结一下', sessionId: 'session-abc' } }),
    res,
  );
  assert.equal(res.body.ok, true, 'missing context must not fail the optimization');
  assert.equal(res.body.contextUsed, false);
});

test('optimize reports context unavailability reasons without failing (detail mode)', async () => {
  setConversationDigestReader(async () => ({ digest: '', reason: 'read-failed', detail: 'boom' }));
  setConfigStore({
    read: async () => ({ trimFiller: false, detailMode: true }),
    write: async () => ({}),
    hooks: {},
  });
  const llm = {
    async listProviders() { return []; },
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '结果' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm })), '/optimize');
  const res = fakeRes();
  await handler(
    fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '总结一下', sessionId: 'session-xyz' } }),
    res,
  );
  assert.equal(res.body.ok, true);
  assert.equal(res.body.contextUsed, false);
  assert.equal(res.body.contextReason, 'read-failed');
  setConversationDigestReader(undefined);
  setConfigStore(undefined);
});

test('readConversationDigest is exported by the host half and validates its input', async () => {
  assert.equal(typeof readConversationDigest, 'function');
  const noId = await readConversationDigest({ get: () => undefined }, undefined);
  assert.deepEqual(noId, { digest: '', reason: 'no-session' });
  const noService = await readConversationDigest({ get: () => undefined }, 'session-abc');
  assert.equal(noService.digest, '');
  assert.equal(noService.reason, 'persistence-unavailable');
});

test('config route: GET reads, POST writes, and both survive a missing store', async () => {
  const handler = findRoute(routesFor(fakeCtx()), '/config');

  // No store wired → GET degrades to defaults, POST refuses.
  setConfigStore(undefined);
  const getRes = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS }), getRes);
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.persisted, false);
  const postRes = fakeRes();
  await handler(fakeReq({ method: 'POST', headers: LOOPBACK_HEADERS, body: { trimFiller: true } }), postRes);
  assert.equal(postRes.body.ok, false);

  // A wired store: GET reads, POST writes the patch.
  let stored = { trimFiller: false, detailMode: false };
  const seen = [];
  setConfigStore({
    read: async () => stored,
    write: async (patch) => {
      seen.push(patch);
      stored = { ...stored, ...patch };
      return stored;
    },
    hooks: {},
  });
  const getRes2 = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS }), getRes2);
  assert.deepEqual(getRes2.body.config, { trimFiller: false, detailMode: false });
  assert.equal(getRes2.body.persisted, true);

  const postRes2 = fakeRes();
  await handler(
    fakeReq({ method: 'POST', headers: LOOPBACK_HEADERS, body: { trimFiller: true } }),
    postRes2,
  );
  assert.equal(postRes2.body.ok, true);
  assert.deepEqual(seen[0], { trimFiller: true }, 'the raw patch reaches the store');
  setConfigStore(undefined);
});

test('optimize receives the composed system prompt and the persisted config', async () => {
  const seenSystems = [];
  setConversationDigestReader(async () => ({ digest: '' }));
  const ports = {
    llm: {
      stream(options) {
        seenSystems.push(options.system);
        return (async function* () {
          yield { type: 'text-delta', text: '结果' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  setConfigStore({
    read: async () => ({ trimFiller: false, detailMode: true }),
    write: async () => ({}),
    hooks: {
      composeSystemPrompt(config) {
        // Mirrors lib/config.js's contract: base + mode section.
        return config && config.detailMode === true ? 'BASE+详细优化' : 'BASE';
      },
    },
  });
  const handler = findRoute(routesFor(fakeCtx(ports)), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: 'hello' } }), res);
  assert.equal(res.body.ok, true);
  assert.equal(seenSystems[0], 'BASE+详细优化', 'the config-driven prompt reached the model call');
  setConfigStore(undefined);
  setConversationDigestReader(undefined);
});

test('every route enforces the trust fence with a 403', async () => {
  const routes = routesFor(fakeCtx());
  for (const descriptor of routes) {
    const res = fakeRes();
    await descriptor.handler(
      fakeReq({ headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '10.0.0.8' } }),
      res,
    );
    assert.equal(res.statusCode, 403, descriptor.path);
    assert.equal(res.body.ok, false);
  }
});

test('handler crashes become 500 with an error envelope', async () => {
  // The compact path never touches the config store; force detail mode so a
  // throwing ctx.get IS reached (configStore.read → ctx.get internals), and
  // the crash takes the 500 path in route().
  setConfigStore({
    read() {
      throw new Error('boom');
    },
    write: async () => ({}),
    hooks: {},
  });
  const handler = findRoute(routesFor(fakeCtx()), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: 'hello' } }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /boom/);
  setConfigStore(undefined);
});
