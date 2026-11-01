'use strict';

// Evaluation tests for the `mac-builder` host wiring
// (mac-builder-for-fabro-nix-darwin-builds, task 2.3; design "Builder Host →
// Builder Tailnet Membership" and "Modified Files"; requirements 4.12, 5.1,
// 5.2, 5.5, 5.6, 5.7).
//
// Unlike `builder-tailnet-membership.test.js`, which evaluates
// `configurations/mac-builder/tailscale.nix` beside the host module, these
// assertions read the real `darwinConfigurations.mac-builder` evaluated by
// `flake.nix`. They therefore prove the module is imported by
// `configurations/mac-builder/default.nix` and that the import leaves the stock
// remote-builder endpoint, the builder user, sshd, GC/optimise, the
// authorized-key activation, and the LAN-forward scripts untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;

const authDaemon = 'mac-builder-tailscale-auth';

const SELECTION = `{
  hostPlatform = config.nixpkgs.hostPlatform.system;
  daemons = builtins.attrNames config.launchd.daemons;
  nixDaemon =
    if config.launchd.daemons ? nix-daemon then
      config.launchd.daemons.nix-daemon.serviceConfig
    else
      null;
  sopsDaemon =
    if config.launchd.daemons ? sops-install-secrets then
      {
        label = config.launchd.daemons.sops-install-secrets.serviceConfig.Label;
        runAtLoad = config.launchd.daemons.sops-install-secrets.serviceConfig.RunAtLoad;
      }
    else
      null;
  auth =
    if config.launchd.daemons ? ${authDaemon} then
      {
        command = config.launchd.daemons.${authDaemon}.command;
        serviceConfig = config.launchd.daemons.${authDaemon}.serviceConfig;
      }
    else
      null;
  tailscaled = config.launchd.daemons ? tailscaled;
  tailscale = {
    enable = config.services.tailscale.enable;
    packageName = config.services.tailscale.package.pname;
    client = "\${toString config.services.tailscale.package}/bin/tailscale";
    inSystemPackages = builtins.elem config.services.tailscale.package config.environment.systemPackages;
  };
  sopsSecretNames = builtins.attrNames config.sops.secrets;
  sopsSecret =
    if config.sops.secrets ? "builder-tailscale-oauth-secret" then
      {
        path = config.sops.secrets."builder-tailscale-oauth-secret".path;
        mode = config.sops.secrets."builder-tailscale-oauth-secret".mode;
        owner = config.sops.secrets."builder-tailscale-oauth-secret".owner;
        group = config.sops.secrets."builder-tailscale-oauth-secret".group;
      }
    else
      null;
  nix = {
    distributedBuilds = config.nix.distributedBuilds;
    settings = config.nix.settings;
    hasExtraPlatforms = config.nix.settings ? extra-platforms;
    gcAutomatic = config.nix.gc.automatic;
    gcInterval = config.nix.gc.interval;
    gcOptions = config.nix.gc.options;
    optimiseAutomatic = config.nix.optimise.automatic;
  };
  openssh = {
    enable = config.services.openssh.enable;
    extraConfig = config.services.openssh.extraConfig;
  };
  user = {
    uid = config.users.users.nix-builder.uid;
    gid = config.users.users.nix-builder.gid;
    home = config.users.users.nix-builder.home;
    shell = config.users.users.nix-builder.shell;
    isHidden = config.users.users.nix-builder.isHidden;
    extraGroups = config.users.users.nix-builder.extraGroups or [ ];
  };
  postActivation = config.system.activationScripts.postActivation.text;
}`;

let cachedReport = null;

