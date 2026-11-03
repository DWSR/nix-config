'use strict';

// Runbook and declaration-agreement checks for the fabro build-session keys
// (mac-builder-for-fabro-nix-darwin-builds, task 4.2; design "Operator
// Provisioning", "Fabro store", and "Verification"; requirements 6.1, 6.2,
// 6.8, 6.9, 6.10).
//
// `secrets/README.md` is the operator's only instruction for the client key
// pair, so the assertions pin every element the operator needs: key
// generation, both 1Password fields, the manifest sync, the
// `builder-authorized-keys` append, rotation, and the `sops -d --extract`
// verification. The last cases compare the runbook against the design and the
// evaluated guest/builder declarations so the three cannot drift apart.
// No assertion reads, decrypts, or prints a secret value.

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

const CLIENT_KEY = 'build-client-key';
const HOST_KEY = 'build-host-key';
const AUTHORIZED_KEYS = 'builder-authorized-keys';
const CLIENT_SOURCE =
  'op://Infrastructure/Fabro mac-builder Build Credentials/Client Private Key';
const HOST_SOURCE =
  'op://Infrastructure/Fabro mac-builder Build Credentials/Host Public Key';
const FABRO_STORE = 'secrets/fabro.fabro.yaml';
const BUILDER_STORE = 'secrets/remote-builder.mac-builder.yaml';

function readRunbook() {
  return fs.readFileSync(runbookPath, 'utf8');
}

// The runbook section between a heading and the next sibling or parent heading.
function runbookSection(heading) {
  const runbook = readRunbook();
  const start = runbook.indexOf(heading);
  assert.notEqual(start, -1, `missing the "${heading}" runbook section`);

  const nextHeading = /^#{2,3} /gm;
  nextHeading.lastIndex = start + heading.length;
  const next = nextHeading.exec(runbook);
  assert.ok(next, `"${heading}" must end at the next heading`);
  return runbook.slice(start, next.index);
}

function sessionSection() {
  return runbookSection('### Fabro build-session keys');
}

function rotationSection() {
  return runbookSection('### Authorized-key rotation');
}

let cachedDeclarations = null;

