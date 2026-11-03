'use strict';

// Evaluation tests for the guest side of Darwin dispatch
// (mac-builder-for-fabro-nix-darwin-builds, task 5.2; design "Component
// Contracts → Guest Dispatch" and "Testing Strategy → Render and
// evaluation"; requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4,
// 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 8.1, 8.4).
//
// Every case evaluates `nixosConfigurations.fabro-vm` (the real guest, not a
// standalone module), so the assertions cover what the guest ships: the
// `fabro.darwinBuilder` option values, the daemon's machines-file wiring, the
// renderer unit and its ordering, the tmpfiles fallback, both build-session
// secrets, and the unchanged one-Nix sandbox invariants. No assertion reads a
// secret value; only the declared runtime paths appear here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

const NIX_TIMEOUT_MS = 600_000;

// The design's option contract and Data Models table.
const EXPECTED_MACHINE = {
  hostName: 'mac-builder.tuxedo-musical.ts.net',
  sshUser: 'nix-builder',
  system: 'aarch64-darwin',
  maxJobs: 4,
  speedFactor: 2,
};
const EXPECTED_MACHINES_FILE = '/run/fabro-darwin-builders/machines';
const EXPECTED_CLIENT_KEY_PATH = '/run/secrets/build-client-key';
const EXPECTED_HOST_KEY_PATH = '/run/secrets/build-host-key';
const BUILD_SECRETS = {
  'build-client-key': EXPECTED_CLIENT_KEY_PATH,
  'build-host-key': EXPECTED_HOST_KEY_PATH,
};

// Requirements 2.1-2.4: the sandbox sees the guest store and daemon socket and
// gets a writable /tmp, and nothing else. The exact list is the contract; any
// extra bind mount would be a per-container store, daemon, or credential.
const EXPECTED_CONTAINER_MOUNTS = [
  'type=bind,source=/nix/store,destination=/nix/store,ro',
  'type=bind,source=/nix/var/nix/daemon-socket,destination=/nix/var/nix/daemon-socket',
  'type=tmpfs,destination=/tmp',
];

const GUEST_EXPR = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  cfg = flake.nixosConfigurations."fabro-vm".config;
  rendererUnit = cfg.systemd.services."fabro-darwin-builders";
  daemonUnit = cfg.systemd.services."nix-daemon";
  secret = name:
    {
      inherit (cfg.sops.secrets.\${name}) path mode owner group;
    };
