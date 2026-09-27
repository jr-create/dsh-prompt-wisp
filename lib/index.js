/**
 * dsh-prompt-wisp — host half.
 *
 * Contributes one thing to the host composition:
 *
 *   The `/api/dsh-prompt-wisp/*` route family the browser half calls
 *   (`/status`, `/route`, `/optimize`). The optimization itself runs through
 *   the host's own `llm` service — reusing the provider, API key, token
 *   metering and retry policy the user already configured — and defaults to
 *   the host's configured default agent model.
 *
 * `webServer` only exists in Web deployments and `llm` only where a model
 * adapter is composed, so both are read with `ctx.get()` at call time and
 * awaited with `ctx.inject()` before the routes are mounted; a profile with
 * neither still loads this plugin without stalling a fiber.
 *
 * @module dsh-prompt-wisp
 */

import { readFileSync } from 'node:fs';

import { createRoutes, setConversationDigestReader } from './http.js';
import { CONTEXT_SCAN_EVENTS, buildConversationDigest } from './engine.js';

/** Stable loader identity; must match the `cordis.patch.yml` row id. */
export const name = 'prompt-wisp';

/**
 * Hard service dependencies: none.
 *
 * `webServer` and `llm` are late, optional services; every one is resolved
 * through `ctx.get()` per request and mounted via `ctx.inject()` below.
 */
export const inject = [];

/**
 * A logger that exists even when the profile composes none.
 * @param {object} ctx - the plugin context.
 * @returns {{ info?: Function, warn?: Function, error?: Function }} an object
 *   with logging methods.
 */
function loggerOf(ctx) {
  const candidate = typeof ctx.get === 'function' ? ctx.get('logger') : undefined;
  if (candidate !== undefined && typeof candidate.warn === 'function') return candidate;
  return { info() {}, warn() {}, error() {} };
}

/**
 * The plugin's own version, read from its manifest.
 * @returns {string} the version string, or `'0.0.0'` when unreadable.
 */
function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Read a compact digest of one stored session's recent conversation.
 *
 * Context is an *enhancement*, never a requirement: every failure mode below
 * degrades to "no context" and the optimization proceeds on the draft alone.
 * The draft came from the user a moment ago; a missing digest must not veto
 * the click.
 *
 * `sessionPersistence` is the only reader — never raw `.jsonl.zstd` files
 * (session-vault's hard rule: re-implementing the storage encoding is how
 * corruption happens). A `read` handle observes without ownership, so it is
 * safe while the session's own writer holds `write`.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the browser-supplied session id.
 * @returns {Promise<{ digest: string, reason?: string, detail?: string }>}
 *   a digest, or an empty one plus a short machine-readable reason when
 *   unavailable.
 */
export async function readConversationDigest(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    return { digest: '', reason: 'no-session' };
  }
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined;
  if (persistence === undefined) {
    return { digest: '', reason: 'persistence-unavailable' };
  }
  let handle;
  try {
    // stat is cheap and answers "does it exist" without opening the log.
    const snapshot = await persistence.stat(sessionId);
    if (snapshot === undefined) return { digest: '', reason: 'not-found' };
    // eventCount is only present when the backend can provide it cheaply;
    // otherwise scan a fixed generous tail from the end.
    const total = typeof snapshot.eventCount === 'number'
      ? snapshot.eventCount
      : CONTEXT_SCAN_EVENTS;
    const offset = Math.max(0, total - CONTEXT_SCAN_EVENTS);

    handle = await persistence.open(sessionId, 'read');
    const read = await handle.read(offset);
    const digest = buildConversationDigest(read?.events);
    return { digest: digest.digest, reason: digest.digest === '' ? 'empty-conversation' : undefined };
  } catch (error) {
    // A single unreadable session must not fail the optimization — the
    // partial-success lesson from dsh-session-vault (问题 2), applied to one
    // optional read.
    return {
      digest: '',
      reason: 'read-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Close is the teardown; nothing better to do on failure.
      }
    }
  }
}

/**
 * @param {object} ctx - the plugin context.
 * @param {unknown} _config - the row config; this plugin takes none.
 */
export function apply(ctx, _config) {
  const generator = { name: 'dsh-prompt-wisp', version: pluginVersion() };
  const log = loggerOf(ctx);

  // Wire the session digest reader into the HTTP layer before any route can
  // serve a request; `readConversationDigest` is defined below.
  setConversationDigestReader((digestCtx, sessionId) => readConversationDigest(digestCtx, sessionId));

  // `webServer` is a late service: a bare `ctx.get('webServer')` inside
  // `apply` usually returns `undefined`, which is exactly how dsh-session-
  // vault once lost every route silently. The deferred injection mounts the
  // routes the moment the service exists (and disposes them if it goes away).
  ctx.inject(['webServer'], (webCtx) => {
    const routes = createRoutes({ ctx: webCtx, generator, log });
    webCtx.effect(() => {
      const disposers = routes.map((routeDescriptor) => webCtx.webServer.register(routeDescriptor));
      log.info?.(`dsh-prompt-wisp: mounted ${disposers.length} routes`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-prompt-wisp: routes');
  });
}