function evalDeclarations() {
  if (cachedDeclarations) return cachedDeclarations;

  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  guest = flake.nixosConfigurations."fabro-vm".config;
  builder = flake.darwinConfigurations."mac-builder".config;
  guestSecret = name:
    {
      inherit (guest.sops.secrets.\${name}) path mode owner group restartUnits;
    };
  authorized = builder.sops.secrets.${AUTHORIZED_KEYS};
in
{
  guest = {
    client = guestSecret "${CLIENT_KEY}";
    host = guestSecret "${HOST_KEY}";
    clientUri = guest.fabro.onePasswordSecrets.${CLIENT_KEY};
    hostUri = guest.fabro.onePasswordSecrets.${HOST_KEY};
    clientKeyPath = guest.fabro.darwinBuilder.clientKeyPath;
    hostKeyPath = guest.fabro.darwinBuilder.hostKeyPath;
    fabroStore = toString guest.sops.defaultSopsFile;
  };
  builder = {
    authorized = {
      inherit (authorized) path mode owner group;
      sopsFile = toString authorized.sopsFile;
    };
    activation = builder.system.activationScripts.postActivation.text;
    defaultStore = toString builder.sops.defaultSopsFile;
  };
}
`;

  cachedDeclarations = JSON.parse(childProcess.execFileSync(
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
  return cachedDeclarations;
}

test('the runbook documents key generation, both 1Password fields, and the sync', () => {
  const section = sessionSection();

  assert.match(section, /ssh-keygen -t ed25519/);
  assert.ok(section.includes(CLIENT_SOURCE), `missing 1Password field ${CLIENT_SOURCE}`);
  assert.ok(section.includes(HOST_SOURCE), `missing 1Password field ${HOST_SOURCE}`);
  assert.match(section, /nix run '\.#fabro-sync-from-1password'/);
  assert.ok(section.includes(FABRO_STORE), `missing the fabro store ${FABRO_STORE}`);
  assert.match(
    section,
    /Client Private Key[\s\S]*private/i,
    'the private field must hold the generated private half',
  );
  assert.match(
    section,
    /Host Public Key[\s\S]*ssh_host_ed25519_key\.pub/,
    'the host field must hold the builder host public key',
  );
});

test('the runbook documents appending the public half to builder-authorized-keys', () => {
  const section = sessionSection();

  assert.ok(section.includes(AUTHORIZED_KEYS), 'missing the authorized-keys key name');
  assert.ok(
    section.includes(`sops -d --extract '["${AUTHORIZED_KEYS}"]'`),
    'the append flow must read the existing authorized keys',
  );
  assert.match(section, /cat [^\n]*build-client-key\.pub[^\n]*>>/, 'the append flow must add the public half');
  assert.match(section, /sops set --value-file/);
  assert.ok(
    section.includes(`'["${AUTHORIZED_KEYS}"]'`),
    'the append flow must target the authorized-keys key',
  );
  assert.ok(section.includes(BUILDER_STORE), `missing the builder store ${BUILDER_STORE}`);
  assert.match(section, /SOPS_AGE_KEY_FILE=\/var\/lib\/sops-nix\/key\.txt/);
  assert.match(
    section,
    /preserv|existing|every other/i,
    'the append must preserve the clients already authorized',
  );
});

test('the runbook documents sops -d --extract verification for every key', () => {
  const section = sessionSection();

  assert.ok(section.includes(`sops -d --extract '["${CLIENT_KEY}"]'`));
  assert.ok(section.includes(`sops -d --extract '["${HOST_KEY}"]'`));
  assert.ok(section.includes(`sops -d --extract '["${AUTHORIZED_KEYS}"]'`));
  assert.match(
    section,
    /op:\/\/Private\/sops-age-key-fabro/,
    'the fabro store verification must stage the fabro age key',
  );
  assert.match(
    section,
    /SOPS_AGE_KEY_FILE="\$T\/age-key"/,
    'the fabro store verification must use the staged age key',
  );
  assert.match(section, /never print/i);
  assert.match(section, /ssh-keygen -y -f/, 'the client public half must be derived without printing the key');
});

test('the rotation section covers the new pair, sync, authorized-key replacement, and recipient', () => {
  const section = rotationSection();

  assert.match(section, /ssh-keygen -t ed25519/);
  assert.match(section, /nix run '\.#fabro-sync-from-1password'/);
  assert.ok(section.includes(AUTHORIZED_KEYS));
  assert.match(section, /replace\w* only that key's public half|replace only .*public half/i);
  assert.match(section, /&host_mac_builder/);
  assert.match(section, /preserve (every )?other authorized key/i);
  assert.match(section, /recipient/i);
  assert.match(
    section,
    /new key is accepted[\s\S]*old one is refused|accepted while the old/i,
    'rotation must state which key the builder now accepts',
  );
});

test('the design, guest declarations, and builder declaration agree', () => {
  const design = fs.readFileSync(designPath, 'utf8');
  const provisioning = design.indexOf('## Operator Provisioning');
  assert.notEqual(provisioning, -1, 'design must carry the Operator Provisioning section');
  const provisioningTable = design.slice(provisioning, design.indexOf('\n## ', provisioning + 1));

  for (const [name, source] of [
    [CLIENT_KEY, CLIENT_SOURCE],
    [HOST_KEY, HOST_SOURCE],
    [AUTHORIZED_KEYS, `Public half of \`${CLIENT_KEY}\`, appended to the existing value`],
  ]) {
    assert.ok(
      provisioningTable.includes(`\`${name}\``) && provisioningTable.includes(source),
      `the Operator Provisioning table must name ${name} and its source`,
    );
  }
  assert.ok(provisioningTable.includes(FABRO_STORE));
  assert.ok(provisioningTable.includes(BUILDER_STORE));

  const report = evalDeclarations();

  assert.deepEqual(report.guest.client, {
    path: '/run/secrets/build-client-key',
    mode: '0400',
    owner: 'root',
    group: 'root',
    restartUnits: ['fabro-darwin-builders.service', 'nix-daemon.service'],
  });
  assert.deepEqual(report.guest.host, {
    path: '/run/secrets/build-host-key',
    mode: '0400',
    owner: 'root',
    group: 'root',
    restartUnits: ['fabro-darwin-builders.service', 'nix-daemon.service'],
  });
  assert.equal(report.guest.clientUri, CLIENT_SOURCE);
  assert.equal(report.guest.hostUri, HOST_SOURCE);
  assert.equal(report.guest.clientKeyPath, '/run/secrets/build-client-key');
  assert.equal(report.guest.hostKeyPath, '/run/secrets/build-host-key');
  assert.match(report.guest.fabroStore, /fabro\.fabro\.yaml$/);

  assert.equal(report.builder.authorized.path, '/run/secrets/builder-authorized-keys');
  assert.equal(report.builder.authorized.mode, '0644');
  assert.equal(report.builder.authorized.owner, 'root');
  assert.equal(report.builder.authorized.group, 'wheel');
  assert.match(report.builder.authorized.sopsFile, /remote-builder\.mac-builder\.yaml$/);
  assert.match(report.builder.defaultStore, /remote-builder\.mac-builder\.yaml$/);
  assert.ok(
    report.builder.activation.includes('/run/secrets/builder-authorized-keys'),
    'the builder activation must install the authorized-keys secret',
  );
});

test('no private key material is checked into the tree', () => {
  const files = [
    runbookPath,
    designPath,
    path.join(repoRoot, FABRO_STORE),
    path.join(repoRoot, BUILDER_STORE),
  ];

  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      contents,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      `${path.relative(repoRoot, file)} must not contain a plaintext private key`,
    );
    assert.doesNotMatch(
      contents,
      /\bssh-ed25519 AAAA[A-Za-z0-9+/]{20,}/,
      `${path.relative(repoRoot, file)} must not contain a concrete public key value`,
    );
  }

  for (const store of [FABRO_STORE, BUILDER_STORE]) {
    const contents = fs.readFileSync(path.join(repoRoot, store), 'utf8');
    assert.match(contents, /ENC\[AES256_GCM/, `${store} must stay encrypted`);
  }
});
