/**
 * dsh-prompt-wisp — durable plugin configuration.
 *
 * One JSON document at `<DSH_HOME>/dsh-prompt-wisp/config.json`, written
 * atomically (temp file + rename) so a crash mid-write can never leave a
 * torn config behind, and a hand-edited nonsense document normalizes to
 * defaults instead of breaking the button.
 *
 * The settings service (`ctx.settings.register`) would be the idiomatic home
 * for this, but its schema parameter is a schemastery `z` value — importing
 * `@deepseek-ai/schemastery` from a link:-installed plugin violates the
 * zero-dependency red line that keeps `dsh web` bootable. A plugin-owned
 * file with the same normalize-to-defaults discipline is the honest
 * alternative, and the config-manager's own persisted documents prove the
 * pattern works in this deployment.
 *
 * @module dsh-prompt-wisp/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { dshHomePath } from './home.js';
import { normalizeConfig } from './config.js';

/** The plugin's own directory under DSH_HOME. */
export const PLUGIN_DIR_NAME = 'dsh-prompt-wisp';
/** The config document inside it. */
export const CONFIG_FILE_NAME = 'config.json';

/** Absolute path of the config document. */
export function configFilePath() {
  return dshHomePath(PLUGIN_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Read the persisted config, resolving to defaults when absent or unreadable.
 * @returns {Promise<{ trimFiller: boolean, detailMode: boolean }>} the config.
 */
export async function readConfig() {
  try {
    const raw = await readFile(configFilePath(), 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    // Absent, unparsable, or unreadable all mean "defaults" — the config is
    // an enhancement, and a broken file must not break the button.
    return normalizeConfig(undefined);
  }
}

/**
 * Merge a partial patch into the persisted config and write it atomically.
 *
 * The patch merges RAW over the current value and the merged document
 * normalizes once, at the end. Normalizing the patch first would fill its
 * absent keys with defaults and clobber the current values — a PATCH
 * `{ detailMode: false }` would silently reset `trimFiller`.
 *
 * @param {unknown} patch - client-supplied patch (booleans win, everything
 *   else in it is ignored by the final normalize).
 * @returns {Promise<{ trimFiller: boolean, detailMode: boolean }>} the config
 *   as now persisted.
 */
export async function writeConfig(patch) {
  const current = await readConfig();
  const rawPatch = patch !== null && typeof patch === 'object' ? patch : {};
  const next = normalizeConfig({ ...current, ...rawPatch });
  const file = configFilePath();
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `${CONFIG_FILE_NAME}.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return next;
}
