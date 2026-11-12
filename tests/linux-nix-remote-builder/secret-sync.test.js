'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function nixEvalJson(expression, options = {}) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expression],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 180_000,
    },
  ));
}

let testToolsCache = null;

function testTools() {
  if (testToolsCache) {
    return testToolsCache;
  }
  const output = childProcess.execFileSync(
    'nix',
    [
      'build',
      '--impure',
      '--no-link',
      '--print-out-paths',
      '--expr',
      `let
        flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
        pkgs = import flake.inputs.nixpkgs {
          system = builtins.currentSystem;
          config.allowUnfree = true;
        };
      in
      pkgs.symlinkJoin {
        name = "linux-builder-sync-test-tools";
        paths = with pkgs; [ age openssh sops git ];
      }`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    },
  ).trim();
  testToolsCache = {
    bin: path.join(output, 'bin'),
    ageKeygen: path.join(output, 'bin/age-keygen'),
    sshKeygen: path.join(output, 'bin/ssh-keygen'),
    sops: path.join(output, 'bin/sops'),
    git: path.join(output, 'bin/git'),
  };
  return testToolsCache;
}

function buildSyncScript() {
  const output = childProcess.execFileSync(
    'nix',
    [
      'build',
      '--impure',
      '--no-link',
      '--print-out-paths',
      '--expr',
      `let
        flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
        pkgs = import flake.inputs.nixpkgs {
          system = builtins.currentSystem;
          config.allowUnfree = true;
        };
      in
      pkgs.callPackage ./scripts/linux-builder-sync-from-1password.nix { }`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    },
  );
  return path.join(output.trim(), 'bin/linux-builder-sync-from-1password');
}

function generateAgeKey(directory, name) {
  const ageKeygen = testTools().ageKeygen;
  const keyPath = path.join(directory, `${name}.txt`);
  childProcess.execFileSync(ageKeygen, ['-o', keyPath], { stdio: 'ignore' });
  return {
    keyPath,
    privateKey: fs.readFileSync(keyPath, 'utf8'),
    recipient: childProcess.execFileSync(
      ageKeygen,
      ['-y', keyPath],
      { encoding: 'utf8' },
    ).trim(),
  };
}

function generateSshKey(directory, name) {
  const sshKeygen = testTools().sshKeygen;
  const keyPath = path.join(directory, name);
  childProcess.execFileSync(sshKeygen, [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    name,
    '-f',
    keyPath,
  ]);
  return {
    keyPath,
    privateKey: fs.readFileSync(keyPath, 'utf8'),
    publicKey: fs.readFileSync(`${keyPath}.pub`, 'utf8').trim(),
  };
}

function writeFixtureStoreConfig(directory, personalRecipient, builderRecipient = null) {
  const config = path.join(directory, '.sops.yaml');
  const builderKey = builderRecipient ? `  - &host_linux_builder ${builderRecipient}\n` : '';
  fs.writeFileSync(config, `keys:
  - &host_personal ${personalRecipient}
${builderKey}
creation_rules:
  - path_regex: secrets/remote-builder\\.linux-builder\\.yaml$
    key_groups:
      - age: []
  - path_regex: secrets/linux-builder-client\\.personal\\.yaml$
    key_groups:
      - age:
          - *host_personal
`);
  return config;
}

function createFixtureRepository(directory, personalRecipient, builderRecipient = null) {
  const repository = path.join(directory, 'repo');
  fs.mkdirSync(path.join(repository, 'secrets'), { recursive: true });
  childProcess.execFileSync(testTools().git, ['init', '-q'], { cwd: repository });
  writeFixtureStoreConfig(repository, personalRecipient, builderRecipient);
  return repository;
}

