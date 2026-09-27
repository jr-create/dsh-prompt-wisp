/**
 * The harness home path, resolved without importing a host package.
 *
 * Same discipline as dsh-session-vault's home.js: `@deepseek-ai/dsh-home-paths`
 * is unreachable from a link:-installed plugin, and the resolution rule is a
 * stable documented contract — an explicit path, then `$DSH_HOME`, then
 * `~/.dsh` — so reproducing it here is safe and keeps the package at zero
 * dependencies.
 *
 * @module dsh-prompt-wisp/home
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Environment variable that overrides the default harness home. */
const DSH_HOME_ENV = 'DSH_HOME';
/** Directory name for the default harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh';

/**
 * Expand `~`, `~/`, and `~\` against the operating-system home.
 * @param {string} path - a configured path that may start with a tilde prefix.
 * @returns {string} the expanded path, or the original value when no prefix.
 */
function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the single-root harness home.
 *
 * An empty or whitespace-only `$DSH_HOME` counts as unset, so a blank
 * override never resolves the home to the current working directory.
 *
 * @param {string} [configured] - explicit override, highest precedence.
 * @param {Record<string, string|undefined>} [env] - environment mapping.
 * @returns {string} the normalized absolute harness home.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV];
  const useEnv = fromEnv !== undefined && fromEnv.trim().length > 0;
  const chosen = configured ?? (useEnv ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME));
  return resolve(expandHomePath(chosen));
}

/**
 * Join path segments onto the resolved harness home.
 * @param {...string} segments - segments appended to the home.
 * @returns {string} the normalized absolute joined path.
 */
export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}
