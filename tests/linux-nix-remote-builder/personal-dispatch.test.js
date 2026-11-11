'use strict';

// Personal Mac dispatch and secret-boundary regression suite for the Linux
// remote builder (task 6.3). `Brandons-MacBook-Pro` must render the existing
// Darwin record unchanged plus the pinned Linux `ssh-ng` record, keep its
// no-local-build/cache policy, and never expose private-key or Tailscale OAuth
// values in the generated machine data or the secret wiring. The negative
// fixtures prove each invariant actually fails when its input drifts.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { nixEvalFailure, nixEvalJson, repoRoot } = require('./helpers');

const personalHostName = 'Brandons-MacBook-Pro';
const darwinEndpoint = 'ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net';
const linuxEndpoint = 'ssh-ng://builder@linux-builder.tuxedo-musical.ts.net';
const linuxSystem = 'aarch64-linux';
const linuxClientKeyPath = '/run/secrets/linux-builder-client-key';
const darwinClientKeyPath = '/run/secrets/mac-builder-ssh-private-key';
const darwinHostKeyBase64 =
  'c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK';
const fixtureHostKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f linux-builder\n';
const fixtureHostKeyBase64 = Buffer.from(fixtureHostKey).toString('base64');

// Poisoned sentinels model a secret value that a regression could interpolate
// into rendered data or place in a plaintext Nix store path. They are test
// fixtures only and are never written to the repository or a real secret store.
const POISONED_PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nPOISONED_PRIVATE_KEY_MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n';
const POISONED_PRIVATE_KEY_MATERIAL = 'POISONED_PRIVATE_KEY_MATERIAL';
const POISONED_OAUTH_SECRET = 'tskey-client-POISONED_OAUTH_SECRET_VALUE';

const nixString = (value) => JSON.stringify(value);

function evaluatePersonalHost({ pinPath, extraModules = [] } = {}) {
  const modules = [
    `({ ... }: { nix-config.linuxBuilder.hostKeyPin = ${nixString(pinPath)}; })`,
    ...extraModules,
  ].join('\n');

  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      lib = flake.inputs.nixpkgs.lib;
      host = flake.darwinConfigurations.${nixString(personalHostName)}.extendModules {
        modules = [ ${modules} ];
      };
      cfg = host.config;
      buildersValue = cfg.nix.settings.builders;
      buildersFileOption = cfg.nix-config.linuxBuilder.buildersFile;
      buildersText =
        if lib.hasPrefix "@" buildersValue then
          builtins.readFile (lib.removePrefix "@" buildersValue)
        else
          buildersValue;
      linuxSecret = cfg.sops.secrets."linux-builder-client-key";
      darwinSecret = cfg.sops.secrets."mac-builder-ssh-private-key";
      secretSummary = builtins.mapAttrs (_: secret: {
        path = secret.path;
        key = secret.key;
        mode = secret.mode;
        owner = secret.owner;
        group = secret.group;
        sopsFile = toString secret.sopsFile;
      }) cfg.sops.secrets;
    in
    {
      builders = buildersValue;
      buildersFile = toString buildersFileOption;
      buildersText = buildersText;
      maxJobs = cfg.nix.settings.max-jobs;
      distributedBuilds = cfg.nix.distributedBuilds;
      buildersUseSubstitutes = cfg.nix.settings.builders-use-substitutes;
      substituters = cfg.nix.settings.substituters;
      trustedPublicKeys = cfg.nix.settings.trusted-public-keys;
      extraSubstituters = cfg.nix.settings.extra-substituters;
      extraTrustedPublicKeys = cfg.nix.settings.extra-trusted-public-keys;
      linuxSecret = {
        path = linuxSecret.path;
        key = linuxSecret.key;
        mode = linuxSecret.mode;
        owner = linuxSecret.owner;
        group = linuxSecret.group;
        sopsFile = toString linuxSecret.sopsFile;
      };
      darwinSecret = {
        path = darwinSecret.path;
        mode = darwinSecret.mode;
        owner = darwinSecret.owner;
        sopsFile = toString darwinSecret.sopsFile;
      };
      linuxSopsFileText = builtins.readFile linuxSecret.sopsFile;
      darwinSopsFileText = builtins.readFile darwinSecret.sopsFile;
      defaultSopsFile = toString cfg.sops.defaultSopsFile;
      oauthSecretNames = builtins.filter (
        name: builtins.match ".*(tailscale|oauth).*" name != null
      ) (builtins.attrNames cfg.sops.secrets);
      settingsJson = builtins.toJSON cfg.nix.settings;
      secretJson = builtins.toJSON secretSummary;
    }
  `);
}

function evaluateBuilderHost(extraModules = []) {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      host = flake.nixosConfigurations.linux-builder.extendModules {
        modules = [ ${extraModules.join('\n')} ];
      };
      cfg = host.config;
      secret = cfg.sops.secrets."builder-tailscale-oauth-secret";
    in
    {
      path = secret.path;
      mode = secret.mode;
      owner = secret.owner;
      sopsFile = toString secret.sopsFile;
      sopsFileText = builtins.readFile secret.sopsFile;
      declarationJson = builtins.toJSON secret;
    }
  `);
}

