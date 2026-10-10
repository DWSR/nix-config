'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

const fabroModulePath = `${repoRoot}/home-manager/common/fabro.nix`;

function standaloneFabroExpr(extraModule) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.fabro ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${fabroModulePath}
          ({ ... }: {
            home.username = "fabro-test";
            home.homeDirectory = "/Users/fabro-test";
            home.stateVersion = "26.05";
          })
          (${extraModule})
        ];
      };
    in
    {
      hasAgent = hm.config.launchd.agents ? fabro;
      agent =
        if hm.config.launchd.agents ? fabro then
          hm.config.launchd.agents.fabro
        else
          null;
      activation =
        if hm.config.home.activation ? fabroState then
          hm.config.home.activation.fabroState
        else
          null;
      sessionVariables = hm.config.home.sessionVariables or { };
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

test('default configuration registers the launchd agent on fabro defaults', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: { programs.fabro.enable = true; }`));

  assert.equal(rendered.hasAgent, true);
  assert.equal(rendered.agent.enable, true);

  const { config } = rendered.agent;
  assert.equal(config.Label, 'dev.dwsr.fabro');
  assert.match(config.ProgramArguments[0], /\/bin\/fabro$/);
  assert.deepEqual(config.ProgramArguments.slice(1), ['server', 'start', '--foreground']);
  assert.equal(config.RunAtLoad, true);
  assert.equal(config.KeepAlive, true);

  assert.equal(
    config.EnvironmentVariables.FABRO_HOME,
    '/Users/fabro-test/.local/state/fabro',
  );
  assert.equal(
    config.EnvironmentVariables.FABRO_STORAGE_DIR,
    '/Users/fabro-test/.local/share/fabro',
  );
  assert.equal(config.EnvironmentVariables.FABRO_LOG_DESTINATION, 'stdout');
  assert.equal(config.EnvironmentVariables.FABRO_NO_UPGRADE_CHECK, 'true');
  assert.equal(config.EnvironmentVariables.FABRO_TELEMETRY, 'off');
  assert.equal(config.EnvironmentVariables.FABRO_CONFIG, undefined);

  const pathComponents = config.EnvironmentVariables.PATH.split(':');
  assert.equal(pathComponents.length, 7);
  assert.match(pathComponents[0], /\/bin$/);
  assert.match(pathComponents[1], /.*home-manager-path.*\/bin$/);
  assert.deepStrictEqual(pathComponents.slice(-5), [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);

  assert.equal(config.StandardOutPath, '/Users/fabro-test/Library/Logs/fabro/fabro.log');
  assert.equal(
    config.StandardErrorPath,
    '/Users/fabro-test/Library/Logs/fabro/fabro.error.log',
  );
});

test('service PATH finds nix git and the user home packages', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: { programs.fabro.enable = true; }`));

  const { config } = rendered.agent;
  const components = config.EnvironmentVariables.PATH.split(':');
  assert.ok(
    components.some((entry) => /-git-\d.*\/bin$/.test(entry)),
    `expected a nix git in PATH, got: ${config.EnvironmentVariables.PATH}`,
  );
  assert.ok(
    components.some((entry) => /home-manager-path.*\/bin$/.test(entry)),
    `expected the home-manager package path in PATH, got: ${config.EnvironmentVariables.PATH}`,
  );
  assert.equal(components.at(-1), '/sbin');
});

