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

import { createRoutes } from './http.js';

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
 * @param {object} ctx - the plugin context.
 * @param {unknown} _config - the row config; this plugin takes none.
 */
export function apply(ctx, _config) {
  const generator = { name: 'dsh-prompt-wisp', version: pluginVersion() };
  const log = loggerOf(ctx);

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
