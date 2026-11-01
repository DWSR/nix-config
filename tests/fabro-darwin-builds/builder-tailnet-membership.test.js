'use strict';

// Evaluation tests for `configurations/mac-builder/tailscale.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 2.2; design "Component
// Contracts → Builder Host → Builder Tailnet Membership"; requirements 3.5,
// 3.7, 3.8, 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.12, 4.13, 4.14, 6.5).
//
// The module is evaluated beside `configurations/mac-builder` in a standalone
// nix-darwin system, so the assertions cover the host's effective boot daemons
// and secret declaration whether or not `configurations/mac-builder/default.nix`
// imports the module yet (task 2.3 adds the import).

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const hostModule = path.join(repoRoot, 'configurations/mac-builder');
const tailscaleModule = path.join(repoRoot, 'configurations/mac-builder/tailscale.nix');
const NIX_TIMEOUT_MS = 600_000;

const authDaemon = 'mac-builder-tailscale-auth';
const secretName = 'builder-tailscale-oauth-secret';

const SELECTION = `{
  hostPlatform = config.nixpkgs.hostPlatform.system;
  launchdDaemons = builtins.attrNames config.launchd.daemons;
  tailscaled =
    if config.launchd.daemons ? tailscaled then
      {
        command = config.launchd.daemons.tailscaled.command;
        serviceConfig = config.launchd.daemons.tailscaled.serviceConfig;
      }
    else
      null;
  auth =
    if config.launchd.daemons ? ${authDaemon} then
      {
        serviceConfig = config.launchd.daemons.${authDaemon}.serviceConfig;
      }
    else
      null;
  tailscale = {
    enable = config.services.tailscale.enable;
    optionNames = builtins.attrNames config.services.tailscale;
    packageName = config.services.tailscale.package.pname;
    packagePath = toString config.services.tailscale.package;
    client = "\${toString config.services.tailscale.package}/bin/tailscale";
    inSystemPackages = builtins.elem config.services.tailscale.package config.environment.systemPackages;
  };
  sopsSecretNames = builtins.attrNames config.sops.secrets;
  sopsSecret =
    if config.sops.secrets ? ${secretName} then
      {
        path = config.sops.secrets.${secretName}.path;
        mode = config.sops.secrets.${secretName}.mode;
        owner = config.sops.secrets.${secretName}.owner;
        group = config.sops.secrets.${secretName}.group;
        sopsFile = toString config.sops.secrets.${secretName}.sopsFile;
      }
    else
      null;
  defaultSopsFile = toString config.sops.defaultSopsFile;
  hasHomeManager = config ? home-manager;
  trustedUsers = config.nix.settings.trusted-users;
}`;

let cachedReport = null;

