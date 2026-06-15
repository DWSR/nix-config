'use strict';

/*
 * render.test.js — render-content assertions for the pure Hammerspoon
 * keybinding renderer (Task 8.2, Req 4.2 + 4.4).
 *
 * Drives `nix eval` of render.nix with fixtures.nix and asserts the rendered
 * init.lua carries the header, the per-action Lua for EACH action type, the
 * `hs.hotkey.bind` calls, and the reload watcher — and that an empty set
 * renders a header-only config with no binds. The eval is pure (render.nix +
 * nixpkgs `lib` only), so it needs no host, no Hammerspoon app, and no
 * Accessibility grant (4.4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, renderExpr } = require('./helpers');

test('representative set renders header, every action type, binds, and the reload watcher (4.2)', () => {
  const lua = nixEvalJson(renderExpr('validMulti'));

  // Header (Req 2.2): Sparkle disabled, Accessibility prompt, grant comment.
  assert.match(lua, /hs\.automaticallyCheckForUpdates\(false\)/);
  assert.match(lua, /hs\.accessibilityState\(true\)/);
  assert.match(lua, /Accessibility/);

  // extraConfig escape hatch passes through verbatim.
  assert.match(lua, /-- operator supplied extra config/);

  // Per-action Lua (Req 3.2):
  //   command     -> hs.execute(<escaped>, true)  (login shell for PATH)
  assert.match(lua, /hs\.execute\("\/run\/current-system\/sw\/bin\/true", true\)/);
  //   applescript -> hs.osascript.applescript(<escaped>) with escaped quotes
  assert.match(lua, /hs\.osascript\.applescript\("display notification \\"hi\\""\)/);
  //   lua         -> inlined verbatim
  assert.match(lua, /hs\.reload\(\)/);

  // hs.hotkey.bind with the ordered mods table + key (Req 3.1, 3.3), once per
  // declared binding.
  assert.match(lua, /hs\.hotkey\.bind\(\{ "ctrl", "cmd", "shift" \}, "F12", function\(\) /);
  assert.match(lua, /hs\.hotkey\.bind\(\{ "cmd", "alt" \}, "A", function\(\) /);
  assert.match(lua, /hs\.hotkey\.bind\(\{ "cmd" \}, "space", function\(\) /);
  const bindCount = (lua.match(/hs\.hotkey\.bind\(/g) || []).length;
  assert.equal(bindCount, 3, 'one bind per declared keybinding');

  // A non-empty description rides above its binding as a one-line comment.
  assert.match(lua, /-- Toggle microphone mute\nhs\.hotkey\.bind/);

  // Reload watcher on hs.configdir, no hardcoded path (Req 3.5).
  assert.match(lua, /hs\.pathwatcher\.new\(hs\.configdir, hs\.reload\):start\(\)/);
});

test('empty set renders a valid header-only config with no binds (4.2)', () => {
  const lua = nixEvalJson(renderExpr('empty'));

  assert.match(lua, /hs\.automaticallyCheckForUpdates\(false\)/);
  assert.match(lua, /hs\.accessibilityState\(true\)/);
  assert.match(lua, /Accessibility/);

  // No bindings declared -> no hotkey binds.
  assert.doesNotMatch(lua, /hs\.hotkey\.bind\(/);
  // reloadOnConfigChange = false -> no watcher.
  assert.doesNotMatch(lua, /hs\.pathwatcher/);
});

test('renderer + syntax gate run host-free: no host, no Hammerspoon app, no Accessibility (4.4)', () => {
  const expr = renderExpr('validMulti');

  // No host evaluation: the render path never reaches darwinConfigurations.
  assert.doesNotMatch(expr, /darwinConfigurations/);
  // No package/app build: only nixpkgs `lib` is imported — never a pkgs set or
  // the Hammerspoon bundle — so no install or Accessibility grant is required.
  assert.match(expr, /inputs\.nixpkgs\.lib/);
  assert.doesNotMatch(expr, /pkgs\.hammerspoon/);
  assert.doesNotMatch(expr, /import\s+\S*nixpkgs\s*\{/);

  // And it really renders from `lib` alone.
  assert.ok(nixEvalJson(expr).length > 0, 'render produces a non-empty config');
});