function writeMockOp(directory) {
  const logPath = path.join(directory, 'op-calls.log');
  const opPath = path.join(directory, 'op');
  fs.writeFileSync(opPath, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "\${MOCK_OP_LOG:?}"
case "$1" in
  whoami)
    printf 'fixture\n'
    ;;
  read)
    shift
    if [ "\${1:-}" = "--no-newline" ]; then shift; fi
    uri="\${1:-}"
    base="\${uri%%\\?*}"
    if [ -n "\${MOCK_FAIL_URI:-}" ] && [ "$base" = "$MOCK_FAIL_URI" ]; then
      echo "mock op: forced failure for $uri" >&2
      exit 1
    fi
    case "$base" in
      "op://Private/sops-age-key-linux-builder/notesPlain") cat "$MOCK_BUILDER_AGE_KEY_FILE" ;;
      "op://Private/sops-age-key-personal/notesPlain") cat "$MOCK_PERSONAL_AGE_KEY_FILE" ;;
      "op://Infrastructure/mac-builder authorized keys/notesPlain") cat "$MOCK_AUTHORIZED_KEYS_FILE" ;;
      "op://Infrastructure/mac-builder Tailscale OAuth/Client Secret") printf '%s' "$MOCK_TAILSCALE_SECRET" ;;
      "op://Infrastructure/mpbezzwylhzlupl7epao2mp5za/private key") cat "$MOCK_PERSONAL_CLIENT_KEY_FILE" ;;
      *) echo "mock op: unexpected URI $uri" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "mock op: unsupported invocation: $*" >&2
    exit 2
    ;;
esac
`, { mode: 0o755 });
  return { opPath, logPath };
}

function syncEnvironment({ opPath, logPath, builderAge, personalAge, authorizedKeysFile, tailscaleSecret, personalClientKeyFile, extra = {} }) {
  return {
    ...process.env,
    OP_BIN: opPath,
    MOCK_OP_LOG: logPath,
    MOCK_BUILDER_AGE_KEY_FILE: builderAge.keyPath,
    MOCK_PERSONAL_AGE_KEY_FILE: personalAge.keyPath,
    MOCK_AUTHORIZED_KEYS_FILE: authorizedKeysFile,
    MOCK_TAILSCALE_SECRET: tailscaleSecret,
    MOCK_PERSONAL_CLIENT_KEY_FILE: personalClientKeyFile,
    ...extra,
  };
}

function decryptValue(storePath, ageKeyPath, extraction) {
  return childProcess.execFileSync(
    testTools().sops,
    [
      '--config',
      path.join(path.dirname(storePath), '..', '.sops.yaml'),
      '--input-type',
      'yaml',
      '--output-type',
      'yaml',
      '--decrypt',
      '--extract',
      extraction,
      storePath,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath },
    },
  ).trimEnd();
}

function sourceText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('the builder creation rule fails closed without the operator recipient', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-sops-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const config = path.join(directory, '.sops.yaml');
  fs.copyFileSync(path.join(repoRoot, '.sops.yaml'), config);
  const secrets = path.join(directory, 'secrets');
  fs.mkdirSync(secrets);
  const store = path.join(secrets, 'remote-builder.linux-builder.yaml');
  fs.writeFileSync(store, 'builder-authorized-keys: fixture\n');

  const result = childProcess.spawnSync(
    testTools().sops,
    [
      '--config',
      config,
      '--filename-override',
      'secrets/remote-builder.linux-builder.yaml',
      '--input-type',
      'yaml',
      '--output-type',
      'yaml',
      '--encrypt',
      '--in-place',
      store,
    ],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /empty key group provided/);
  assert.equal(fs.readFileSync(store, 'utf8'), 'builder-authorized-keys: fixture\n');
});

test('builder secret declarations reference only root-only runtime paths', () => {
  const config = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      cfg = flake.nixosConfigurations.linux-builder.config;
      secret = name: let entry = cfg.sops.secrets.\${name}; in {
        path = entry.path;
        sopsFile = toString entry.sopsFile;
        mode = entry.mode;
        owner = entry.owner;
      };
    in {
      authorized = secret "builder-authorized-keys";
      tailscale = secret "builder-tailscale-oauth-secret";
      defaultSopsFile = toString cfg.sops.defaultSopsFile;
      declaration = builtins.readFile ${JSON.stringify(path.join(repoRoot, 'configurations/linux-builder/default.nix'))};
    }
  `);

  assert.deepEqual(config.authorized, {
    path: '/run/secrets/builder-authorized-keys',
    sopsFile: config.authorized.sopsFile,
    mode: '0400',
    owner: 'root',
  });
  assert.deepEqual(config.tailscale, {
    path: '/run/secrets/builder-tailscale-oauth-secret',
    sopsFile: config.tailscale.sopsFile,
    mode: '0400',
    owner: 'root',
  });
  const storePattern =
    /(remote-builder\.linux-builder\.yaml|linux-builder-unprovisioned-secrets\.yaml)$/;
  assert.match(config.authorized.sopsFile, storePattern);
  assert.match(config.tailscale.sopsFile, storePattern);
  assert.match(
    config.defaultSopsFile,
    /(remote-builder\.linux-builder\.yaml|linux-builder-unprovisioned-secrets\.yaml)$/,
  );
  assert.match(config.declaration, /"builder-authorized-keys"/);
  assert.match(config.declaration, /"builder-tailscale-oauth-secret"/);
});

