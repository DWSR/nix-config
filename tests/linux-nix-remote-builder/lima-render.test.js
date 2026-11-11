'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { nixEvalFailure, nixEvalJson, repoRoot } = require('./helpers');

// The builder-specific adapter (`home-manager/common/lima-linux-builder.nix`)
// is a separate Home Manager module: it must render the `linux-builder` Lima
// instance with its own resources, launchd supervisor, and deploy command
// while leaving the existing `virtualisation.limaVM` Fabro guest alone. The
// personal host (`Brandons-MacBook-Pro`) is the only consumer; the portable
// NixOS host is asserted independently in builder-host.test.js.
const builderAdapterModulePath = `${repoRoot}/home-manager/common/lima-linux-builder.nix`;
const personalHostName = 'Brandons-MacBook-Pro';
const personalHostUser = 'brandonmcnama';
const builderInstanceName = 'linux-builder';
const builderNixosImage =
  'https://github.com/nixos-lima/nixos-lima/releases/download/v0.2.2/nixos-lima-v0.2.2-aarch64.qcow2';
const builderImageDigest =
  'sha512:bfcb703cdbad28cfd27438dc009408a859f3c4f575d3598d9627ea712c66128e0fa015de2010ce42bb724abc49f45029a4fc81891fb1a04c567378a6fdf31903';

const expectedFabroMounts = [
  {
    location: '~/.local/state/fabro',
    mountPoint: '/var/lib/fabro',
    writable: true,
  },
];

function builderAdapterExpr(extraModule = '{ ... }: { virtualisation.limaLinuxBuilder.enable = true; }') {
  return `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.unstable-packages ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${JSON.stringify(builderAdapterModulePath)}
          ({ ... }: {
            home.username = "builder-test";
            home.homeDirectory = "/Users/builder-test";
            home.stateVersion = "26.05";
          })
          (${extraModule})
        ];
      };
      cfg = hm.config.virtualisation.limaLinuxBuilder;
    in
    {
      enable = cfg.enable;
      name = cfg.name;
      hostname = cfg.hostname;
      guestSystem = cfg.guestSystem;
      cpus = cfg.cpus;
      memory = cfg.memory;
      disk = cfg.disk;
      configYaml =
        if (cfg._configYaml or null) != null then builtins.readFile cfg._configYaml else null;
      hasAgent = hm.config.launchd.agents ? lima-linux-builder;
      agent = hm.config.launchd.agents.lima-linux-builder or null;
      packages = map (p: p.name or "") hm.config.home.packages;
      # The internal supervisor/deploy options are only defined while the
      # adapter is enabled, so guard on enable rather than probing them.
      supervisorText =
        if cfg.enable then
          builtins.readFile (cfg._supervisor + "/bin/lima-linux-builder-supervisor")
        else
          null;
      deployText =
        if cfg.enable then
          builtins.readFile (cfg._deploy + "/bin/linux-builder-deploy")
        else
          null;
    }
  `;
}

function personalHostExpr(extraModule = null) {
  const host = extraModule
    ? `flake.darwinConfigurations.${JSON.stringify(personalHostName)}.extendModules { modules = [ (${extraModule}) ]; }`
    : `flake.darwinConfigurations.${JSON.stringify(personalHostName)}`;
  return `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      hm = (${host}).config.home-manager.users.${personalHostUser};
    in
    {
      builder = {
        enable = hm.virtualisation.limaLinuxBuilder.enable;
        name = hm.virtualisation.limaLinuxBuilder.name;
        hostname = hm.virtualisation.limaLinuxBuilder.hostname;
        guestSystem = hm.virtualisation.limaLinuxBuilder.guestSystem;
        cpus = hm.virtualisation.limaLinuxBuilder.cpus;
        memory = hm.virtualisation.limaLinuxBuilder.memory;
        disk = hm.virtualisation.limaLinuxBuilder.disk;
        hasSupervisor = hm.virtualisation.limaLinuxBuilder._supervisor != null;
        hasDeploy = hm.virtualisation.limaLinuxBuilder._deploy != null;
      };
      builderAgent = hm.launchd.agents.lima-linux-builder or null;
      fabro = {
        enable = hm.virtualisation.limaVM.enable;
        name = hm.virtualisation.limaVM.name;
        hostname = hm.virtualisation.limaVM.hostname;
        guestSystem = hm.virtualisation.limaVM.guestSystem;
        cpus = hm.virtualisation.limaVM.cpus;
        memory = hm.virtualisation.limaVM.memory;
        disk = hm.virtualisation.limaVM.disk;
        mounts = hm.virtualisation.limaVM.mounts;
        hasSupervisor = hm.virtualisation.limaVM._supervisor != null;
        hasDeploy = hm.virtualisation.limaVM._deploy != null;
      };
      fabroAgent = hm.launchd.agents.lima-fabro or null;
    }
  `;
}

