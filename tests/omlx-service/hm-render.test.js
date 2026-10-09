'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

const omlxModulePath = `${repoRoot}/configurations/personal/home-manager/omlx.nix`;

function standaloneOmlxExpr(extraModule) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.omlx ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${omlxModulePath}
          ({ ... }: {
            home.username = "omlx-test";
            home.homeDirectory = "/Users/omlx-test";
            home.stateVersion = "26.05";
          })
          (${extraModule})
        ];
      };
    in
    {
      hasAgent = hm.config.launchd.agents ? omlx;
      agent =
        if hm.config.launchd.agents ? omlx then
          hm.config.launchd.agents.omlx
        else
          null;
      activation =
        if hm.config.home.activation ? omlxLogDir then
          hm.config.home.activation.omlxLogDir
        else
          null;
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

test('default configuration registers the launchd agent on loopback port 8000', () => {
  const rendered = nixEvalJson(standaloneOmlxExpr(`{ ... }: { home.omlx.enable = true; }`));

  assert.equal(rendered.hasAgent, true);
  assert.equal(rendered.agent.enable, true);

  const { config } = rendered.agent;
  assert.equal(config.Label, 'dev.dwsr.omlx');
  assert.match(config.ProgramArguments[0], /\/bin\/omlx$/);
  assert.deepEqual(
    config.ProgramArguments.slice(1),
    ['serve', '--host', '127.0.0.1', '--port', '8000'],
  );
  assert.equal(config.RunAtLoad, true);
  assert.equal(config.KeepAlive, true);
  assert.equal(
    config.StandardOutPath,
    '/Users/omlx-test/Library/Logs/omlx/omlx.log',
  );
  assert.equal(
    config.StandardErrorPath,
    '/Users/omlx-test/Library/Logs/omlx/omlx.error.log',
  );
});

test('custom configuration reflects host, port, and extra arguments', () => {
  const rendered = nixEvalJson(standaloneOmlxExpr(`{ ... }: {
    home.omlx.enable = true;
    home.omlx.host = "0.0.0.0";
    home.omlx.port = 9000;
    home.omlx.extraArgs = [ "--verbose" "--model" "example" ];
  }`));

  assert.equal(rendered.hasAgent, true);

  const { config } = rendered.agent;
  assert.match(config.ProgramArguments[0], /\/bin\/omlx$/);
  assert.deepEqual(
    config.ProgramArguments.slice(1),
    [
      'serve',
      '--host',
      '0.0.0.0',
      '--port',
      '9000',
      '--verbose',
      '--model',
      'example',
    ],
  );
});

test('disabled configuration registers no launchd agent', () => {
  const rendered = nixEvalJson(standaloneOmlxExpr(`{ ... }: { }`));

  assert.equal(rendered.hasAgent, false);
  assert.equal(rendered.agent, null);
  assert.equal(rendered.activation, null);
});

test('enabled configuration creates the log directory before the agent starts', () => {
  const rendered = nixEvalJson(standaloneOmlxExpr(`{ ... }: { home.omlx.enable = true; }`));

  assert.ok(rendered.activation, 'expected home.activation.omlxLogDir to be present');
  assert.deepEqual(rendered.activation.after, ['writeBoundary']);
  assert.match(
    rendered.activation.data,
    /mkdir -p "\/Users\/omlx-test\/Library\/Logs\/omlx"/,
  );
});
