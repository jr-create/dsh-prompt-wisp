/**
 * dsh-prompt-wisp — the browser-facing HTTP route family.
 *
 * Three endpoints under `/api/dsh-prompt-wisp`:
 *
 *   GET  /status     → plugin version + which host capabilities exist
 *   GET  /route      → the model route an optimization would use right now
 *   POST /optimize   → run one optimization (JSON: `{ prompt, provider?, model? }`)
 *
 * Security posture mirrors `dsh-session-vault`:
 *
 *  - every route carries the loopback-only + same-origin trust fence, so a
 *    LAN-exposed deployment never serves these endpoints;
 *  - request bodies are JSON only and size-capped far above any legitimate
 *    prompt (the engine itself rejects drafts over 20,000 characters).
 *
 * @module dsh-prompt-wisp/http
 */

import {
  acceptPrompt,
  COMPACT_TIMEOUT_MS,
  DETAIL_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  optimizeCompactLocally,
  raceDetailRoutes,
  resolveDetailRoutes,
  resolveModelRoute,
} from './engine.js';

/**
 * Session digest reader, injected by the host half (`lib/index.js`).
 *
 * Declared as a module-level binding (not an import) so `http.js` stays
 * testable in isolation: tests either leave it undefined — the route then
 * degrades to "no context" — or assign their own fake.
 *
 * @type {(ctx: object, sessionId: unknown) => Promise<{ digest: string, reason?: string, detail?: string }> | undefined}
 */
export let readConversationDigest;

/**
 * Assign the session digest reader (called once by the host half at apply).
 * @param {(ctx: object, sessionId: unknown) => Promise<{ digest: string, reason?: string, detail?: string }>} fn
 *   the reader from `lib/index.js`.
 */
export function setConversationDigestReader(fn) {
  readConversationDigest = fn;
}

/**
 * Config store, injected by the host half the same way: `{ read(), write(patch),
 * hooks }` where `hooks.composeSystemPrompt(config)` builds the system prompt.
 * Absent (tests) → the optimizer runs with its built-in baseline prompt.
 *
 * @type {{ read: Function, write: Function, hooks: object } | undefined}
 */
export let configStore;

/**
 * Assign the config store (called once by the host half at apply).
 * @param {{ read: Function, write: Function, hooks: object }} store - the store.
 */
export function setConfigStore(store) {
  configStore = store;
}

/**
 * Read the currently assigned config store (the host half's watch reader
 * calls this — it cannot see http.js's module binding directly).
 * @returns {{ read: Function, write: Function, hooks: object } | undefined}
 *   the config store.
 */
export function watchConfigStore() {
  return configStore;
}

/**
 * Session watch reader, injected by the host half like the digest reader.
 *
 * @type {(ctx: object, sessionId: unknown) => Promise<{ status: string, findings: Array<object>, reason?: string }> | undefined}
 */
export let readSessionWatch;

/**
 * Assign the watch reader (called once by the host half at apply).
 * @param {(ctx: object, sessionId: unknown) => Promise<{ status: string, findings: Array<object>, reason?: string }>} fn
 *   the reader from `lib/index.js`.
 */
export function setSessionWatchReader(fn) {
  readSessionWatch = fn;
}
/** JSON request bodies hold one prompt and two optional strings; anything
 *  larger is a mistake long before this cap. */
const MAX_JSON_BODY_BYTES = 256 * 1024;
/** Route prefix shared by every endpoint below. */
export const ROUTE_PREFIX = '/api/dsh-prompt-wisp';

/**
 * Loopback-only plus same-origin fence (same checks as dsh-session-vault).
 *
 * Checks the peer address, the `Host` header, `Sec-Fetch-Site`, and `Origin`
 * so that a page on another origin cannot drive these endpoints through the
 * user's browser even when the server is reachable.
 *
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} `true` when the request may be served.
 */
export function isLoopbackRequest(request) {
  const address = request.socket && request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serialisable body.
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/**
 * Read and parse a request body as JSON.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<unknown>} the parsed body, or `undefined` when absent,
 *   oversized, or invalid.
 */
function readJsonBody(req) {
  return new Promise((resolveBody) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
      resolveBody(undefined);
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        overflow = true;
        resolveBody(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        resolveBody(undefined);
      }
    });
    req.on('error', () => resolveBody(undefined));
  });
}

/**
 * Build the plugin's route table.
 *
 * @param {object} options - route dependencies.
 * @param {object} options.ctx - the plugin context (host services are read
 *   from it per request, never captured at registration time).
 * @param {{ name: string, version: string }} options.generator - plugin
 *   identity stamped into `/status`.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 *   - optional logger.
 * @returns {Array<{ kind: 'exact', path: string, handler: Function }>}
 *   route descriptors accepted by `WebServer.register`.
 */