function fixturePin(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-linux-builder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pinPath = path.join(directory, 'ssh_host_ed25519_key.pub');
  fs.writeFileSync(pinPath, fixtureHostKey);
  return pinPath;
}

// Detects plaintext secret material in anything that could be rendered into a
// Nix setting, a generated machine file, or a Nix store path.
function assertNoSecretMaterial(text, label) {
  assert.doesNotMatch(
    text,
    /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/,
    `${label} must not contain private key material`,
  );
  assert.ok(
    !text.includes(POISONED_PRIVATE_KEY_MATERIAL),
    `${label} must not contain private key material`,
  );
  assert.doesNotMatch(
    text,
    /\btskey-[A-Za-z0-9_-]{8,}/,
    `${label} must not contain a Tailscale OAuth secret`,
  );
  assert.ok(
    !text.includes(POISONED_OAUTH_SECRET),
    `${label} must not contain a Tailscale OAuth secret`,
  );
  assert.doesNotMatch(
    text,
    /AGE-SECRET-KEY-1[A-Z0-9]{10,}/,
    `${label} must not contain an age private key`,
  );
}

// Shared policy invariant for the personal Mac. Each assertion names the
// contract it protects so a test-only overlay can prove a drift is rejected.
function assertPersonalDispatchPolicy(config) {
  assertNoSecretMaterial(
    [
      config.builders,
      config.buildersFile,
      config.buildersText,
      config.settingsJson,
      config.secretJson,
      config.linuxSopsFileText,
      config.darwinSopsFileText,
    ].join('\n'),
    'personal host generated machine data and secret wiring',
  );

  // Both machine records, in the same order as the generated file. The Darwin
  // record must stay byte-for-byte equivalent to the pre-Linux entry.
  const records = config.buildersText.trimEnd().split('\n');
  assert.equal(
    records.length,
    2,
    'the personal builders file must contain the Darwin and Linux machine records (Requirement 3.3)',
  );
  const [darwin, linux] = records.map((line) => line.split(' '));

  assert.equal(darwin.length, 8, `Darwin machine record must have eight fields: ${records[0]}`);
  assert.equal(darwin[0], darwinEndpoint, 'the existing Darwin machine entry must keep its endpoint (Requirement 3.3)');
  assert.equal(darwin[1], 'aarch64-darwin', 'the existing Darwin machine entry must keep its aarch64-darwin system (Requirement 3.3)');
  assert.equal(darwin[2], darwinClientKeyPath, 'the existing Darwin machine entry must keep its runtime client key (Requirement 3.3)');
  assert.equal(darwin[3], '8', 'the existing Darwin machine entry must keep its eight jobs (Requirement 3.3)');
  assert.equal(darwin[4], '1', 'the existing Darwin machine entry must keep its speed factor (Requirement 3.3)');
  assert.equal(darwin[5], '-');
  assert.equal(darwin[6], '-');
  assert.equal(darwin[7], darwinHostKeyBase64, 'the existing Darwin host-key pin must not change (Requirement 3.3)');

  assert.equal(linux.length, 8, `Linux machine record must have eight fields: ${records[1]}`);
  assert.equal(linux[0], linuxEndpoint, 'the personal Mac must dispatch aarch64-linux to the Linux builder (Requirement 3.2)');
  assert.equal(linux[1], linuxSystem, 'the Linux machine entry must support only aarch64-linux (Requirements 1.2, 3.2)');
  assert.equal(
    linux[2],
    linuxClientKeyPath,
    'the Linux machine entry must reference the dedicated runtime SOPS key path (Requirement 3.2)',
  );
  assert.equal(linux[3], '4', 'the Linux machine entry must allow four remote jobs (Requirement 3.2)');
  assert.equal(linux[4], '1', 'the Linux machine entry must use speed factor 1 (Requirement 3.2)');
  assert.equal(linux[5], '-');
  assert.equal(linux[6], '-');
  assert.equal(
    linux[7],
    fixtureHostKeyBase64,
    'the Linux machine entry must carry the pinned builder host public key (Requirement 3.2)',
  );

  // The personal host keeps zero local jobs, never enables global distributed
  // builds, and retains the existing public cache policy.
  assert.equal(
    config.maxJobs,
    0,
    'the personal host must keep max-jobs = 0 (Requirements 3.2, 3.3)',
  );
  assert.equal(
    config.distributedBuilds,
    false,
    'the personal host must not enable global distributed builds (Requirement 3.3)',
  );
  assert.equal(
    config.buildersUseSubstitutes,
    true,
    'the personal host must keep using builder substitutes (Requirement 3.3)',
  );
  assert.deepEqual(
    config.substituters,
    ['https://cache.nixos.org/'],
    'the personal host must keep the default public substituter (Requirement 3.3)',
  );
  assert.deepEqual(
    config.trustedPublicKeys,
    ['cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY='],
    'the personal host must keep the default public cache key (Requirement 3.3)',
  );
  assert.deepEqual(
    config.extraSubstituters,
    ['https://nix-community.cachix.org'],
    'the personal host must keep its existing extra substituter (Requirement 3.3)',
  );
  assert.deepEqual(
    config.extraTrustedPublicKeys,
    ['nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs='],
    'the personal host must keep its existing extra cache key (Requirement 3.3)',
  );

  // The machine file is generated in the Nix store and referenced through
  // `@`; the private key itself stays at its SOPS runtime path.
  assert.match(
    config.builders,
    /^@\/nix\/store\/[a-z0-9]+-nix-builders$/,
    'the personal host must reference the generated builders file through @ (Requirement 3.2)',
  );
  assert.equal(
    config.builders,
    `@${config.buildersFile}`,
    'the personal host must reference the generated builders file option (Requirement 3.2)',
  );
  assert.match(config.buildersFile, /^\/nix\/store\//);
  assert.doesNotMatch(config.buildersText, /PRIVATE KEY/);

  assert.deepEqual(config.linuxSecret, {
    path: linuxClientKeyPath,
    key: 'linux-builder-client-key',
    mode: '0400',
    owner: 'root',
    group: 'staff',
    sopsFile: config.linuxSecret.sopsFile,
  }, 'the Linux client key must be a root-only mode-0400 runtime secret (Requirement 3.2)');
  assert.match(
    config.linuxSecret.sopsFile,
    /(linux-builder-client\.personal\.yaml|linux-builder-client-unprovisioned-secrets\.yaml)$/,
    'the Linux client key must come from its own personal encrypted store (Requirement 3.2)',
  );
  assert.notEqual(
    config.linuxSecret.sopsFile,
    config.darwinSecret.sopsFile,
    'the Linux client key must not reuse the Darwin client store (Requirement 3.2)',
  );
  assert.deepEqual(config.darwinSecret, {
    path: darwinClientKeyPath,
    mode: '0400',
    owner: 'root',
    sopsFile: config.darwinSecret.sopsFile,
  }, 'the existing Darwin client key must keep its runtime declaration (Requirement 3.3)');
  assert.match(config.defaultSopsFile, /\/secrets\/mcp\.personal\.yaml$/);

  assert.deepEqual(
    config.oauthSecretNames,
    [],
    'the personal Mac must not declare a builder Tailscale OAuth secret (Requirement 3.2)',
  );

  // The personal client must never reference the builder-only runtime paths:
  // those credentials belong to the Linux host, not to the Mac.
  for (const [label, text] of [
    ['generated machine data', config.buildersText],
    ['rendered Nix settings', config.settingsJson],
    ['personal SOPS declarations', config.secretJson],
  ]) {
    assert.doesNotMatch(
      text,
      /builder-tailscale-oauth-secret|builder-authorized-keys/,
      `the personal Mac's ${label} must not reference builder-only secret paths (Requirement 3.2)`,
    );
  }
}

function buildersOverride(text, name = 'test-builders') {
  return `({ lib, pkgs, ... }: {
    nix.settings.builders = lib.mkOverride 40 "@\${pkgs.writeText ${nixString(name)} ${nixString(text)}}";
  })`;
}

function poisonedPersonalClientStore(text) {
  return `({ lib, pkgs, ... }: {
    sops.secrets.linux-builder-client-key.sopsFile =
      lib.mkForce (pkgs.writeText "poisoned-linux-builder-client-key" ${nixString(text)});
  })`;
}

function poisonedBuilderOauthStore(text) {
  return `({ lib, pkgs, ... }: {
    sops.secrets."builder-tailscale-oauth-secret".sopsFile =
      lib.mkForce (pkgs.writeText "poisoned-builder-oauth-store" ${nixString(text)});
  })`;
}

const darwinRecord = `${darwinEndpoint} aarch64-darwin ${darwinClientKeyPath} 8 1 - - ${darwinHostKeyBase64}`;
const linuxRecord = `${linuxEndpoint} ${linuxSystem} ${linuxClientKeyPath} 4 1 - - ${fixtureHostKeyBase64}`;

test('personal host renders both machine records with the dedicated SOPS key and unchanged policy', (t) => {
  const config = evaluatePersonalHost({ pinPath: fixturePin(t) });

  assertPersonalDispatchPolicy(config);
  assert.equal(
    config.buildersText,
    `${darwinRecord}\n${linuxRecord}\n`,
    'the generated builders file must contain exactly the unchanged Darwin record and the pinned Linux record',
  );
});

test('personal policy rejects a missing Linux machine record', (t) => {
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [buildersOverride(`${darwinRecord}\n`, 'darwin-only-builders')],
  });

  assert.equal(config.buildersText, `${darwinRecord}\n`, 'the fixture must really remove the Linux record');
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /Darwin and Linux machine records/,
  );
});