function evalHost() {
  if (cachedReport) return cachedReport;
  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  config = flake.darwinConfigurations.mac-builder.config;
in ${SELECTION}
`;
  cachedReport = JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
  return cachedReport;
}

// Splits a launchd command into words, tolerating the quoting `escapeShellArgs`
// adds.
function commandWords(command) {
  assert.equal(typeof command, 'string', 'the auth daemon must set a command string');
  return command
    .match(/'[^']*'|"[^"]*"|\S+/g)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));
}

// `launchd.daemons.<name>.command` is wrapped by the nix-darwin module as
// `/bin/wait4path /nix/store && exec <command>`; the words after `exec` are the
// arguments launchd really runs.
function execWords(programArguments) {
  assert.equal(programArguments[0], '/bin/sh');
  assert.equal(programArguments[1], '-c');
  const script = programArguments[2];
  const execIndex = script.indexOf('exec ');
  assert.notEqual(execIndex, -1, `expected an exec wrapper, got: ${script}`);
  return commandWords(script.slice(execIndex + 'exec '.length));
}

test('the mac-builder host imports the tailnet membership module', () => {
  const report = evalHost();

  assert.equal(report.hostPlatform, 'aarch64-darwin');
  assert.equal(
    report.tailscale.enable,
    true,
    'configurations/mac-builder/default.nix must import ./tailscale.nix',
  );
  assert.equal(report.tailscale.packageName, 'tailscale');
  assert.equal(report.tailscale.inSystemPackages, true);
  assert.equal(report.tailscaled, true, `daemons: ${JSON.stringify(report.daemons)}`);

  assert.ok(
    report.daemons.includes(authDaemon),
    `the imported module must declare ${authDaemon}; daemons: ${JSON.stringify(report.daemons)}`,
  );
  const words = execWords(report.auth.serviceConfig.ProgramArguments);
  assert.match(words[0], /mac-builder-tailscale-auth$/);

  const flagValue = (flag) => {
    const index = words.indexOf(flag);
    assert.notEqual(index, -1, `missing ${flag} in ${JSON.stringify(words)}`);
    return words[index + 1];
  };
  assert.equal(flagValue('--auth-key-file'), '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(flagValue('--hostname'), 'mac-builder');
  assert.equal(flagValue('--tag'), 'tag:mac-builder');

  assert.ok(
    report.sopsSecretNames.includes('builder-tailscale-oauth-secret'),
    `expected the OAuth credential secret, got: ${JSON.stringify(report.sopsSecretNames)}`,
  );
  assert.equal(report.sopsSecret.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(report.sopsSecret.mode, '0400');
  assert.equal(report.sopsSecret.owner, 'root');
  assert.equal(report.sopsSecret.group, 'wheel');
});

test('the stock Nix remote-builder endpoint is preserved', () => {
  const report = evalHost();

  // The endpoint stays Nix's own sshd plus daemon path: nix-daemon is still a
  // launchd daemon that starts without an interactive login, and no custom
  // build API, queue, or scheduler joins it.
  assert.ok(report.nixDaemon, 'launchd.daemons.nix-daemon must survive the import');
  assert.equal(report.nixDaemon.KeepAlive, true);
  assert.notEqual(report.nixDaemon.RunAtLoad, false);

  assert.deepStrictEqual(
    [...report.daemons].sort(),
    [
      'activate-system',
      authDaemon,
      'nix-daemon',
      'nix-gc',
      'nix-optimise',
      'sops-install-secrets',
      'tailscaled',
    ].sort(),
    'the import must add the tailnet daemons only, no extra build service',
  );

  assert.equal(report.nix.distributedBuilds, false, 'the builder must not dispatch builds elsewhere');
  assert.equal(report.nix.settings.builders, null, 'the builder must not declare remote builders');
});

test('the host stays Darwin only with no extra platforms', () => {
  const report = evalHost();

  assert.equal(report.hostPlatform, 'aarch64-darwin');
  assert.equal(
    report.nix.hasExtraPlatforms,
    false,
    `extra-platforms must stay unset, got: ${JSON.stringify(report.nix.settings['extra-platforms'])}`,
  );
});

test('root SSH login stays disabled and the builder user is unchanged', () => {
  const report = evalHost();

  assert.equal(report.openssh.enable, true);
  assert.match(report.openssh.extraConfig, /PermitRootLogin no/);
  assert.match(report.openssh.extraConfig, /PasswordAuthentication no/);
  assert.match(report.openssh.extraConfig, /KbdInteractiveAuthentication no/);

  assert.ok(report.nix.settings['trusted-users'].includes('nix-builder'));

  assert.equal(report.user.uid, 502);
  assert.equal(report.user.gid, 20);
  assert.equal(report.user.home, '/Users/nix-builder');
  assert.equal(report.user.shell, '/bin/zsh');
  assert.equal(report.user.isHidden, true);
  assert.ok(
    !report.user.extraGroups.includes('admin'),
    `nix-builder must stay non-admin, got: ${JSON.stringify(report.user.extraGroups)}`,
  );
});

test('the sops darwin activation is undisturbed', () => {
  const report = evalHost();

  assert.ok(report.sopsDaemon, 'sops-install-secrets must stay a launchd daemon');
  assert.equal(report.sopsDaemon.label, 'org.nixos.sops-install-secrets');
  assert.equal(report.sopsDaemon.runAtLoad, true);
});

test('GC, optimise, and the authorized-key activation are unchanged', () => {
  const report = evalHost();

  assert.equal(report.nix.gcAutomatic, true);
  assert.equal(report.nix.gcInterval.Weekday, 0);
  assert.equal(report.nix.gcInterval.Hour, 3);
  assert.equal(report.nix.gcInterval.Minute, 15);
  assert.equal(report.nix.gcOptions, '--delete-older-than 7d');
  assert.equal(report.nix.optimiseAutomatic, true);

  assert.match(report.postActivation, /builder-authorized-keys/);
  assert.match(report.postActivation, /\/Users\/nix-builder\/\.ssh/);
  assert.match(report.postActivation, /install -m 0600 -o nix-builder -g staff/);
});

test('the LAN-forward deploy and readiness scripts still evaluate unchanged', () => {
  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  system = builtins.currentSystem;
  pkgs = import flake.inputs.nixpkgs {
    inherit system;
    config.allowUnfree = true;
    overlays = [
      flake.outputs.overlays.unstable-packages
      flake.outputs.overlays.custom-packages
    ];
  };
in
{
  apps = builtins.attrNames flake.apps.\${system};
  deploy = flake.apps.\${system}.mac-builder-deploy.program;
  readiness = flake.apps.\${system}.mac-builder-readiness.program;
  deployDirect = "\${pkgs.callPackage ${repoRoot}/scripts/mac-builder-deploy.nix { }}/bin/mac-builder-deploy";
  readinessDirect = "\${pkgs.callPackage ${repoRoot}/scripts/mac-builder-readiness.nix { }}/bin/mac-builder-readiness";
}`;

  const report = JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));

  assert.ok(report.apps.includes('mac-builder-deploy'));
  assert.ok(report.apps.includes('mac-builder-readiness'));

  assert.match(report.deploy, /^\/nix\/store\/.+mac-builder-deploy\/bin\/mac-builder-deploy$/);
  assert.match(
    report.readiness,
    /^\/nix\/store\/.+mac-builder-readiness\/bin\/mac-builder-readiness$/,
  );

  assert.equal(
    report.deploy,
    report.deployDirect,
    'the host import must not reshape the LAN-forward deploy script',
  );
  assert.equal(
    report.readiness,
    report.readinessDirect,
    'the host import must not reshape the LAN-forward readiness script',
  );
});
