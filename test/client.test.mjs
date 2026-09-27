/**
 * Client structural contract tests.
 *
 * The browser half has no React/DOM dependency (zero-dependency rule), so
 * rendering cannot be tested offline. What CAN be pinned is the structure the
 * slot system and the host API depend on — each assertion below names the
 * runtime behavior it guards. Known limit, honestly stated: these are
 * structural assertions, not render tests (dsh-session-vault, 问题 3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

test('import flow structure — the slot entry reads the draft and writes it back through the official actions', () => {
  // Read: the input machine snapshot, never the editor DOM.
  assert.match(source, /useInput\(function \(state\) \{ return state\.draft; \}\)/, 'draft read via useInput selector');
  assert.match(source, /props\.inputActions|inputActions\.setDraft/, 'draft write via inputActions.setDraft');
  assert.match(source, /inputActions\.setDraft\(optimized\)/, 'the optimized text is what gets written back');
  // The component must not query or mutate the composer DOM.
  assert.doesNotMatch(source, /querySelector|contenteditable|data-composer-input/, 'no editor DOM access');
});

test('lifecycle — the popover never unmounts the button while busy, and requests are guarded', () => {
  // The button renders its popover as a sibling INSIDE the wrapper, so an
  // error/applied state can never remount the button itself.
  assert.match(source, /'dpw-wrap'/, 'wrapper exists');
  assert.match(source, /\(error \|\| applied\) && h\('div', \{\s*className: 'dpw-pop'/, 'popover is conditional sibling');
  // Double-click guard.
  assert.match(source, /if \(busy \|\| !draftIsOptimizable\(draft\)\) return;/, 'run() re-entrancy guard');
  // Busy is always cleared.
  assert.match(source, /finally \{\s*setBusy\(false\);?\s*\}/, 'busy resets in finally');
});

test('stylesheet contract — every var(--dsw-*) reference carries a fallback', () => {
  // Extract all CSS declarations; any var(--dsw-*) without a fallback is a
  // silent drop in a theme missing that token (dsh-session-vault, 问题 5).
  const cssStart = source.indexOf("var CSS = [");
  assert.ok(cssStart > 0, 'CSS block exists');
  const cssEnd = source.indexOf('].join', cssStart);
  const css = source.slice(cssStart, cssEnd);
  const refs = css.matchAll(/var\((--dsw-[a-z0-9-]*)/g);
  let checked = 0;
  for (const match of refs) {
    checked += 1;
    // The full var() expression must contain a comma (fallback present).
    const start = match.index;
    const segment = css.slice(start, start + 160);
    assert.match(segment, /var\(--dsw-[a-z0-9-]+,\s*[^)]+\)/, `fallback missing for ${match[1]}`);
  }
  assert.ok(checked >= 5, `expected several dsw token references, found ${checked}`);
});

test('api contract — non-JSON bodies are reported, not swallowed', () => {
  assert.match(source, /await response\.text\(\)/, 'read as text first');
  assert.match(source, /payload\.ok !== true/, 'envelope ok flag checked');
  assert.match(source, /payload\.error \|\|/, 'server error message surfaced');
});

test('deferred registration — every slot waits for its declarer', () => {
  assert.match(source, /ctx\.slots\.inject\('conversation\.input\.right'/, 'composer button slot');
  assert.match(source, /ctx\.slots\.inject\('conversation\.input\.dock'/, 'watch banner slot');
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/, 'settings page slot');
  assert.match(source, /id: 'prompt-wisp-watch'/, 'watch banner entry id');
});

test('watch banner lives in the dock, not on the button — no overlay over input/transcript', () => {
  // The banner is its own component registered to input.dock (in-flow above
  // the composer), NOT a popover anchored to the 26px button.
  assert.match(source, /function WispWatchBanner/, 'banner component exists');
  assert.match(source, /name: 'conversation\.input\.dock'/, 'banner registered to the dock');
  // The old button-anchored popover/dot is gone.
  assert.doesNotMatch(source, /dpw-watch\b/, 'old button-anchored watch popover removed');
  assert.doesNotMatch(source, /dpw-watch-dot/, 'old watch dot removed');
  // The banner only renders when there are findings worth showing.
  assert.match(source, /var visible = showable && findingsKey !== dismissedKey;/, 'visibility gate');
});
