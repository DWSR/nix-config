'use strict';

// Runbook and declaration-agreement checks for the fabro build-session keys
// (mac-builder-for-fabro-nix-darwin-builds, task 4.2; design "Operator
// Provisioning", "Data Models → Fabro Secret Store Additions" and "Builder
// Secret Store Addition"; requirements 6.1, 6.2, 6.8, 6.9, 6.10).
//
// `secrets/README.md` is the operator's only instruction for this key pair, so
// the assertions pin every element the operator needs: key generation, the two
// 1Password fields, the sync, the `builder-authorized-keys` append, rotation,
// and the `sops -d --extract` verification. The same cases compare the runbook
// with the evaluated guest `sops.secrets`, the builder's authorized-key
// declaration, and the design's provisioning table. No assertion reads,
// decrypts, or prints a key value.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const runbookPath = path.join(repoRoot, 'secrets/README.md');
const designPath = path.join(
  repoRoot,
  '.kiro/specs/mac-builder-for-fabro-nix-darwin-builds/design.md',
);
const NIX_TIMEOUT_MS = 600_000;

const clientKeyUri =
  'op://Infrastructure/Fabro mac-builder Build Credentials/Client Private Key';
const hostKeyUri =
  'op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key';

const BUILD_SECRETS = [
  {
    name: 'build-client-key',
    uri: clientKeyUri,
    runtimePath: '/run/secrets/build-client-key',
    consumer: 'nix-daemon',
  },
  {
    name: 'build-host-key',
    uri: hostKeyUri,
    runtimePath: '/run/secrets/build-host-key',
    consumer: 'fabro-darwin-machines',
  },
];

const BUILDER_AUTHORIZED_KEYS_PATH = '/run/secrets/builder-authorized-keys';
const BUILDER_STORE = 'secrets/remote-builder.mac-builder.yaml';
const FABRO_STORE = 'secrets/fabro.fabro.yaml';

// The runbook section between its heading and the next sibling heading.
function section(heading) {
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const start = runbook.indexOf(heading);
  assert.notEqual(start, -1, `missing the "${heading}" runbook section`);

  const end = runbook.indexOf('\n### ', start + heading.length);
  assert.notEqual(end, -1, `"${heading}" must end at the next subsection`);
  return runbook.slice(start, end);
}

function buildKeysSection() {
  return section('### Fabro build-session keys');
}

function rotationSection() {
  return section('### Authorized-key rotation');
}

let cachedReport = null;

