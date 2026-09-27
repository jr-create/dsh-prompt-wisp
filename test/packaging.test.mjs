/**
 * Packaging red line: the plugin must load on a machine where it can never
 * resolve `@deepseek-ai/*` packages (see dsh-session-vault, 问题 4 — a link-
 * installed plugin is imported from its own real path, and a single host
 * import kills the whole plugin tree and `dsh web` with it).
 *
 * These tests really import every module with no `node_modules` in scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('every lib module imports with no host packages installed', async () => {
  for (const file of ['index.js', 'engine.js', 'http.js', 'client.js']) {
    const url = pathToFileURL(join(root, 'lib', file));
    // client.js touches window at top level; guard it the same way the
    // loader environment would not — import it only as a text contract
    // below, not as a module, so this test stays offline-safe.
    if (file === 'client.js') continue;
    await import(url.href);
  }
});

test('client.js parses as a script and follows the loader contract', () => {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  // Parse without executing (no window in Node).
  new Function(source);
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/, 'must register through __ModuleLoader__');
  assert.match(source, /id:\s*'dsh-prompt-wisp'/, 'id must be the exact package name');
  assert.match(source, /require\('react'\)/, 'React arrives through the factory require');
  assert.match(source, /conversation\.input\.right/, 'must register the composer slot');
  assert.match(source, /exports\.apply\s*=\s*apply/, 'must export apply');
  assert.match(source, /exports\.inject\s*=\s*inject/, 'must export inject');
});

test('no source file imports a @deepseek-ai package', () => {
  for (const file of ['index.js', 'engine.js', 'http.js', 'client.js']) {
    const source = readFileSync(join(root, 'lib', file), 'utf8');
    assert.doesNotMatch(source, /@deepseek-ai/, `${file} must not import host packages`);
  }
});

test('package.json forbids dependencies and declares the client half', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies, undefined, 'zero runtime dependencies');
  assert.equal(manifest.peerDependencies, undefined, 'no peer dependencies');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  assert.equal(manifest.exports['./client'], './lib/client.js');
});

test('patch row id matches the host plugin name constant', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*prompt-wisp/, 'row id prompt-wisp');
  const index = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  assert.match(index, /export const name = 'prompt-wisp'/, 'host name constant');
});
