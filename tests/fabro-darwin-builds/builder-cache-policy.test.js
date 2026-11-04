'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function nixEval(expression) {
  return childProcess.execFileSync('nix', [
    'eval', '--impure', '--raw', '--expr', expression,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
}

function evaluatePolicy(extraModule = '{}', failOnAssertions = false) {
  const expression = `let
    flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    host = flake.darwinConfigurations.mac-builder.extendModules { modules = [ ({ lib, ... }: ${extraModule}) ]; };
    cfg = host.config;
    failed = builtins.filter (entry: !entry.assertion) cfg.assertions;
    failedMessages = map (entry: entry.message) failed;
  in builtins.toJSON {
    hostPlatform = cfg.nixpkgs.hostPlatform.system;
    extraPlatforms = cfg.nix.settings."extra-platforms" or null;
    substituters = cfg.nix.settings.substituters;
    trustedPublicKeys = cfg.nix.settings.trusted-public-keys;
    extraSubstituters = cfg.nix.settings."extra-substituters" or [ ];
    postBuildHook = cfg.nix.settings."post-build-hook" or null;
    hasPrivateCache = builtins.any (value: builtins.match ".*(attic|private|.internal).*" value != null)
      (cfg.nix.settings.substituters ++ cfg.nix.settings.trusted-public-keys);
    enforced = if ${failOnAssertions ? "true" : "false"} && failed != [ ]
      then builtins.throw (builtins.concatStringsSep "\\n" failedMessages)
      else true;
  }`;
  const config = JSON.parse(nixEval(expression));
  return config;
}

test('mac-builder evaluates to exactly the public cache keys and Darwin-only policy', () => {
  const config = evaluatePolicy();

  assert.equal(config.hostPlatform, 'aarch64-darwin');
  assert.equal(config.extraPlatforms, null);
  assert.deepEqual(config.substituters, [
    'https://cache.nixos.org/',
    'https://nix-community.cachix.org',
  ]);
  assert.deepEqual(config.trustedPublicKeys, [
    'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
    'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=',
  ]);
  assert.deepEqual(config.extraSubstituters, []);
  assert.equal(config.postBuildHook, null);
  assert.equal(config.substituters.some(value => /attic|private|\.internal/i.test(value)), false);
  assert.equal(config.trustedPublicKeys.some(value => /attic|private|\.internal/i.test(value)), false);
  assert.equal(config.hasPrivateCache, false);
});

test('mac-builder assertion rejects a private cache host in substituters', () => {
  assert.throws(() => evaluatePolicy(`{
    nix.settings.substituters = lib.mkOverride 40 [ "https://cache.nixos.org/" "https://nix-community.cachix.org" "https://attic.private.example" ];
  }`, true), /mac-builder cache policy must not include a private cache host/);
});

test('mac-builder assertion rejects extra-platforms', () => {
  assert.throws(() => evaluatePolicy(`{
    nix.settings."extra-platforms" = lib.mkForce [ "x86_64-darwin" ];
  }`, true), /mac-builder must not configure nix.settings.extra-platforms/);
});