function assertBuilderInstanceIdentity(builder) {
  assert.equal(builder.enable, true, 'the builder Lima adapter must be enabled');
  assert.equal(builder.name, builderInstanceName, 'the builder Lima instance must be named linux-builder');
  assert.equal(builder.hostname, builderInstanceName, 'the builder guest hostname must be linux-builder');
  assert.equal(
    builder.guestSystem,
    builderInstanceName,
    'the builder deploy wrapper must target the linux-builder flake output',
  );
}

function assertBuilderResources(builder) {
  assert.equal(builder.cpus, 4, 'the Linux builder VM must render 4 CPUs (Requirement 2.1)');
  assert.equal(builder.memory, '8GiB', 'the Linux builder VM must render 8GiB of memory (Requirement 2.2)');
  assert.equal(builder.disk, '128GiB', 'the Linux builder VM must render 128GiB of disk (Requirement 2.3)');
}

function assertLaunchdLifecycle(agent, expectedAgentName, expectedSupervisor) {
  assert.ok(agent, `expected a launchd agent named ${expectedAgentName}`);
  assert.equal(agent.enable, true, `${expectedAgentName} must be enabled`);
  assert.equal(agent.config.Label, `dev.dwsr.${expectedAgentName}`);
  assert.match(
    agent.config.ProgramArguments[0],
    new RegExp(`${expectedSupervisor}$`),
    `${expectedAgentName} must run its supervisor`,
  );
  assert.equal(agent.config.RunAtLoad, true, `${expectedAgentName} must start the VM at load`);
  assert.equal(
    agent.config.KeepAlive.SuccessfulExit,
    false,
    `${expectedAgentName} must restart unexpected exits but honor a clean stop`,
  );
  assert.equal(agent.config.ProcessType, 'Background');
}

