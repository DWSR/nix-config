'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const expression = `
  let
    flake = builtins.getFlake (toString ./.);
    host = flake.darwinConfigurations."Brandons-MacBook-Pro";
    personal = host.config.home-manager.users.brandonmcnama;
    hasModule = personal.home ? totalRecall;
    defaults =
      (flake.inputs.home-manager.lib.homeManagerConfiguration {
        pkgs = host.pkgs;
        modules = [
          ./home-manager/common/total-recall.nix
          ({ ... }: {
            home.username = "total-recall-test";
            home.homeDirectory = "/Users/total-recall-test";
            home.stateVersion = "26.05";
            home.totalRecall.endpoint = "wss://example.invalid";
          })
        ];
      }).config.home.totalRecall;
  in {
    hasModule = hasModule;
    personal = if hasModule then {
      enable = personal.home.totalRecall.enable;
      endpoint = personal.home.totalRecall.endpoint;
      databaseConnection = personal.home.totalRecall.databaseConnection;
      harnessEventsDefault = toString personal.home.totalRecall.harnessEvents == toString host.pkgs.total-recall-harness-events;
      opencodePluginDefault = toString personal.home.totalRecall.opencodePlugin == toString host.pkgs.total-recall-opencode-plugin;
      piExtensionDefault = toString personal.home.totalRecall.piExtension == toString host.pkgs.total-recall-pi-extension;
      mcpWorkerDefault = toString personal.home.totalRecall.mcpWorker == toString host.pkgs.total-recall-mcp-worker;
    } else null;
    defaults = {
      enable = defaults.enable;
      endpoint = defaults.endpoint;
      databaseConnection = defaults.databaseConnection;
      harnessEventsDefault = toString defaults.harnessEvents == toString host.pkgs.total-recall-harness-events;
      opencodePluginDefault = toString defaults.opencodePlugin == toString host.pkgs.total-recall-opencode-plugin;
      piExtensionDefault = toString defaults.piExtension == toString host.pkgs.total-recall-pi-extension;
      mcpWorkerDefault = toString defaults.mcpWorker == toString host.pkgs.total-recall-mcp-worker;
    };
  }
`;

test('personal host enables the shared Total Recall module with pinned client package defaults', () => {
  const result = spawnSync(
    'nix',
    ['eval', '--impure', '--json', '--expr', expression],
    { encoding: 'utf8', timeout: 600_000 },
  );

  assert.equal(result.status, 0, `Nix Home Manager evaluation failed:\n${result.stderr}`);
  const evaluated = JSON.parse(result.stdout);
  assert.equal(evaluated.hasModule, true, 'common Home Manager imports expose home.totalRecall');
  assert.deepEqual(evaluated.personal, {
    enable: true,
    endpoint: 'wss://total-recall.tuxedo-musical.ts.net',
    databaseConnection: 'memory',
    harnessEventsDefault: true,
    opencodePluginDefault: true,
    piExtensionDefault: true,
    mcpWorkerDefault: true,
  });
  assert.deepEqual(evaluated.defaults, {
    enable: false,
    endpoint: 'wss://example.invalid',
    databaseConnection: 'memory',
    harnessEventsDefault: true,
    opencodePluginDefault: true,
    piExtensionDefault: true,
    mcpWorkerDefault: true,
  });
});