function evalHost() {
  if (cachedReport) return cachedReport;
  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  darwin = flake.inputs.darwin.lib;
  config = (darwin.darwinSystem {
    specialArgs = { inputs = flake.inputs; outputs = flake; username = "nix-builder"; };
    modules = [ ${hostModule} ${tailscaleModule} ];
  }).config;
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

test('the host joins the tailnet with the open-source client only', () => {
  const report = evalHost();

  assert.equal(report.hostPlatform, 'aarch64-darwin');
  assert.equal(report.tailscale.enable, true);
  assert.equal(
    report.tailscale.packageName,
    'tailscale',
    `the builder must use the open-source client, got: ${report.tailscale.packageName}`,
  );
  assert.match(report.tailscale.packagePath, /^\/nix\/store\//);
  assert.equal(report.tailscale.inSystemPackages, true, 'tailscale must be installed on the host');
  assert.ok(
    !/tailscale.*\.app/i.test(report.tailscale.packagePath),
    'the macOS application must not be used',
  );
});

test('tailscaled is declared as the com.tailscale.tailscaled LaunchDaemon', () => {
  const report = evalHost();

  assert.ok(report.launchdDaemons.includes('tailscaled'), `daemons: ${report.launchdDaemons}`);
  assert.equal(report.tailscaled.serviceConfig.Label, 'com.tailscale.tailscaled');
  assert.equal(report.tailscaled.serviceConfig.RunAtLoad, true);
  assert.match(report.tailscaled.command, /tailscaled$/);
});

test('the auth daemon runs the wrapper with the credential path, hostname, and tag', () => {
  const report = evalHost();

  assert.ok(report.auth, 'launchd.daemons.mac-builder-tailscale-auth must be declared');
  const words = execWords(report.auth.serviceConfig.ProgramArguments);

  assert.match(words[0], /mac-builder-tailscale-auth$/, `first word: ${words[0]}`);

  const flagValue = (flag) => {
    const index = words.indexOf(flag);
    assert.notEqual(index, -1, `missing ${flag} in ${JSON.stringify(words)}`);
    return words[index + 1];
  };

  assert.equal(flagValue('--auth-key-file'), '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(flagValue('--hostname'), 'mac-builder');
  assert.equal(flagValue('--tag'), 'tag:mac-builder');
  assert.equal(
    flagValue('--tailscale'),
    report.tailscale.client,
    'the auth daemon must use the client declared by services.tailscale',
  );

  // The wrapper owns the `tailscale up` OAuth parameters, so launchd passes the
  // credential by path only.
  assert.ok(
    !words.some((word) => word.includes('?ephemeral=')),
    'the OAuth parameters belong to the wrapper, not the launchd arguments',
  );
});

test('the auth daemon keeps running under launchd with background logs', () => {
  const report = evalHost();
  const { serviceConfig } = report.auth;

  assert.equal(serviceConfig.RunAtLoad, true);
  assert.equal(serviceConfig.KeepAlive, true);
  assert.equal(serviceConfig.ThrottleInterval, 30);
  assert.equal(serviceConfig.ProcessType, 'Background');
  assert.match(serviceConfig.StandardOutPath, /^\/var\/log\//);
  assert.match(serviceConfig.StandardErrorPath, /^\/var\/log\//);
});

test('the OAuth credential is declared root-only from the builder store', () => {
  const report = evalHost();

  assert.ok(report.sopsSecret, `expected sops.secrets.${secretName}`);
  assert.equal(report.sopsSecret.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(report.sopsSecret.mode, '0400');
  assert.equal(report.sopsSecret.owner, 'root');
  assert.equal(report.sopsSecret.group, 'wheel');
  assert.match(report.sopsSecret.sopsFile, /remote-builder\.mac-builder\.yaml$/);
  assert.match(report.defaultSopsFile, /remote-builder\.mac-builder\.yaml$/);
  assert.ok(
    !/fabro\.fabro\.yaml$/.test(report.sopsSecret.sopsFile),
    'the builder must not read the guest store',
  );
});

test('no other tailnet credential is declared', () => {
  const report = evalHost();

  assert.deepEqual(
    [...report.sopsSecretNames].sort(),
    ['builder-authorized-keys', secretName].sort(),
    `unexpected sops secrets: ${JSON.stringify(report.sopsSecretNames)}`,
  );
});

test('no auth-key option, no Tailscale SSH, and no serve subcommand', () => {
  const report = evalHost();

  const credentialOptions = report.tailscale.optionNames.filter((name) =>
    /auth[-_]?key/i.test(name),
  );
  assert.deepEqual(
    credentialOptions,
    [],
    `services.tailscale must not gain an auth-key option: ${JSON.stringify(credentialOptions)}`,
  );

  const commands = [report.auth.serviceConfig.ProgramArguments.join(' '), report.tailscaled.command];
  for (const command of commands) {
    assert.ok(!/--ssh\b/.test(command), `Tailscale SSH must stay disabled: ${command}`);
    assert.ok(!/\bserve\b/.test(command), `tailscale serve must not be declared: ${command}`);
  }

  const words = execWords(report.auth.serviceConfig.ProgramArguments);
  assert.ok(
    !words.some((word) => /^--auth-key=/.test(word)),
    'the credential must be read from the root-only file, never passed inline',
  );
});

test('the builder stays a nix-darwin host without Home Manager', () => {
  const report = evalHost();

  assert.equal(report.hasHomeManager, false, 'the builder must not import Home Manager');
  assert.ok(
    report.trustedUsers.includes('nix-builder'),
    `nix-builder must stay a trusted user: ${JSON.stringify(report.trustedUsers)}`,
  );
  assert.deepEqual(
    report.trustedUsers.filter((user) => user !== 'root'),
    ['nix-builder'],
    `nix-builder must be the only non-root trusted user: ${JSON.stringify(report.trustedUsers)}`,
  );
});

test('the module source carries no personal-host or app wiring', () => {
  const source = fs.readFileSync(tailscaleModule, 'utf8');

  assert.doesNotMatch(source, /Brandons-MacBook-Pro|personal\//i, 'must not join through the personal host');
  assert.doesNotMatch(source, /home-manager/i, 'must not import Home Manager');
  assert.doesNotMatch(source, /tailscale-systray|\.app\b/i, 'must not use the macOS application');
});