function hostReport() {
  if (cachedReport) return cachedReport;

  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  guest = flake.nixosConfigurations."fabro-vm".config;
  builder = flake.darwinConfigurations."mac-builder".config;
  secret = name:
    let s = guest.sops.secrets.\${name}; in
    {
      inherit (s) path mode owner group restartUnits;
      sopsFile = toString s.sopsFile;
    };
  builderSecret = builder.sops.secrets."builder-authorized-keys";
in
{
  guestSecrets = builtins.listToAttrs (
    map (name: {
      inherit name;
      value = secret name;
    }) [ "build-client-key" "build-host-key" ]
  );
  onePasswordSecrets = guest.fabro.onePasswordSecrets;
  rendererExec =
    guest.systemd.services.fabro-darwin-builders.serviceConfig.ExecStart;
  builderAuthorizedKeys = {
    path = builderSecret.path;
    inherit (builderSecret) mode owner group;
    sopsFile = toString builderSecret.sopsFile;
  };
  builderActivations = builtins.concatStringsSep "\\n" (
    builtins.attrNames builder.system.activationScripts
  );
}`;

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

test('the runbook documents ed25519 key generation outside the checkout', () => {
  const text = buildKeysSection();

  assert.match(text, /ssh-keygen -t ed25519/, 'must document the ed25519 generation command');
  assert.match(text, /-N ''/, 'the build key must be generated without a passphrase');
  assert.match(
    text,
    /outside the checkout|outside this (checkout|repository)|not in the (checkout|repository)/i,
    'the private half must be generated outside the working tree',
  );
  assert.match(
    text,
    /never (commit|check in)|do not commit|never checked in/i,
    'the runbook must say the private half is never committed',
  );
});

test('the runbook names both 1Password fields and what each half holds', () => {
  const text = buildKeysSection();

  assert.ok(text.includes(clientKeyUri), `missing 1Password source ${clientKeyUri}`);
  assert.ok(text.includes(hostKeyUri), `missing 1Password source ${hostKeyUri}`);
  assert.match(
    text,
    /private half|Client Private Key/i,
    'the client item must be documented as the private half',
  );
  assert.match(
    text,
    /host_ed25519_key\.pub|host public key/i,
    'the host item must be documented as the builder host public key',
  );
  assert.match(text, /`build-client-key`/);
  assert.match(text, /`build-host-key`/);
});

test('the runbook documents the fabro-sync refresh', () => {
  const text = buildKeysSection();

  assert.match(text, /nix run '\.#fabro-sync-from-1password'/);
  assert.match(
    text,
    /aborts?|refuses?|leaves? the store untouched/i,
    'the runbook must state that the sync aborts instead of dropping a declared key',
  );
});

test('the runbook documents the builder-authorized-keys append without printing values', () => {
  const text = buildKeysSection();

  assert.match(text, /builder-authorized-keys/, 'must document the authorized-key append');
  assert.ok(text.includes(BUILDER_STORE), `the append must target ${BUILDER_STORE}`);
  assert.match(
    text,
    /sops -d --extract '\["builder-authorized-keys"\]'/,
    'the append must decrypt the existing authorized keys',
  );
  assert.match(
    text,
    />>|append/i,
    'the append must extend the existing value rather than replace it',
  );
  assert.match(
    text,
    /\.pub/,
    'only the public half of the client key may be appended',
  );
  assert.match(text, /sops set --value-file/);
  assert.ok(text.includes(`'["builder-authorized-keys"]'`));
  assert.match(text, /SOPS_AGE_KEY_FILE=\/var\/lib\/sops-nix\/key\.txt/);
  assert.match(
    text,
    /preserv|never drop|keep(s)? the other|existing (authorized )?keys/i,
    'the append must preserve the other authorized keys',
  );
});

test('the runbook table names the runtime path, mode, owner, and consumer', () => {
  const text = buildKeysSection();

  for (const secret of BUILD_SECRETS) {
    assert.ok(text.includes(secret.runtimePath), `missing runtime path ${secret.runtimePath}`);
    assert.ok(text.includes(secret.consumer), `missing consumer ${secret.consumer}`);
  }

  assert.match(text, /`0400`/);
  assert.match(text, /root:root|owner\s+`root`/);
  assert.match(text, /fabro-darwin-builders\.service/);
  assert.match(text, /nix-daemon\.service/);
});

test('the runbook documents the sops -d --extract verification for both stores', () => {
  const text = buildKeysSection();

  for (const secret of BUILD_SECRETS) {
    assert.ok(
      text.includes(`sops -d --extract '["${secret.name}"]'`),
      `missing the ${secret.name} verification command`,
    );
  }

  assert.ok(text.includes(FABRO_STORE), 'the fabro store verification must target its file');
  assert.ok(
    text.includes(`sops -d --extract '["builder-authorized-keys"]'`),
    'the builder store verification must target its authorized-key list',
  );
  assert.match(text, /\| wc -c|\| wc -l|ssh-keygen -l -f \/dev\/stdin/, 'verification must inspect shape without printing the value');
  assert.match(text, /never print|without printing|not print/i);
});

test('the runbook keeps the verification temp dir until after the fingerprint check', () => {
  const text = buildKeysSection();
  const start = text.indexOf('Verify both stores without printing a value');
  assert.notEqual(start, -1, 'missing the verification step');

  const verification = text.slice(start);
  const cleanup = verification.indexOf('rm -rf "$T"');
  assert.notEqual(cleanup, -1, 'the verification step must clean up its temp dir');
  assert.equal(
    verification.indexOf('rm -rf "$T"', cleanup + 1),
    -1,
    'the verification step must clean up exactly once',
  );

  const lastStagedKeyUse = verification.lastIndexOf('"$T/');
  assert.notEqual(lastStagedKeyUse, -1, 'the verification step must stage the age key in $T');
  assert.ok(
    lastStagedKeyUse < cleanup,
    'the staged age key must stay readable until the last sops/ssh-keygen use completes',
  );
  assert.ok(
    verification.indexOf('ssh-keygen -l -f /dev/stdin') < cleanup,
    'the host-key fingerprint check must precede the temp-dir cleanup',
  );
});

test('the runbook documents rotation end to end', () => {
  const text = rotationSection();

  assert.match(text, /ssh-keygen -t ed25519/, 'rotation must generate a new pair');
  assert.match(text, /nix run '\.#fabro-sync-from-1password'/, 'rotation must refresh the fabro store');
  assert.match(text, /replace|swap/i, 'rotation must replace the old public half');
  assert.match(text, /builder-authorized-keys/);
  assert.ok(text.includes(BUILDER_STORE));
  assert.match(
    text,
    /updatekeys|re-encrypt/,
    'rotation must re-encrypt the builder store against its recipient',
  );
  assert.match(
    text,
    /restart|switch|redeploy|deploy/i,
    'rotation must say the new material is applied by a switch/restart',
  );
  assert.match(
    text,
    /refuse|reject|denied/i,
    'rotation must confirm the retired key is refused',
  );
});

test('the runbook matches the evaluated guest secret declarations', () => {
  const report = hostReport();

  for (const expected of BUILD_SECRETS) {
    const declared = report.guestSecrets[expected.name];

    assert.equal(declared.path, expected.runtimePath, `sops.secrets.${expected.name}.path`);
    assert.equal(declared.mode, '0400', `sops.secrets.${expected.name}.mode`);
    assert.equal(declared.owner, 'root', `sops.secrets.${expected.name}.owner`);
    assert.equal(declared.group, 'root', `sops.secrets.${expected.name}.group`);
    assert.ok(
      declared.sopsFile.endsWith(FABRO_STORE),
      `sops.secrets.${expected.name} must come from ${FABRO_STORE}, got ${declared.sopsFile}`,
    );
    assert.deepEqual(
      [...declared.restartUnits].sort(),
      ['fabro-darwin-builders.service', 'nix-daemon.service'],
      `sops.secrets.${expected.name}.restartUnits`,
    );
    assert.equal(
      report.onePasswordSecrets[expected.name],
      expected.uri,
      `fabro.onePasswordSecrets.${expected.name} must match the runbook source`,
    );
    assert.ok(
      report.rendererExec.includes(expected.runtimePath),
      `the renderer must consume ${expected.name} by path`,
    );
  }
});

test('the runbook matches the builder authorized-key declaration', () => {
  const report = hostReport();
  const declared = report.builderAuthorizedKeys;

  assert.equal(declared.path, BUILDER_AUTHORIZED_KEYS_PATH);
  assert.equal(declared.mode, '0644');
  assert.equal(declared.owner, 'root');
  assert.equal(declared.group, 'wheel');
  assert.ok(
    declared.sopsFile.endsWith(BUILDER_STORE),
    `builder-authorized-keys must come from ${BUILDER_STORE}, got ${declared.sopsFile}`,
  );
  assert.match(report.builderActivations, /builder-authorized-keys|postActivation/);
});

test('the design provisioning table names every key and its owner', () => {
  const design = fs.readFileSync(designPath, 'utf8');
  const provisioning = design.indexOf('## Operator Provisioning');
  assert.notEqual(provisioning, -1, 'design must carry the Operator Provisioning section');

  const table = design.slice(provisioning, design.indexOf('\n### ', provisioning));

  for (const secret of BUILD_SECRETS) {
    assert.ok(
      table.includes(
        `| \`${secret.name}\` | \`${secret.uri}\` | \`${FABRO_STORE}\` |`,
      ),
      `the Operator Provisioning table must name ${secret.name}, its source, and its store`,
    );
  }

  assert.match(
    table,
    /\| `builder-authorized-keys` \| Public half of `build-client-key`, appended to the existing value \| `secrets\/remote-builder\.mac-builder\.yaml` \| Builder operator \|/,
    'the table must document the authorized-key append, its store, and its owner',
  );

  for (const secret of BUILD_SECRETS) {
    assert.match(
      design,
      new RegExp(`\\| \`${secret.name}\` \\|[^\\n]*\\| \`${secret.runtimePath}\` \\| \`0400\` root:root \\| \`${secret.consumer}\``),
      `the design secret-store table must agree on ${secret.name}'s path, mode, and consumer`,
    );
  }
});

test('no key material is checked into the working tree', () => {
  for (const file of [runbookPath, designPath, path.join(repoRoot, FABRO_STORE)]) {
    const contents = fs.readFileSync(file, 'utf8');

    assert.doesNotMatch(
      contents,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      `${path.relative(repoRoot, file)} must not contain a private key block`,
    );
    assert.doesNotMatch(
      contents,
      /ssh-ed25519\s+AAAA[A-Za-z0-9+/=]{40,}/,
      `${path.relative(repoRoot, file)} must not contain a public key blob`,
    );
  }

  const store = fs.readFileSync(path.join(repoRoot, FABRO_STORE), 'utf8');
  for (const secret of BUILD_SECRETS) {
    const line = store.split('\n').find((candidate) => candidate.startsWith(`${secret.name}:`));

    if (line === undefined) continue; // Provisioned by the operator, not by this task.

    assert.match(
      line,
      new RegExp(`^${secret.name}: ENC\\[`),
      `${secret.name} must only appear encrypted in the working tree`,
    );
  }
});