export function createRoutes(options) {
  const { ctx, generator, log } = options;

  /**
   * Wrap one handler with the trust fence and a JSON error envelope, so no
   * route can forget either.
   * @param {(req: import('node:http').IncomingMessage) => Promise<unknown>} handler
   *   - the route body, returning a JSON value.
   * @returns {Function} an HTTP handler.
   */
  function route(handler) {
    return async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'these endpoints are loopback-only' });
        return;
      }
      try {
        const body = await handler(req);
        if (body !== undefined && !res.writableEnded) writeJson(res, 200, { ok: true, ...body });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log?.warn?.(`dsh-prompt-wisp: ${message}`);
        if (!res.writableEnded) writeJson(res, 500, { ok: false, error: message });
      }
    };
  }

  /** Read host services at call time; a profile without them stays loadable. */
  function ports() {
    return {
      llm: typeof ctx.get === 'function' ? ctx.get('llm') : undefined,
      agentDefaultModel: typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined,
    };
  }

  const routes = [];

  routes.push({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: route(async () => {
      const { llm, agentDefaultModel } = ports();
      let defaultModel = null;
      if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
        try {
          const selection = agentDefaultModel.currentSelection();
          if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
            defaultModel = { provider: selection.provider, model: selection.model };
          }
        } catch {
          defaultModel = null;
        }
      }
      return {
        version: generator.version,
        maxPromptChars: MAX_PROMPT_CHARS,
        capabilities: {
          llm: llm !== undefined && typeof llm.stream === 'function',
          defaultModel: defaultModel !== null,
        },
        defaultModel,
      };
    }),
  });

  routes.push({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/route`,
    handler: route(async () => {
      const resolved = await resolveModelRoute(ports(), undefined);
      // A missing route is a *report*, not an error: the UI renders the
      // reason next to the button instead of failing the poll.
      if (!resolved.ok) return { resolved: false, error: resolved.error };
      return { resolved: true, provider: resolved.provider, model: resolved.model, source: resolved.source };
    }),
  });

  routes.push({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/config`,
    // One path owns both verbs (the registry dedupes on kind+path, so two
    // descriptors would collide): GET reads the config, POST writes a patch.
    handler: route(async (req) => {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body === undefined || body === null || typeof body !== 'object') {
          return { ok: false, error: '请求体必须是 JSON 对象' };
        }
        if (!configStore) return { ok: false, error: '配置存储不可用' };
        const saved = await configStore.write(body);
        log?.info?.('dsh-prompt-wisp: config updated');
        return { config: saved };
      }
      if (!configStore) return { config: {}, persisted: false };
      return { config: await configStore.read(), persisted: true };
    }),
  });

  routes.push({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/watch`,
    handler: route(async (req) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const sessionId = url.searchParams.get('sessionId');
      if (typeof readSessionWatch !== 'function') {
        return { status: 'unknown', findings: [], reason: 'no-reader' };
      }
      const result = await readSessionWatch(ctx, sessionId);
      return result;
    }),
  });

  routes.push({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/optimize`,
    handler: route(async (req) => {
      const body = await readJsonBody(req);
      if (body === undefined || body === null || typeof body !== 'object') {
        return { ok: false, error: '请求体必须是 JSON 对象' };
      }
      const started = Date.now();
      const activeConfig = configStore ? await configStore.read() : undefined;
      const detailMode = activeConfig?.detailMode === true;
      const requestedSession = /** @type {Record<string, unknown>} */ (body).sessionId;

      // Both modes go through the model race — a local rules pass cannot
      // deliver a real rewrite, and "no change" reads as broken (live user
      // feedback). The modes differ in budget and prompt, not in engine:
      //   compact: lean system prompt, 6s per-route budget, no context read
      //   detail : full structured prompt, 10s per-route budget, context
      // The local rules engine stays as the INSTANT FALLBACK when the race
      // fails or times out — a same-second no-model answer beats an error.
      const budgetMs = detailMode ? DETAIL_TIMEOUT_MS : COMPACT_TIMEOUT_MS;

      const context = detailMode && typeof readConversationDigest === 'function'
        ? await readConversationDigest(ctx, requestedSession)
        : { digest: '', reason: 'no-session' };
      if (context.reason !== undefined && context.reason !== 'no-session') {
        log?.info?.(`dsh-prompt-wisp: context unavailable (${context.reason})`);
      }
      const systemPrompt = configStore?.hooks?.composeSystemPrompt
        ? configStore.hooks.composeSystemPrompt(activeConfig)
        : undefined;
      const accepted = acceptPrompt(
        /** @type {Record<string, unknown>} */ (body).prompt,
        context.digest,
      );
      if (!accepted.ok) {
        return { ok: false, error: accepted.error };
      }
      const routeSet = await resolveDetailRoutes(ports(), /** @type {Record<string, unknown>} */ (body));
      if (!routeSet.ok) {
        return { ok: false, error: routeSet.error };
      }
      const raced = await raceDetailRoutes(
        ports(),
        accepted.userText,
        systemPrompt,
        routeSet.routes,
        budgetMs,
      );
      const tookMs = Date.now() - started;
      if (!('text' in raced) || typeof raced.text !== 'string') {
        const message = raced && typeof raced === 'object' && 'error' in raced ? raced.error : '优化失败';
        log?.info?.(`dsh-prompt-wisp: race failed (${message}) — falling back to local rules`);
        // Instant fallback: the local rules engine answers in-place instead
        // of surfacing a provider failure. trim-filler still applies.
        const local = optimizeCompactLocally(accepted.prompt, activeConfig);
        if (local.ok) {
          return {
            optimized: local.optimized,
            provider: local.provider,
            model: local.model,
            engine: 'local-fallback',
            routeSource: 'local',
            contextUsed: false,
            contextReason: 'race-failed',
            degraded: true,
            tookMs,
          };
        }
        return { ok: false, error: message };
      }
      log?.info?.(
        `dsh-prompt-wisp: ${detailMode ? 'detail' : 'compact'} via ${raced.provider}/${raced.model} in ${tookMs}ms`
          + (context.digest !== '' ? ' (context grounded)' : ''),
      );
      return {
        optimized: raced.text,
        provider: raced.provider,
        model: raced.model,
        engine: 'model-race',
        routeSource: 'race',
        contextUsed: context.digest !== '',
        contextReason: context.reason,
        degraded: false,
        tookMs,
      };
    }),
  });

  return routes;
}
