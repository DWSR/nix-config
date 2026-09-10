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
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      import ${moduleTestPath} { inherit lib pkgs; }
  `;
}

function readOnlyNixExecutable(fixture) {
  return fixture.createExecutable('nix-read-only', `
    const childProcess = require('node:child_process');
    const result = childProcess.spawnSync('nix', [process.argv[2], '--read-only', ...process.argv.slice(3)], {
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      throw result.error;
    }
    process.exit(result.status ?? 1);
  `);
}

test('remote-builder module contract and defaults evaluate successfully', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const nixExecutable = readOnlyNixExecutable(fixture);
    assert.equal(nixEvalJson(moduleTestExpression(), {
      cwd: repoRoot,
      fixture,
      nixExecutable,
    }), true);
  } finally {
    fixture.cleanup();
  }
});