in
{
  dispatch = {
    inherit (cfg.fabro.darwinBuilder) enable machine clientKeyPath hostKeyPath machinesFile;
  };
  distributedBuilds = cfg.nix.distributedBuilds;
  builders = cfg.nix.settings.builders or null;
  buildersUseSubstitutes = cfg.nix.settings.builders-use-substitutes or null;
  buildMachines = cfg.nix.buildMachines;
  hasEtcMachines = cfg.environment.etc ? "nix/machines";
  renderer = {
    type = rendererUnit.serviceConfig.Type or null;
    runtimeDirectory = rendererUnit.serviceConfig.RuntimeDirectory or null;
    execStart = rendererUnit.serviceConfig.ExecStart or null;
    wants = rendererUnit.wants;
    after = rendererUnit.after;
    before = rendererUnit.before;
    requires = rendererUnit.requires;
  };
  nixDaemon = {
    wants = daemonUnit.wants;
    after = daemonUnit.after;
    requires = daemonUnit.requires;
    hasExecStart = daemonUnit.serviceConfig ? ExecStart;
    hasScript = daemonUnit.serviceConfig ? Script;
  };
  tmpfilesRules = cfg.systemd.tmpfiles.rules;
  secrets = builtins.listToAttrs (map (name: {
    inherit name;
    value = secret name;
  }) [ "build-client-key" "build-host-key" ]);
  sandbox = {
    mounts = cfg.virtualisation.containers.containersConf.settings.containers.mounts;
    containersConf = builtins.toJSON cfg.virtualisation.containers.containersConf.settings;
    imageEnv = cfg.fabro.sandboxImage.imageConfig.Env;
    imageConfig = builtins.toJSON cfg.fabro.sandboxImage.imageConfig;
  };
}
`;

let cachedReport = null;

function guestReport() {
  if (cachedReport) return cachedReport;
  cachedReport = nixEvalJson(GUEST_EXPR, { timeout: NIX_TIMEOUT_MS });
  return cachedReport;
}

// Splits a systemd ExecStart into words, tolerating the quoting
// `escapeShellArgs` adds for unusual characters.
function execStartWords(execStart) {
  assert.equal(typeof execStart, 'string', 'the renderer unit must set a string ExecStart');
  return execStart
    .match(/'[^']*'|"[^"]*"|\S+/g)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));
}

test('the guest enables Darwin dispatch with the design option values', () => {
  const { dispatch } = guestReport();

  assert.equal(dispatch.enable, true, 'fabro.darwinBuilder.enable must be on for the guest');
  assert.deepEqual(dispatch.machine, EXPECTED_MACHINE);
  assert.equal(dispatch.clientKeyPath, EXPECTED_CLIENT_KEY_PATH);
  assert.equal(dispatch.hostKeyPath, EXPECTED_HOST_KEY_PATH);
  assert.equal(dispatch.machinesFile, EXPECTED_MACHINES_FILE);
});

test('the daemon dispatches from the runtime builders file with substitution', () => {
  const report = guestReport();

  assert.equal(report.distributedBuilds, true);
  assert.equal(
    report.builders,
    `@${EXPECTED_MACHINES_FILE}`,
    'the daemon must read the rendered machines file through the @ form',
  );
  assert.equal(report.buildersUseSubstitutes, true);

  assert.ok(
    !EXPECTED_MACHINES_FILE.startsWith('/nix/store'),
    'the machines file must live outside the Nix store',
  );
  assert.ok(
    !EXPECTED_MACHINES_FILE.startsWith('/etc'),
    'the machines file must live outside /etc',
  );
  assert.deepEqual(report.buildMachines, [], 'eval must not generate a nix.buildMachines entry');
  assert.equal(report.hasEtcMachines, false, 'eval must not render /etc/nix/machines');
});

test('the renderer unit runs the machine renderer and is ordered around secrets and the daemon', () => {
  const { renderer } = guestReport();

  assert.equal(renderer.type, 'oneshot');
  assert.equal(renderer.runtimeDirectory, 'fabro-darwin-builders');

  assert.ok(
    renderer.wants.includes('sops-install-secrets.service'),
    'the renderer must want sops-install-secrets',
  );
  assert.ok(
    renderer.after.includes('sops-install-secrets.service'),
    'the renderer must run after the secrets are materialized',
  );
  assert.ok(
    !renderer.requires.includes('sops-install-secrets.service'),
    'a failed renderer must not become a hard dependency of sops activation',
  );
  assert.ok(
    renderer.before.includes('nix-daemon.service'),
    'the renderer must finish before the daemon reads the machines file',
  );

  const words = execStartWords(renderer.execStart);
  assert.match(words[0], /\/bin\/fabro-darwin-machines$/, 'the unit must run fabro-darwin-machines');
  assert.deepEqual(words.slice(1), [
    '--output', EXPECTED_MACHINES_FILE,
    '--host-name', EXPECTED_MACHINE.hostName,
    '--ssh-user', EXPECTED_MACHINE.sshUser,
    '--system', EXPECTED_MACHINE.system,
    '--max-jobs', String(EXPECTED_MACHINE.maxJobs),
    '--speed-factor', String(EXPECTED_MACHINE.speedFactor),
    '--client-key', EXPECTED_CLIENT_KEY_PATH,
    '--host-key', EXPECTED_HOST_KEY_PATH,
  ]);
});

test('nix-daemon wants and follows the renderer without requiring it', () => {
  const { nixDaemon } = guestReport();

  assert.ok(nixDaemon.wants.includes('fabro-darwin-builders.service'));
  assert.ok(nixDaemon.after.includes('fabro-darwin-builders.service'));
  assert.ok(
    !nixDaemon.requires.includes('fabro-darwin-builders.service'),
    'a failed renderer must not block local aarch64-linux builds',
  );
  assert.equal(
    nixDaemon.hasExecStart,
    false,
    'the module adds ordering only; it must not replace the daemon command',
  );
  assert.equal(
    nixDaemon.hasScript,
    false,
    'the module must not wrap nix-daemon in a script',
  );
});

test('tmpfiles creates the machines file 0600 owned by root', () => {
  const { tmpfilesRules } = guestReport();
  const rules = tmpfilesRules.filter((rule) => rule.includes(EXPECTED_MACHINES_FILE));

  assert.deepEqual(rules, [`f ${EXPECTED_MACHINES_FILE} 0600 root root -`]);
});

test('both build-session secrets materialize root-read-only at their runtime paths', () => {
  const { secrets } = guestReport();

  for (const [name, expectedPath] of Object.entries(BUILD_SECRETS)) {
    assert.ok(secrets[name], `sops.secrets.${name} must be declared`);
    assert.equal(secrets[name].path, expectedPath, `sops.secrets.${name}.path`);
    assert.equal(secrets[name].mode, '0400', `sops.secrets.${name}.mode`);
    assert.equal(secrets[name].owner, 'root', `sops.secrets.${name}.owner`);
    assert.equal(secrets[name].group, 'root', `sops.secrets.${name}.group`);
  }
});

test('the sandbox keeps exactly the one-Nix store, daemon-socket, and tmpfs mounts', () => {
  const { sandbox } = guestReport();

  assert.deepEqual(sandbox.mounts, EXPECTED_CONTAINER_MOUNTS);
});

test('the sandbox image keeps NIX_REMOTE=daemon and holds no build or tailnet material', () => {
  const { sandbox } = guestReport();

  assert.ok(
    sandbox.imageEnv.includes('NIX_REMOTE=daemon'),
    'the image must talk to the guest daemon, not run its own',
  );

  const artifacts = {
    imageEnv: sandbox.imageEnv.join('\n'),
    imageConfig: sandbox.imageConfig,
    containersConf: sandbox.containersConf,
  };

  for (const [name, artifact] of Object.entries(artifacts)) {
    for (const [secretName, secretPath] of Object.entries(BUILD_SECRETS)) {
      assert.ok(
        !artifact.includes(secretName),
        `the sandbox ${name} must not mention ${secretName}`,
      );
      assert.ok(
        !artifact.includes(secretPath),
        `the sandbox ${name} must not carry the runtime path ${secretPath}`,
      );
    }

    assert.ok(
      !/tailscale/i.test(artifact),
      `the sandbox ${name} must not join the tailnet`,
    );
  }
});