test('personal policy rejects a Linux client key outside the runtime SOPS path', (t) => {
  const wrongKeyRecord = `${linuxEndpoint} ${linuxSystem} /tmp/linux-builder-client-key 4 1 - - ${fixtureHostKeyBase64}`;
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [buildersOverride(`${darwinRecord}\n${wrongKeyRecord}\n`, 'wrong-key-builders')],
  });

  const linuxFields = config.buildersText.trimEnd().split('\n')[1].split(' ');
  assert.equal(linuxFields[2], '/tmp/linux-builder-client-key', 'the fixture must really change the Linux key path');
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /dedicated runtime SOPS key path/,
  );
});

test('personal policy rejects a Linux machine entry on an unsupported system', (t) => {
  const wrongSystemRecord = `${linuxEndpoint} aarch64-darwin ${linuxClientKeyPath} 4 1 - - ${fixtureHostKeyBase64}`;
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [buildersOverride(`${darwinRecord}\n${wrongSystemRecord}\n`, 'wrong-system-builders')],
  });

  const linuxFields = config.buildersText.trimEnd().split('\n')[1].split(' ');
  assert.equal(linuxFields[1], 'aarch64-darwin', 'the fixture must really change the Linux system');
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /must support only aarch64-linux/,
  );
});

test('personal policy rejects an altered Darwin machine record', (t) => {
  const alteredDarwinRecord = `${darwinEndpoint} aarch64-linux ${darwinClientKeyPath} 8 1 - - ${darwinHostKeyBase64}`;
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [buildersOverride(`${alteredDarwinRecord}\n${linuxRecord}\n`, 'altered-darwin-builders')],
  });

  const darwinFields = config.buildersText.trimEnd().split('\n')[0].split(' ');
  assert.equal(darwinFields[1], 'aarch64-linux', 'the fixture must really change the Darwin system');
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /Darwin machine entry must keep its aarch64-darwin system/,
  );
});

