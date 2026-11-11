'use strict';

// Task 6.4 registration contract: the focused Linux remote-builder suite must
// be exposed as `checks.<system>.linux-nix-remote-builder`, and that check must
// run this directory's Node suite. The assertion inspects the check
// derivation's build command so a renamed or detached check cannot silently
// pass.
const assert = require('node:assert/strict');
const test = require('node:test');

const { nixEvalJson, repoRoot } = require('./helpers');

test('the flake registers linux-nix-remote-builder for the focused suite', () => {
  const rendered = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      system = builtins.currentSystem;
      checks = flake.checks.\${system} or { };
      check = checks.linux-nix-remote-builder or null;
    in
    {
      system = system;
      exists = check != null;
      name = if check != null then check.name else null;
      drvText = if check != null then builtins.readFile check.drvPath else "";
      checkNames = builtins.attrNames checks;
    }
  `);

  assert.equal(
    rendered.exists,
    true,
    `checks.${rendered.system} must expose linux-nix-remote-builder; `
      + `registered checks: ${rendered.checkNames.join(', ')}`,
  );
  assert.equal(rendered.name, 'linux-nix-remote-builder');
  assert.match(
    rendered.drvText,
    /node --test tests\/linux-nix-remote-builder\//,
    'the linux-nix-remote-builder check must run the focused test directory',
  );
});