test('sops recipients keep the builder and personal client stores distinct without fabricated keys', () => {
  const config = sourceText('.sops.yaml');

  assert.match(config, /path_regex: secrets\/remote-builder\\\.linux-builder\\\.yaml\$/);
  assert.match(config, /path_regex: secrets\/linux-builder-client\\\.personal\\\.yaml\$/);

  const builderRule = config.slice(
    config.indexOf("# The linux-builder host's own store"),
    config.indexOf('path_regex: secrets/linux-builder-client\\.personal\\.yaml$'),
  );
  assert.match(builderRule, /age: \[\]/);
  assert.match(builderRule, /linux-builder-sync-from-1password/);
  assert.match(config, /op:\/\/Private\/sops-age-key-linux-builder\/notesPlain/);
  assert.match(config, /host_linux_builder/);

  const personalRule = config.slice(
    config.indexOf('path_regex: secrets/linux-builder-client\\.personal\\.yaml$'),
  );
  assert.match(personalRule, /\*host_personal/);
  assert.doesNotMatch(config, /age1placeholder/i);
  assert.doesNotMatch(config, /AGE-SECRET-KEY/);
  assert.doesNotMatch(config, /PRIVATE KEY/);
});

test('personal Linux client key is declared as its own root-only secret store', () => {
  const config = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      cfg = flake.darwinConfigurations."Brandons-MacBook-Pro".config;
      linux = cfg.sops.secrets."linux-builder-client-key";
      darwin = cfg.sops.secrets."mac-builder-ssh-private-key";
    in {
      linux = {
        path = linux.path;
        mode = linux.mode;
        owner = linux.owner;
        sopsFile = toString linux.sopsFile;
      };
      darwinPath = darwin.path;
    }
  `);

  assert.deepEqual(config.linux, {
    path: '/run/secrets/linux-builder-client-key',
    mode: '0400',
    owner: 'root',
    sopsFile: config.linux.sopsFile,
  });
  assert.match(
    config.linux.sopsFile,
    /(linux-builder-client\.personal\.yaml|linux-builder-client-unprovisioned-secrets\.yaml)$/,
  );
  assert.equal(config.darwinPath, '/run/secrets/mac-builder-ssh-private-key');
});

test('Fabro sync manifest includes the distinct Linux client key', () => {
  const config = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
      cfg = flake.nixosConfigurations.fabro-vm.config;
      linux = cfg.sops.secrets."linux-builder-client-key";
    in {
      manifest = cfg.fabro.onePasswordSecrets;
      linux = {
        path = linux.path;
        mode = linux.mode;
        owner = linux.owner;
      };
    }
  `);

  assert.equal(
    config.manifest['linux-builder-client-key'],
    'op://Infrastructure/Fabro Linux nix remote builder key/private key',
  );
  assert.equal(config.manifest['build-client-key'], 'op://Infrastructure/Fabro nix remote builder key/private key?ssh-format=openssh');
  assert.deepEqual(config.linux, {
    path: '/run/secrets/linux-builder-client-key',
    mode: '0400',
    owner: 'root',
  });

  const sync = sourceText('scripts/fabro-sync-from-1password.nix');
  assert.match(sync, /ssh-format=openssh/);
  assert.match(sync, /linux-builder-client-key/);
  assert.match(sync, /ssh-keygen -y -f/);
  assert.doesNotMatch(sync, /age-keygen -o/);
  assert.doesNotMatch(sync, /ssh-keygen -t/);
  assert.doesNotMatch(sync, /op item create/);
});

