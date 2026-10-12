'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, nixEvalFailure, repoRoot } = require('./helpers');

const limaModulePath = `${repoRoot}/home-manager/common/lima-vm.nix`;

function standaloneLimaExpr(extraModule, name = 'fabro') {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.unstable-packages ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${limaModulePath}
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
      hasAgent = hm.config.launchd.agents ? lima-${name};
      agent =
        if hm.config.launchd.agents ? lima-${name} then
          hm.config.launchd.agents.lima-${name}
        else
          null;
      agentNames = builtins.attrNames hm.config.launchd.agents;
      packages = map (p: p.name or "") hm.config.home.packages;
      configYaml =
        if (hm.config.virtualisation.limaVM._configYaml or null) != null then
          builtins.readFile hm.config.virtualisation.limaVM._configYaml
        else
          null;
      supervisorText =
        if (hm.config.virtualisation.limaVM._supervisor or null) != null then
          builtins.readFile (
            hm.config.virtualisation.limaVM._supervisor + "/bin/lima-${name}-supervisor"
          )
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

test('disabled configuration registers no launchd agent', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: { }`));

  assert.equal(rendered.hasAgent, false);
  assert.equal(rendered.agent, null);
  assert.equal(rendered.configYaml, null);
  assert.equal(rendered.supervisorText, null);
});

test('enabled configuration registers the launchd agent on lima defaults', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: { virtualisation.limaVM.enable = true; }`));

  assert.equal(rendered.hasAgent, true);
  assert.equal(rendered.agent.enable, true);

  const { config } = rendered.agent;
  assert.equal(config.Label, 'dev.dwsr.lima-fabro');
  assert.match(config.ProgramArguments[0], /lima-fabro-supervisor$/);
  assert.equal(config.RunAtLoad, true);
  assert.equal(config.KeepAlive.SuccessfulExit, false);
  assert.equal(config.ProcessType, 'Background');

  assert.equal(
    config.EnvironmentVariables.LIMA_HOME,
    '/Users/fabro-test/.local/state/lima',
  );
  assert.equal(config.EnvironmentVariables.HOME, '/Users/fabro-test');

  const pathComponents = config.EnvironmentVariables.PATH.split(':');
  assert.ok(
    pathComponents.some((entry) => /lima-\d.*\/bin$/.test(entry)),
    `expected the lima package in PATH, got: ${config.EnvironmentVariables.PATH}`,
  );
  assert.ok(
    pathComponents.some((entry) => /openssh.*\/bin$/.test(entry)),
    `expected nix openssh in PATH for the hostagent's ssh/ssh-keygen, got: ${config.EnvironmentVariables.PATH}`,
  );
  assert.deepStrictEqual(pathComponents.slice(-5), [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);

  assert.equal(config.StandardOutPath, '/Users/fabro-test/Library/Logs/lima-vm/lima-fabro.log');
  assert.equal(
    config.StandardErrorPath,
    '/Users/fabro-test/Library/Logs/lima-vm/lima-fabro.error.log',
  );

  assert.ok(
    rendered.packages.some((name) => name.startsWith('lima-')),
    `expected the lima package in home.packages, got: ${JSON.stringify(rendered.packages)}`,
  );
  assert.ok(
    rendered.packages.some((name) => name.startsWith('lima-vmctl')),
    `expected lima-vmctl in home.packages, got: ${JSON.stringify(rendered.packages)}`,
  );
});

test('rendered Lima YAML matches the module defaults', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: { virtualisation.limaVM.enable = true; }`));

  const yaml = rendered.configYaml;
  assert.ok(yaml, 'expected virtualisation.limaVM._configYaml to render');

  assert.match(yaml, /images:/);
  assert.match(
    yaml,
    /location: ?['"]?https:\/\/github\.com\/nixos-lima\/nixos-lima\/releases\/download\/v0\.2\.2\/nixos-lima-v0\.2\.2-(aarch64|x86_64)\.qcow2/,
  );
  assert.match(yaml, /arch: ?['"]?(aarch64|x86_64)['"]?/);
  assert.match(yaml, /digest: ?['"]?sha512:[0-9a-f]+['"]?/);

  assert.match(yaml, /vmType: ?['"]?vz['"]?/);
  assert.match(yaml, /cpus: ?4\b/);
  assert.match(yaml, /memory: ?['"]?8GiB['"]?/);
  assert.match(yaml, /disk: ?['"]?60GiB['"]?/);

  assert.match(yaml, /mounts: ?\[\]/);
  assert.match(yaml, /containerd:\n(?:.*\n)*?\s+system: ?false/);
  assert.match(yaml, /containerd:\n(?:.*\n)*?\s+user: ?false/);

  assert.match(yaml, /\s*proto: ?['"]?udp['"]?/);
  assert.match(yaml, /\s*guestPort: ?68\b/);
  assert.match(yaml, /\s*guestIP: ?['"]?0\.0\.0\.0['"]?/);
  assert.match(yaml, /\s*ignore: ?true/);
});

test('supervisor creates the instance on first run and supervises in the foreground', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: { virtualisation.limaVM.enable = true; }`));

  const wrapper = rendered.supervisorText;
  assert.ok(wrapper, 'expected virtualisation.limaVM._supervisor to render');

  assert.match(
    wrapper,
    /export LIMA_HOME=?['"]?\/Users\/fabro-test\/\.local\/state\/lima['"]?/,
  );

  // Missing instance: create from the module-rendered config (the bare
  // `limactl start NAME` fallback would create the default Ubuntu template
  // instead of the module's NixOS Lima config).
  assert.match(
    wrapper,
    /if ! limactl list --json "\$name" >\/dev\/null 2>&1; then/,
  );
  assert.match(
    wrapper,
    /limactl --tty=false create --name="\$name" "\$config"/,
  );

  // Supervise in the foreground, mirroring Lima's own autostart
  // LaunchAgent; an already-running instance returns success (exit 0), so
  // launchd's KeepAlive.SuccessfulExit=false leaves it alone.
  assert.match(
    wrapper,
    /exec limactl --tty=false start --foreground "\$name"/,
  );
});

