'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nixEvalJson,
  repoRoot,
} = require('./helpers');

function standaloneTailscaleServeDefaultsExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evalModule = extraModule:
        let
          hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [
              ${repoRoot}/home-manager/common/tailscale-serve.nix
              ({ ... }: {
                home.username = "tailscale-serve-test";
                home.homeDirectory = "/Users/tailscale-serve-test";
                home.stateVersion = "25.11";
              })
              extraModule
            ];
          };
          config = hm.config;
          tailscaleActivationNames = builtins.filter
            (name:
              (builtins.match ".*tailscale.*" name) != null
              || (builtins.match ".*Tailscale.*" name) != null)
            (builtins.attrNames config.home.activation);
        in
        {
          enable = config.home.tailscaleServe.enable;
          cliPath = config.home.tailscaleServe.cliPath;
          entries = config.home.tailscaleServe.entries;
          renderedCommands = config.home.tailscaleServe._renderedCommands;
          inherit tailscaleActivationNames;
        };
    in
    {
      disabled = evalModule ({ ... }: { });
      enabledEmpty = evalModule ({ ... }: {
        home.tailscaleServe.enable = true;
      });
    }
  `;
}

test('helper evaluates repository expressions without host side effects', () => {
  const rendered = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
    in
    {
      hasDarwinConfigurations = flake ? darwinConfigurations;
      hasPersonalHost = flake.darwinConfigurations ? "Brandons-MacBook-Pro";
    }
  `);

  assert.equal(rendered.hasDarwinConfigurations, true);
  assert.equal(rendered.hasPersonalHost, true);
});

test('standalone Tailscale Serve module exposes dormant option namespace', () => {
  const rendered = nixEvalJson(standaloneTailscaleServeDefaultsExpr());

  assert.equal(rendered.disabled.enable, false);
  assert.equal(
    rendered.disabled.cliPath,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  );
  assert.deepEqual(rendered.disabled.entries, {});
  assert.deepEqual(rendered.disabled.renderedCommands, []);
  assert.deepEqual(rendered.disabled.tailscaleActivationNames, []);

  assert.equal(rendered.enabledEmpty.enable, true);
  assert.equal(
    rendered.enabledEmpty.cliPath,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  );
  assert.deepEqual(rendered.enabledEmpty.entries, {});
  assert.deepEqual(rendered.enabledEmpty.renderedCommands, []);
  assert.deepEqual(rendered.enabledEmpty.tailscaleActivationNames, []);
});