test('builder sync encrypts fixture values to the operator recipient and personal store', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const builderAge = generateAgeKey(directory, 'builder-age');
  const personalAge = generateAgeKey(directory, 'personal-age');
  const fabroClient = generateSshKey(directory, 'fabro-client');
  const personalClient = generateSshKey(directory, 'personal-client');
  const outsideClient = generateSshKey(directory, 'outside-client');

  const authorizedKeysFile = path.join(directory, 'authorized-keys.txt');
  fs.writeFileSync(
    authorizedKeysFile,
    `${fabroClient.publicKey}\n${personalClient.publicKey}\n`,
  );

  const repository = createFixtureRepository(directory, personalAge.recipient, builderAge.recipient);
  const { opPath, logPath } = writeMockOp(directory);
  const script = buildSyncScript();

  const result = childProcess.spawnSync(script, [], {
    cwd: repository,
    encoding: 'utf8',
    env: syncEnvironment({
      opPath,
      logPath,
      builderAge,
      personalAge,
      authorizedKeysFile,
      tailscaleSecret: 'tskey-client-fixture-oauth-secret',
      personalClientKeyFile: personalClient.keyPath,
    }),
    timeout: 120_000,
  });

  assert.equal(result.status, 0, result.stderr);

  const builderStore = path.join(repository, 'secrets/remote-builder.linux-builder.yaml');
  const personalStore = path.join(repository, 'secrets/linux-builder-client.personal.yaml');
  assert.ok(fs.existsSync(builderStore), 'builder store was not written');
  assert.ok(fs.existsSync(personalStore), 'personal client store was not written');

  const encryptedBuilder = fs.readFileSync(builderStore, 'utf8');
  assert.match(encryptedBuilder, new RegExp(`recipient: ${builderAge.recipient}`));
  assert.doesNotMatch(encryptedBuilder, /tskey-client-fixture-oauth-secret/);
  assert.doesNotMatch(encryptedBuilder, /PRIVATE KEY/);

  assert.equal(
    decryptValue(builderStore, builderAge.keyPath, '["builder-authorized-keys"]'),
    `${fabroClient.publicKey}\n${personalClient.publicKey}`,
  );
  assert.equal(
    decryptValue(builderStore, builderAge.keyPath, '["builder-tailscale-oauth-secret"]'),
    'tskey-client-fixture-oauth-secret',
  );
  assert.ok(
    !decryptValue(builderStore, builderAge.keyPath, '["builder-authorized-keys"]').includes(outsideClient.publicKey),
    'an unauthorized client key was written to the builder store',
  );

  const encryptedPersonal = fs.readFileSync(personalStore, 'utf8');
  assert.match(encryptedPersonal, new RegExp(`recipient: ${personalAge.recipient}`));
  assert.doesNotMatch(encryptedPersonal, /PRIVATE KEY/);
  assert.equal(
    decryptValue(personalStore, personalAge.keyPath, '["linux-builder-client-key"]'),
    personalClient.privateKey.trimEnd(),
  );

  const calls = fs.readFileSync(logPath, 'utf8');
  assert.match(calls, /read --no-newline/);
  assert.doesNotMatch(calls, /item create|generate|age-keygen/);
});