test('custom instance name propagates to the agent and plist label', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: {
    virtualisation.limaVM.enable = true;
    virtualisation.limaVM.name = "other-vm";
  }`, 'other-vm'));

  assert.deepEqual(rendered.agentNames, [ 'lima-other-vm' ]);
  assert.equal(rendered.agent.config.Label, 'dev.dwsr.lima-other-vm');
  assert.match(rendered.agent.config.ProgramArguments[0], /lima-other-vm-supervisor$/);
  assert.equal(
    rendered.agent.config.StandardOutPath,
    '/Users/fabro-test/Library/Logs/lima-vm/lima-other-vm.log',
  );
});

test('invalid instance names fail the eval loudly', () => {
  const failure = nixEvalFailure(standaloneLimaExpr(`{ ... }: {
    virtualisation.limaVM.enable = true;
    virtualisation.limaVM.name = "Bad Name!";
  }`));

  assert.match(
    failure,
    /virtualisation\.limaVM\.name must be a valid lima instance name/,
  );
});

test('extraLimaConfig merges over the rendered keys', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: {
    virtualisation.limaVM.enable = true;
    virtualisation.limaVM.extraLimaConfig.memory = "16GiB";
  }`));

  assert.match(rendered.configYaml, /memory: ?['"]?16GiB['"]?/);
  assert.doesNotMatch(rendered.configYaml, /memory: ?['"]?8GiB['"]?/);
});

test('a custom image can point at a store path without a digest', () => {
  const rendered = nixEvalJson(standaloneLimaExpr(`{ ... }: {
    virtualisation.limaVM.enable = true;
    virtualisation.limaVM.image.location = "/nix/store/fabro-vm-image/nixos.qcow2";
    virtualisation.limaVM.image.digest = null;
  }`));

  assert.match(
    rendered.configYaml,
    /location: ?['"]?\/nix\/store\/fabro-vm-image\/nixos\.qcow2['"]?/,
  );
  assert.doesNotMatch(rendered.configYaml, /digest:/);
});

test('non-native image arch under the VZ driver fails the eval', () => {
  const failure = nixEvalFailure(standaloneLimaExpr(`({ pkgs, ... }: {
    virtualisation.limaVM.enable = true;
    virtualisation.limaVM.image.arch =
      if pkgs.stdenv.hostPlatform.isAarch64 then "x86_64" else "aarch64";
  })`));

  assert.match(
    failure,
    /the VZ driver requires a native-architecture guest/,
  );
});

test('the personal host enables the managed lima VM', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
    in
    {
      enable = hm.virtualisation.limaVM.enable;
      configYamlNotNull = hm.virtualisation.limaVM._configYaml != null;
      supervisorNotNull = hm.virtualisation.limaVM._supervisor != null;
      hasAgent = hm.launchd.agents ? lima-fabro;
      agent = hm.launchd.agents.lima-fabro or null;
    }
  `,
    { timeout: 600_000 },
  );

  assert.equal(rendered.enable, true);
  assert.equal(rendered.configYamlNotNull, true);
  assert.equal(rendered.supervisorNotNull, true);
  assert.equal(rendered.hasAgent, true);

  const { config } = rendered.agent;
  assert.equal(config.Label, 'dev.dwsr.lima-fabro');
  assert.match(config.ProgramArguments[0], /lima-fabro-supervisor$/);
  assert.equal(
    config.EnvironmentVariables.LIMA_HOME,
    '/Users/brandonmcnama/.local/state/lima',
  );
});
