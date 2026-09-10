'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  repoRoot,
} = require('./helpers');

const moduleTestPath = path.join(__dirname, 'module.test.nix');

function moduleTestExpression() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      lib = flake.inputs.nixpkgs.lib;
    in
      import ${moduleTestPath} { inherit lib; }
  `;
}

test('remote-builder module contract and defaults evaluate successfully', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    assert.equal(nixEvalJson(moduleTestExpression(), {
      cwd: repoRoot,
      fixture,
    }), true);
  } finally {
    fixture.cleanup();
  }
});