test('builder sync fails closed and leaves the prior stores untouched on bad inputs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const builderAge = generateAgeKey(directory, 'builder-age');
  const personalAge = generateAgeKey(directory, 'personal-age');
  const fabroClient = generateSshKey(directory, 'fabro-client');
  const personalClient = generateSshKey(directory, 'personal-client');

  const authorizedKeysFile = path.join(directory, 'authorized-keys.txt');
  fs.writeFileSync(authorizedKeysFile, `${fabroClient.publicKey}\n`);

  const repository = createFixtureRepository(directory, personalAge.recipient, builderAge.recipient);
  const builderStore = path.join(repository, 'secrets/remote-builder.linux-builder.yaml');
  const personalStore = path.join(repository, 'secrets/linux-builder-client.personal.yaml');
  fs.writeFileSync(builderStore, 'prior-builder-store\n');
  fs.writeFileSync(personalStore, 'prior-personal-store\n');

  const { opPath, logPath } = writeMockOp(directory);
  const script = buildSyncScript();
  const baseEnvironment = {
    opPath,
    logPath,
    builderAge,
    personalAge,
    authorizedKeysFile,
    tailscaleSecret: 'tskey-client-fixture-oauth-secret',
    personalClientKeyFile: personalClient.keyPath,
  };

  const failing = childProcess.spawnSync(script, [], {
    cwd: repository,
    encoding: 'utf8',
    env: syncEnvironment({
      ...baseEnvironment,
      extra: { MOCK_FAIL_URI: 'op://Infrastructure/mac-builder Tailscale OAuth/Client Secret' },
    }),
    timeout: 120_000,
  });
  assert.notEqual(failing.status, 0);
  assert.equal(fs.readFileSync(builderStore, 'utf8'), 'prior-builder-store\n');
  assert.equal(fs.readFileSync(personalStore, 'utf8'), 'prior-personal-store\n');

  fs.writeFileSync(authorizedKeysFile, '');
  const emptyKeys = childProcess.spawnSync(script, [], {
    cwd: repository,
    encoding: 'utf8',
    env: syncEnvironment(baseEnvironment),
    timeout: 120_000,
  });
  assert.notEqual(emptyKeys.status, 0);
  assert.match(emptyKeys.stderr, /authorized keys/i);
  assert.equal(fs.readFileSync(builderStore, 'utf8'), 'prior-builder-store\n');
  assert.equal(fs.readFileSync(personalStore, 'utf8'), 'prior-personal-store\n');

  fs.writeFileSync(authorizedKeysFile, `${fabroClient.publicKey}\n`);
  const privateKeyFile = path.join(directory, 'not-a-key');
  fs.writeFileSync(privateKeyFile, 'not an OpenSSH key\n');
  const invalidClient = childProcess.spawnSync(script, [], {
    cwd: repository,
    encoding: 'utf8',
    env: syncEnvironment({ ...baseEnvironment, personalClientKeyFile: privateKeyFile }),
    timeout: 120_000,
  });
  assert.notEqual(invalidClient.status, 0);
  assert.match(invalidClient.stderr, /OpenSSH private key/i);
  assert.equal(fs.readFileSync(builderStore, 'utf8'), 'prior-builder-store\n');
  assert.equal(fs.readFileSync(personalStore, 'utf8'), 'prior-personal-store\n');
});

test('builder sync rejects a .sops.yaml recipient that does not match the operator age key', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-builder-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const builderAge = generateAgeKey(directory, 'builder-age');
  const mistakenAge = generateAgeKey(directory, 'mistaken-builder-age');
  const personalAge = generateAgeKey(directory, 'personal-age');
  const client = generateSshKey(directory, 'fabro-client');
  const personalClient = generateSshKey(directory, 'personal-client');

  const authorizedKeysFile = path.join(directory, 'authorized-keys.txt');
  fs.writeFileSync(authorizedKeysFile, `${client.publicKey}\n`);

  const repository = createFixtureRepository(directory, personalAge.recipient, mistakenAge.recipient);
  const builderStore = path.join(repository, 'secrets/remote-builder.linux-builder.yaml');
  const personalStore = path.join(repository, 'secrets/linux-builder-client.personal.yaml');
  fs.writeFileSync(builderStore, 'prior-builder-store\n');
  fs.writeFileSync(personalStore, 'prior-personal-store\n');

  const { opPath, logPath } = writeMockOp(directory);
  const script = buildSyncScript();
  const result = childProcess.spawnSync(script, [], {
    cwd: repository,
    encoding: 'utf8',
    env: syncEnvironment({
      opPath,
      logPath,
      builderAge,
      personalAge,
      authorizedKeysFile,
      tailscaleSecret: 'tskey-client-fixture-oauth-secret',
      personalClientKeyFile: personalClient.keyPath,
    }),
    timeout: 120_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the host_linux_builder recipient/);
  assert.equal(fs.readFileSync(builderStore, 'utf8'), 'prior-builder-store\n');
  assert.equal(fs.readFileSync(personalStore, 'utf8'), 'prior-personal-store\n');
});

test('builder sync never generates secret material', () => {
  const sync = sourceText('scripts/linux-builder-sync-from-1password.nix');

  assert.match(sync, /age-keygen -y/);
  assert.match(sync, /--age/);
  assert.match(sync, /host_linux_builder/);
  assert.match(sync, /derived builder recipient does not match/);
  assert.doesNotMatch(sync, /age-keygen -o/);
  assert.doesNotMatch(sync, /ssh-keygen -t/);
  assert.doesNotMatch(sync, /op item create/);
  assert.doesNotMatch(sync, /AGE-SECRET-KEY-1/);
  assert.doesNotMatch(sync, /-----BEGIN OPENSSH PRIVATE KEY-----[A-Za-z0-9+/=]{20,}/);
});