function assertBuilderLimaYaml(yaml) {
  assert.ok(yaml, 'expected the builder adapter to render a Lima configuration');
  assert.ok(yaml.includes(builderNixosImage), 'builder Lima YAML must use the pinned nixos-lima aarch64 release image');
  assert.ok(yaml.includes(builderImageDigest), 'builder Lima YAML must pin the release image digest');
  assert.match(yaml, /vmType: ?['"]?vz['"]?/);
  assert.match(yaml, /arch: ?['"]?aarch64['"]?/);
  assert.match(yaml, /cpus: ?['"]?4\b/);
  assert.match(yaml, /memory: ?['"]?8GiB['"]?/);
  assert.match(yaml, /disk: ?['"]?128GiB['"]?/);
  assert.match(yaml, /mounts: ?\[\]/);
  assert.match(yaml, /echo ['"]?linux-builder['"]? ?>>?\/proc\/sys\/kernel\/hostname/);
  // The builder instance must not inherit the Fabro guest's writable state
  // share or any other Fabro-specific render.
  assert.doesNotMatch(yaml, /\/var\/lib\/fabro|~\/\.local\/state\/fabro/);
}

function assertBuilderSupervisor(wrapper) {
  assert.ok(wrapper, 'expected the builder adapter to render a launchd supervisor');
  assert.match(wrapper, /export LIMA_HOME=['"]?\/Users\/builder-test\/\.local\/state\/lima['"]?/);
  assert.match(wrapper, /if ! limactl list --json "\$name" >\/dev\/null 2>&1; then/);
  assert.match(wrapper, /limactl --tty=false create --name="\$name" "\$config"/);
  assert.match(wrapper, /exec limactl --tty=false start --foreground "\$name"/);
}

function assertBuilderDeploy(rendered) {
  assert.ok(
    rendered.packages.includes('linux-builder-deploy'),
    `expected linux-builder-deploy in home.packages, got: ${JSON.stringify(rendered.packages)}`,
  );

  const deploy = rendered.deployText;
  assert.ok(deploy, 'expected the builder adapter to render a deploy command');
  assert.ok(deploy.includes('usage: linux-builder-deploy [REPO]'));
  assert.ok(deploy.includes('[ ! -f "$repo/flake.nix" ] || [ ! -f "$repo/flake.lock" ]'));
  assert.ok(deploy.includes('sshConfig="$LIMA_HOME/$name/ssh.config"'));
  assert.ok(deploy.includes('ssh -F "$sshConfig" "$remoteHost" "$@"'));
  assert.ok(!deploy.includes('git clone'), 'the deploy wrapper must stream the tree instead of cloning in the guest');
  assert.ok(!deploy.includes('remote -- '));
  assert.ok(deploy.includes('tar --exclude=.git'));
  assert.ok(deploy.includes('-cf - -C "$repo" .'));
  assert.ok(deploy.includes('system=linux-builder\n'));
  assert.ok(
    deploy.includes("nixos-rebuild switch --sudo --no-update-lock-file --flake '$scratch#$system'"),
  );
}

function assertFabroGuestPreserved(fabro) {
  assert.equal(fabro.enable, true, 'the existing Fabro Lima guest must stay enabled');
  assert.equal(fabro.name, 'fabro', 'the Fabro Lima instance must keep its identity');
  assert.equal(fabro.hostname, 'fabro', 'the Fabro guest hostname must stay fabro');
  assert.equal(fabro.guestSystem, 'fabro-vm', 'the Fabro deploy target must stay fabro-vm');
  assert.equal(fabro.cpus, 8, 'the Fabro guest CPU allocation must not change');
  assert.equal(fabro.memory, '12GiB', 'the Fabro guest memory allocation must not change');
  assert.equal(fabro.disk, '128GiB', 'the Fabro guest disk allocation must not change');
  assert.deepEqual(fabro.mounts, expectedFabroMounts, 'the Fabro guest state mount must not change');
  assert.equal(fabro.hasSupervisor, true, 'the Fabro guest supervisor must stay wired');
  assert.equal(fabro.hasDeploy, true, 'the Fabro deploy command must stay wired');
}

test('builder adapter renders a distinct native NixOS Lima instance', () => {
  const rendered = nixEvalJson(builderAdapterExpr());

  assertBuilderInstanceIdentity(rendered);
  assertBuilderLimaYaml(rendered.configYaml);
});

test('builder adapter renders the 4 CPU / 8GiB / 128GiB allocation', () => {
  const rendered = nixEvalJson(builderAdapterExpr());

  assertBuilderResources(rendered);
  // The YAML carries the allocation into the actual VM definition.
  assert.match(rendered.configYaml, /cpus: ?['"]?4\b/);
  assert.match(rendered.configYaml, /memory: ?['"]?8GiB['"]?/);
  assert.match(rendered.configYaml, /disk: ?['"]?128GiB['"]?/);
});

test('builder adapter registers its own launchd lifecycle', () => {
  const rendered = nixEvalJson(builderAdapterExpr());

  assertLaunchdLifecycle(rendered.agent, 'lima-linux-builder', 'lima-linux-builder-supervisor');
  assert.equal(rendered.agent.config.EnvironmentVariables.LIMA_HOME, '/Users/builder-test/.local/state/lima');
  assert.equal(rendered.agent.config.EnvironmentVariables.HOME, '/Users/builder-test');
  assert.equal(
    rendered.agent.config.StandardOutPath,
    '/Users/builder-test/Library/Logs/lima-vm/lima-linux-builder.log',
  );
  assert.equal(
    rendered.agent.config.StandardErrorPath,
    '/Users/builder-test/Library/Logs/lima-vm/lima-linux-builder.error.log',
  );
  assertBuilderSupervisor(rendered.supervisorText);
});

test('builder adapter exposes its dedicated deploy command', () => {
  const rendered = nixEvalJson(builderAdapterExpr());

  assertBuilderDeploy(rendered);
});

test('disabled builder adapter registers no lifecycle or host artifact', () => {
  const rendered = nixEvalJson(builderAdapterExpr('{ ... }: { }'));

  assert.equal(rendered.enable, false);
  assert.equal(rendered.hasAgent, false);
  assert.equal(rendered.agent, null);
  assert.equal(rendered.configYaml, null);
  assert.equal(rendered.supervisorText, null);
  assert.equal(rendered.deployText, null);
  assert.ok(!rendered.packages.includes('linux-builder-deploy'));
});

test('builder instance identity cannot drift to the Fabro guest', () => {
  const failure = nixEvalFailure(builderAdapterExpr(`{ ... }: {
    virtualisation.limaLinuxBuilder.enable = true;
    virtualisation.limaLinuxBuilder.guestSystem = "fabro-vm";
  }`));

  assert.match(failure, /virtualisation\.limaLinuxBuilder\.guestSystem must be linux-builder/);
});

test(
  'personal host renders the Linux builder alongside the unchanged Fabro guest',
  { timeout: 600_000 },
  () => {
    const rendered = nixEvalJson(personalHostExpr(), { timeout: 600_000 });

    assertBuilderInstanceIdentity(rendered.builder);
    assertBuilderResources(rendered.builder);
    assert.equal(rendered.builder.hasSupervisor, true, 'the personal host must wire the builder supervisor');
    assert.equal(rendered.builder.hasDeploy, true, 'the personal host must wire the builder deploy command');
    assertLaunchdLifecycle(rendered.builderAgent, 'lima-linux-builder', 'lima-linux-builder-supervisor');

    assertFabroGuestPreserved(rendered.fabro);
    assertLaunchdLifecycle(rendered.fabroAgent, 'lima-fabro', 'lima-fabro-supervisor');

    // The two guests must stay independent, not overwrite each other.
    assert.notEqual(rendered.builder.name, rendered.fabro.name);
    assert.notEqual(
      rendered.builderAgent.config.Label,
      rendered.fabroAgent.config.Label,
      'builder and Fabro launchd agents must be distinct',
    );
  },
);

test('a changed Linux builder resource is rejected', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    personalHostExpr(`{ lib, ... }: {
      home-manager.users.${personalHostUser}.virtualisation.limaLinuxBuilder.cpus = lib.mkForce 2;
      home-manager.users.${personalHostUser}.virtualisation.limaLinuxBuilder.memory = lib.mkForce "4GiB";
      home-manager.users.${personalHostUser}.virtualisation.limaLinuxBuilder.disk = lib.mkForce "64GiB";
    }`),
    { timeout: 600_000 },
  );

  // The fixture must really perturb the rendered resources.
  assert.equal(rendered.builder.cpus, 2);
  assert.equal(rendered.builder.memory, '4GiB');
  assert.equal(rendered.builder.disk, '64GiB');

  assert.throws(() => assertBuilderResources(rendered.builder), /Requirement 2\.1/);
});

test('missing builder lifecycle wiring is rejected', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    personalHostExpr(`{ lib, ... }: {
      home-manager.users.${personalHostUser}.launchd.agents.lima-linux-builder.enable = lib.mkForce false;
    }`),
    { timeout: 600_000 },
  );

  assert.equal(rendered.builderAgent.enable, false);

  assert.throws(
    () => assertLaunchdLifecycle(rendered.builderAgent, 'lima-linux-builder', 'lima-linux-builder-supervisor'),
    /must be enabled/,
  );
});

test('an altered Fabro guest render is rejected', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    personalHostExpr(`{ lib, ... }: {
      home-manager.users.${personalHostUser}.virtualisation.limaVM.cpus = lib.mkForce 2;
    }`),
    { timeout: 600_000 },
  );

  assert.equal(rendered.fabro.cpus, 2);
  assert.throws(() => assertFabroGuestPreserved(rendered.fabro), /Fabro guest CPU allocation/);
});