test('personal policy rejects a nonzero local job limit', (t) => {
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: ['({ lib, ... }: { nix.settings.max-jobs = lib.mkForce 2; })'],
  });

  assert.equal(config.maxJobs, 2, 'the fixture must really change max-jobs');
  assert.throws(() => assertPersonalDispatchPolicy(config), /max-jobs = 0/);
});

test('personal policy rejects enabling global distributed builds', (t) => {
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: ['({ lib, ... }: { nix.distributedBuilds = lib.mkForce true; })'],
  });

  assert.equal(config.distributedBuilds, true, 'the fixture must really enable distributed builds');
  assert.throws(() => assertPersonalDispatchPolicy(config), /global distributed builds/);
});

test('personal policy rejects a changed cache policy', (t) => {
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [`({ lib, ... }: {
      nix.settings.extra-substituters = lib.mkForce [ "https://attic.private.example" ];
    })`],
  });

  assert.deepEqual(config.extraSubstituters, ['https://attic.private.example']);
  assert.throws(() => assertPersonalDispatchPolicy(config), /extra substituter/);
});

test('personal policy detects an injected private key in generated machine data', (t) => {
  const poisonedRecord = `${linuxRecord}\n${POISONED_PRIVATE_KEY}`;
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [buildersOverride(poisonedRecord, 'poisoned-private-key-builders')],
  });

  assert.ok(config.buildersText.includes(POISONED_PRIVATE_KEY_MATERIAL), 'the fixture must really inject the private key');
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /private key material/,
  );
});

