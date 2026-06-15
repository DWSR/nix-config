'use strict';

/*
 * validation.test.js — failure-case + syntax-gate assertions (Task 8.2).
 *
 * 4.3: each malformed binding set must ABORT `nix eval` of the renderer, and
 *      the stderr must name the offending binding/hotkey (the renderer's
 *      fail-fast `throw`s; no host needed).
 * 5.1 / 5.3: the rendered config is parse-checked with `luac -p` — the exact
 *      gate the delivery path (checked-config.nix) runs. A valid config passes
 *      (5.1); a config whose extraConfig is broken Lua fails with a luac parse
 *      error (5.3). Testing the gate's MECHANISM directly (render via
 *      `nix eval --raw`, then `luac -p`) avoids a recursive `nix build` inside
 *      the flake-check sandbox, which lacks the build daemon.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { luacParse, nixEvalFailure, nixEvalRaw, renderExpr } = require('./helpers');

// Req 4.3: duplicate hotkey, incomplete binding (zero/two actions, empty key),
// and unsupported modifier/key each abort evaluation naming the offence.
const evalFailureCases = [
  { fixture: 'duplicate', offence: /duplicate hotkey 'cmd\+ctrl\+a'/ },
  { fixture: 'zeroAction', offence: /declares no action/ },
  { fixture: 'twoAction', offence: /declares 2 actions/ },
  { fixture: 'emptyKey', offence: /is missing its key/ },
  { fixture: 'badMod', offence: /unsupported modifier\(s\) hyper/ },
  { fixture: 'badKey', offence: /unsupported key 'F21'/ },
];

for (const { fixture, offence } of evalFailureCases) {
  test(`malformed set "${fixture}" aborts renderer evaluation naming the offence (4.3)`, () => {
    const stderr = nixEvalFailure(renderExpr(fixture));

    assert.match(stderr, /error:/, `${fixture}: nix eval reports an error`);
    assert.match(stderr, /hammerspoon-keybindings:/, `${fixture}: error is the renderer's own throw`);
    assert.match(stderr, offence, `${fixture}: error names the offence`);
  });
}

test('valid rendered config passes the luac -p syntax gate (5.1)', () => {
  const lua = nixEvalRaw(renderExpr('validMulti'));
  const { status, error, stderr } = luacParse(lua);

  assert.equal(error, undefined, `luac must be available on PATH: ${error}`);
  assert.equal(status, 0, `luac -p must accept valid rendered Lua; stderr: ${stderr}`);
});

test('rendered config with a Lua syntax error fails the luac -p syntax gate (5.3)', () => {
  const lua = nixEvalRaw(renderExpr('syntaxError'));
  const { status, error, stderr } = luacParse(lua);

  assert.equal(error, undefined, `luac must be available on PATH: ${error}`);
  assert.notEqual(status, 0, 'luac -p must reject a config with a Lua syntax error');
  assert.match(stderr, /luac/, 'luac identifies itself in the parse error');
  assert.match(stderr, /(syntax error|unexpected symbol|near)/, 'luac reports a parse error');
});
