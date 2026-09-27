/**
 * HTTP layer tests: run the real route handlers against mock req/res objects
 * — no listening socket, no DSH host. Covers the trust fence, the JSON
 * envelope, and each endpoint's happy and unhappy paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutes, isLoopbackRequest, ROUTE_PREFIX } from '../lib/http.js';

/** Minimal IncomingMessage double. */
function fakeReq({ url = '/', headers = {}, socket = { remoteAddress: '127.0.0.1' }, body } = {}) {
  const listeners = {};
  const req = {
    url,
    headers,
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

test('optimize returns the cleaned optimization', async () => {
  const handler = findRoute(routesFor(fakeCtx()), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '  帮我写周报  ' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.optimized, '结构化后的提示词');
  assert.equal(res.body.provider, 'prov-b');
  assert.equal(res.body.tookMs >= 0, true);
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

test('optimize surfaces model failure messages', async () => {
  const failing = {
    stream() {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad key', code: 'AUTH' } } };
      })();
    },
  };
  const handler = findRoute(routesFor(fakeCtx({ llm: failing })), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: '总结一下' } }), res);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /bad key/);
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
  // Stream failures are converted to ok:false by the engine; the 500 path is
  // for genuinely unexpected crashes, like the context itself throwing.
  const crashing = {
    get() {
      throw new Error('boom');
    },
  };
  const handler = findRoute(routesFor(crashing), '/optimize');
  const res = fakeRes();
  await handler(fakeReq({ headers: LOOPBACK_HEADERS, body: { prompt: 'hello' } }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /boom/);
});