test('personal policy detects an injected OAuth value in generated machine data', (t) => {
  const poisonedRecord = `${linuxRecord}\n${POISONED_OAUTH_SECRET}`;
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [buildersOverride(poisonedRecord, 'poisoned-oauth-builders')],
  });

  assert.ok(config.buildersText.includes(POISONED_OAUTH_SECRET), 'the fixture must really inject the OAuth value');
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /Tailscale OAuth secret/,
  );
});

test('personal policy detects a private key placed in the client-key Nix store', (t) => {
  const config = evaluatePersonalHost({
    pinPath: fixturePin(t),
    extraModules: [poisonedPersonalClientStore(POISONED_PRIVATE_KEY)],
  });

  assert.ok(
    config.linuxSopsFileText.includes(POISONED_PRIVATE_KEY_MATERIAL),
    'the fixture must really place the private key in the sops store path',
  );
  assert.throws(
    () => assertPersonalDispatchPolicy(config),
    /private key material/,
  );
});

test('builder OAuth secret stays a root-only runtime path and out of plaintext Nix stores', () => {
  const config = evaluateBuilderHost();

  assert.equal(config.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(config.mode, '0400');
  assert.equal(config.owner, 'root');
  assert.match(
    config.sopsFile,
    /(remote-builder\.linux-builder\.yaml|linux-builder-unprovisioned-secrets\.yaml)$/,
  );
  assertNoSecretMaterial(config.sopsFileText, 'builder OAuth secret store');
  assertNoSecretMaterial(config.declarationJson, 'builder OAuth secret declaration');
});

test('builder OAuth secret wiring detects an injected plaintext credential', () => {
  const config = evaluateBuilderHost([poisonedBuilderOauthStore(POISONED_OAUTH_SECRET)]);

  assert.ok(config.sopsFileText.includes(POISONED_OAUTH_SECRET), 'the fixture must really inject the OAuth value');
  assert.throws(
    () => assertNoSecretMaterial(config.sopsFileText, 'builder OAuth secret store'),
    /Tailscale OAuth secret/,
  );
});

test('a missing Linux host-key pin keeps evaluation working and fails closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-linux-builder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missingPin = path.join(directory, 'missing-ssh_host_ed25519_key.pub');

  const result = childProcess.spawnSync(
    'nix',
    [
      'eval',
      '--json',
      '--impure',
      '--expr',
      `
        let
          flake = builtins.getFlake (toString ${nixString(repoRoot)});
          host = flake.darwinConfigurations.${nixString(personalHostName)}.extendModules {
            modules = [
              ({ ... }: { nix-config.linuxBuilder.hostKeyPin = ${nixString(missingPin)}; })
            ];
          };
          cfg = host.config;
        in
        { buildersText = cfg.nix-config.linuxBuilder.buildersFile.text; }
      `,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Linux builder SSH host-key pin is missing/);
  assert.match(result.stderr, /missing-ssh_host_ed25519_key\.pub/);

  const records = JSON.parse(result.stdout).buildersText.trimEnd().split('\n');
  assert.equal(records.length, 2);
  assert.match(records[0], / aarch64-darwin /);
  assert.equal(
    records[1],
    `${linuxEndpoint} ${linuxSystem} ${linuxClientKeyPath} 4 1 - -`,
    'the unprovisioned Linux record must omit the pin and fail closed',
  );
});

test('the Linux host-key pin must be a single ssh-ed25519 public key', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-linux-builder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pinPath = path.join(directory, 'ssh_host_ed25519_key.pub');
  fs.writeFileSync(pinPath, 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ linux-builder\n');

  const stderr = nixEvalFailure(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      host = flake.darwinConfigurations.${nixString(personalHostName)}.extendModules {
        modules = [
          ({ ... }: { nix-config.linuxBuilder.hostKeyPin = ${nixString(pinPath)}; })
        ];
      };
      cfg = host.config;
    in
    cfg.nix.settings.builders
  `);

  assert.match(stderr, /Linux builder SSH host-key pin is not an ssh-ed25519 public key/);
  assert.match(stderr, /ssh_host_ed25519_key\.pub/);
});