test('home-manager switch places the package on the user PATH', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: { programs.fabro.enable = true; }`));

  assert.ok(
    rendered.sessionVariables.FABRO_HOME === '/Users/fabro-test/.local/state/fabro',
    `expected FABRO_HOME in sessionVariables, got: ${JSON.stringify(rendered.sessionVariables)}`,
  );
  assert.equal(
    rendered.sessionVariables.FABRO_STORAGE_DIR,
    '/Users/fabro-test/.local/share/fabro',
  );
});

test('custom configuration reflects bind and extra arguments', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: {
    programs.fabro.enable = true;
    programs.fabro.bind = "127.0.0.1:32276";
    programs.fabro.extraArgs = [ "--max-concurrent-runs" "2" ];
    programs.fabro.storageDir = "/Users/fabro-test/.local/share/fabro-alt";
  }`));

  assert.equal(rendered.hasAgent, true);

  const { config } = rendered.agent;
  assert.match(config.ProgramArguments[0], /\/bin\/fabro$/);
  assert.deepEqual(
    config.ProgramArguments.slice(1),
    [
      'server',
      'start',
      '--foreground',
      '--bind',
      '127.0.0.1:32276',
      '--max-concurrent-runs',
      '2',
    ],
  );

  assert.equal(
    config.EnvironmentVariables.FABRO_STORAGE_DIR,
    '/Users/fabro-test/.local/share/fabro-alt',
  );
});

test('disabling web appends --no-web for a headless service', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: {
    programs.fabro.enable = true;
    programs.fabro.web = false;
  }`));

  assert.equal(rendered.hasAgent, true);
  assert.deepEqual(
    rendered.agent.config.ProgramArguments.slice(1),
    ['server', 'start', '--foreground', '--no-web'],
  );
});

test('enabled web passes neither --web nor --no-web', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: {
    programs.fabro.enable = true;
    programs.fabro.bind = "127.0.0.1:32276";
  }`));

  const args = rendered.agent.config.ProgramArguments;
  assert.equal(args.includes('--web'), false);
  assert.equal(args.includes('--no-web'), false);
  assert.deepEqual(args.slice(1, 6), [
    'server',
    'start',
    '--foreground',
    '--bind',
    '127.0.0.1:32276',
  ]);
});

test('declared settings are installed into FABRO_HOME at activation', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: {
    programs.fabro.enable = true;
    programs.fabro.settings = {
      _version = 1;
      server.web.url = "http://127.0.0.1:32276";
    };
  }`));

  assert.ok(rendered.activation, 'expected home.activation.fabroState to be present');
  assert.deepEqual(rendered.activation.after, ['writeBoundary']);

  assert.match(
    rendered.activation.data,
    /mkdir -p .*\.local\/state\/fabro .*\.local\/share\/fabro .*Library\/Logs\/fabro/,
  );
  assert.match(
    rendered.activation.data,
    /install -Dm600 -T .*fabro-settings\.toml.*\.local\/state\/fabro\/settings\.toml/,
  );

  const { config } = rendered.agent;
  assert.equal(config.EnvironmentVariables.FABRO_CONFIG, undefined);
});

test('undeclared settings leave the wizard-owned settings.toml alone', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: { programs.fabro.enable = true; }`));

  assert.ok(rendered.activation, 'expected home.activation.fabroState to be present');
  assert.equal(rendered.activation.data.includes('settings.toml'), false);
});

test('settings render as TOML at the pinned target path', () => {
  const rendered = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.fabro ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${fabroModulePath}
          ({ ... }: {
            home.username = "fabro-test";
            home.homeDirectory = "/Users/fabro-test";
            home.stateVersion = "26.05";
            programs.fabro.enable = true;
            programs.fabro.settings = {
              _version = 1;
              server.scheduler.max_concurrent_runs = 2;
            };
          })
        ];
      };
      settingsFile = hm.config.programs.fabro._settingsFile;
    in
    {
      isNull = settingsFile == null;
      text =
        if settingsFile == null then
          null
        else
          builtins.readFile settingsFile;
    }
  `);

  assert.equal(rendered.isNull, false);
  assert.match(rendered.text, /max_concurrent_runs = 2/);
});

test('disabled configuration registers no launchd agent', () => {
  const rendered = nixEvalJson(standaloneFabroExpr(`{ ... }: { }`));

  assert.equal(rendered.hasAgent, false);
  assert.equal(rendered.agent, null);
  assert.equal(rendered.activation, null);
});
