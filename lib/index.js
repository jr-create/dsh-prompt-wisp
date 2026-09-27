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

import { createRoutes, setConfigStore, setConversationDigestReader, setSessionWatchReader } from './http.js';
import { CONTEXT_SCAN_EVENTS, buildConversationDigest } from './engine.js';
import { WATCH_SCAN_EVENTS, analyzeWatch } from './watch.js';
import { composeSystemPrompt } from './config.js';
import * as store from './store.js';

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
 * How long the context read may take before it is abandoned.
 *
 * An old, large, or currently-projected session can make `open()` materialize
 * for a long time; the digest is worth ~15s of waiting, never more — after
 * that the optimization proceeds without context instead of eating the whole
 * call budget (observed live: a 1.2MB session blocked the request past the
 * 90s optimizer timeout).
 */
const DIGEST_TIMEOUT_MS = 15000;

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
  // The inner work runs in a helper so the deadline can race it; the handle
  // closes in the helper's own finally, and a lost race abandons the handle
  // to the backend (a read handle owns nothing and is GC-safe).
  async function readTail() {
    let handle;
    try {
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

  try {
    return await Promise.race([
      readTail(),
      new Promise((resolve) => setTimeout(
        () => resolve({ digest: '', reason: 'slow-open' }),
        DIGEST_TIMEOUT_MS,
      )),
    ]);
  } catch (error) {
    // A single unreadable session must not fail the optimization — the
    // partial-success lesson from dsh-session-vault (问题 2), applied to one
    // optional read.
    return {
      digest: '',
      reason: 'read-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * How long the WATCH read may take before it is abandoned.
 *
 * The watch poll runs every few seconds; a slow open must degrade to
 * "unknown" quickly or the polls pile up.
 */
const WATCH_TIMEOUT_MS = 5000;

/**
 * Read and analyze one stored session's execution health.
 *
 * Same reader discipline as `readConversationDigest` (sessionPersistence
 * only, read handle, deadline race, degrade-not-fail), feeding the tail to
 * `analyzeWatch` from lib/watch.js.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the browser-supplied session id.
 * @returns {Promise<{ status: string, findings: Array<object>, reason?: string }>}
 *   the analysis, or a degrade reason with an empty findings list.
 */
export async function readSessionWatch(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    return { status: 'unknown', findings: [], reason: 'no-session' };
  }
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined;
  if (persistence === undefined) {
    return { status: 'unknown', findings: [], reason: 'persistence-unavailable' };
  }
  async function readTail() {
    let handle;
    try {
      const snapshot = await persistence.stat(sessionId);
      if (snapshot === undefined) return { status: 'unknown', findings: [], reason: 'not-found' };
      const total = typeof snapshot.eventCount === 'number'
        ? snapshot.eventCount
        : WATCH_SCAN_EVENTS;
      const offset = Math.max(0, total - WATCH_SCAN_EVENTS);
      handle = await persistence.open(sessionId, 'read');
      const read = await handle.read(offset);
      return analyzeWatch(read?.events, { now: Date.now() });
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Teardown best-effort.
        }
      }
    }
  }
  try {
    return await Promise.race([
      readTail(),
      new Promise((resolve) => setTimeout(
        () => resolve({ status: 'unknown', findings: [], reason: 'slow-open' }),
        WATCH_TIMEOUT_MS,
      )),
    ]);
  } catch (error) {
    return {
      status: 'unknown',
      findings: [],
      reason: 'read-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
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
  // Wire the watch reader the same way.
  setSessionWatchReader((watchCtx, sessionId) => readSessionWatch(watchCtx, sessionId));
  // Wire the config store the same way: `{ read, write, hooks }` — the HTTP
  // routes call it per request and the optimizer receives `hooks.
  // composeSystemPrompt(config)` so the settings page's modes reach the call.
  setConfigStore({
    read: () => store.readConfig(),
    write: (patch) => store.writeConfig(patch),
    hooks: { composeSystemPrompt },
  });

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
