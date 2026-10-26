'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const runbookPath = path.join(repoRoot, 'secrets/README.md');

const builderRulePath = 'secrets/remote-builder\\.mac-builder\\.yaml$';
const builderStorePath = 'secrets/remote-builder.mac-builder.yaml';
const builderAgeItem = 'op://Private/sops-age-key-mac-builder';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    BECH32_GENERATOR.forEach((generator, index) => {
      if ((top >> index) & 1) {
        checksum ^= generator;
      }
    });
  }
  return checksum;
}

// An age recipient is a bech32 string with the `age` prefix whose payload is a
// 32-byte X25519 public key. Decoding it catches a truncated, mis-copied, or
// otherwise corrupted anchor without needing the private key.
function assertValidAgeRecipient(value) {
  assert.equal(typeof value, 'string', 'age recipient must be a string');
  assert.match(value, /^age1[02-9ac-hj-np-z]+$/, `age recipient is not bech32: ${value}`);

  const separator = value.lastIndexOf('1');
  const humanReadablePart = value.slice(0, separator);
  assert.equal(humanReadablePart, 'age', `age recipient must use the age prefix: ${value}`);

  const data = [...value.slice(separator + 1)].map((character) => {
    const index = BECH32_CHARSET.indexOf(character);
    assert.notEqual(index, -1, `age recipient is not bech32: ${value}`);
    return index;
  });
  assert.ok(data.length > 6, `age recipient is too short: ${value}`);

  const expandedPrefix = [
    ...[...humanReadablePart].map(character => character.charCodeAt(0) >> 5),
    0,
    ...[...humanReadablePart].map(character => character.charCodeAt(0) & 31),
  ];
  assert.equal(
    bech32Polymod([...expandedPrefix, ...data]),
    1,
    `age recipient bech32 checksum mismatch: ${value}`,
  );

  let accumulator = 0;
  let bits = 0;
  const payload = [];
  for (const value5 of data.slice(0, -6)) {
    accumulator = (accumulator << 5) | value5;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      payload.push((accumulator >> bits) & 0xff);
    }
  }
  assert.equal(accumulator & ((1 << bits) - 1), 0, `age recipient has non-zero padding: ${value}`);
  assert.equal(payload.length, 32, `age recipient must encode a 32-byte X25519 key: ${value}`);

  return value;
}

// The stored private key is the 1Password Secure Note; a local file is accepted
// for offline verification. A missing source skips the round trip rather than
// failing, because enrollment is an operator action.
function resolveStoredKey() {
  const override = process.env.MAC_BUILDER_AGE_KEY_FILE;
  if (override !== undefined && override !== '') {
    assert.equal(fs.existsSync(override), true, `missing builder private key: ${override}`);
    return { keyFile: override, cleanup: () => {} };
  }

  const probe = childProcess.spawnSync('op', ['--version'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }

  const stored = childProcess.spawnSync('op', ['read', `${builderAgeItem}/notesPlain`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(
    stored.status,
    0,
    `op read ${builderAgeItem} failed: ${String(stored.stderr).trim()}`,
  );
  assert.match(
    stored.stdout,
    /AGE-SECRET-KEY-1[0-9A-Z]+/,
    `the ${builderAgeItem} note must hold an age secret key`,
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builder-age-key-'));
  const keyFile = path.join(directory, 'key.txt');
  fs.writeFileSync(keyFile, stored.stdout, { mode: 0o600 });
  return { keyFile, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function builderRecipient(policy) {
  const declarations = policy.split('\n').filter(line => line.includes('&host_mac_builder'));
  assert.equal(declarations.length, 1, 'expected exactly one &host_mac_builder declaration');
  const match = declarations[0].match(/^  - &host_mac_builder\s+(age1[a-z0-9]+)$/);
  assert.notEqual(match, null, '&host_mac_builder must resolve to one age recipient');
  return match[1];
}

function repositoryFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.direnv', 'node_modules', 'result'].includes(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...repositoryFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function assertBuilderCreationRule(policy) {
  const lines = policy.split('\n').map(line => line.trimEnd());
  const headers = lines.flatMap((line, index) => {
    const match = line.match(/^  - path_regex: (.+)$/);
    return match === null ? [] : [{ index, path: match[1] }];
  });
  const matches = headers.filter(header => header.path === builderRulePath);
  assert.equal(matches.length, 1, `expected exactly one creation rule for ${builderRulePath}`);

  const nextHeader = headers.find(header => header.index > matches[0].index);
  const block = lines
    .slice(matches[0].index, nextHeader?.index ?? lines.length)
    .filter(line => line.trim() !== '');
  assert.deepEqual(block, [
    `  - path_regex: ${builderRulePath}`,
    '    key_groups:',
    '      - age:',
    '          - *host_mac_builder',
  ], 'builder creation rule must list exactly the builder recipient');
}

test('.sops.yaml parses with the builder anchor and its isolated creation rule', () => {
  const policy = read('.sops.yaml');
  const recipient = builderRecipient(policy);
  assertBuilderCreationRule(policy);

  assert.equal(
    policy.split(recipient).length - 1,
    1,
    'builder recipient must not be shared with another host anchor or rule',
  );
});

test('runbook names the builder store, key item, bootstrap order, and rotation', () => {
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const sectionStart = runbook.indexOf('## Builder host store (mac-builder)');
  assert.ok(sectionStart >= 0, 'missing "## Builder host store (mac-builder)" section');
  const nextSection = runbook.indexOf('\n## ', sectionStart + 1);
  const section = runbook.slice(sectionStart, nextSection === -1 ? undefined : nextSection);

  assert.match(section, new RegExp(builderStorePath.replace(/\./g, '\\.')));
  assert.match(section, new RegExp(builderAgeItem.replace(/\./g, '\\.')));
  assert.match(section, /\/var\/lib\/sops-nix\/key\.txt/);

  const bootstrapStart = section.indexOf('### Bootstrap ordering');
  assert.ok(bootstrapStart >= 0, 'missing builder bootstrap ordering subsection');
  const bootstrap = section.slice(
    bootstrapStart,
    section.indexOf('### Authorized-key rotation', bootstrapStart),
  );
  assert.match(
    bootstrap,
    /before the first (?:`?darwin-rebuild`? )?switch/i,
    'bootstrap ordering must install the age key before the first switch',
  );

  const rotationStart = section.indexOf('### Authorized-key rotation');
  assert.ok(rotationStart >= 0, 'missing authorized-key rotation subsection');
  const rotation = section.slice(rotationStart);
  assert.match(rotation, /builder-authorized-keys/);
  assert.match(rotation, /re-encrypt|updatekeys/i);
});

test('builder recipient is a well-formed, host-isolated age recipient', () => {
  const policy = read('.sops.yaml');
  const recipient = builderRecipient(policy);
  assertValidAgeRecipient(recipient);

  for (const alias of ['host_personal', 'host_fabro']) {
    const declaration = policy.match(new RegExp(`^  - &${alias}\\s+(age1[a-z0-9]+)$`, 'm'));
    assert.notEqual(declaration, null, `missing &${alias} declaration in .sops.yaml`);
    assert.notEqual(
      recipient,
      declaration[1],
      `builder recipient must not equal the ${alias} recipient`,
    );
  }

  assert.equal(
    policy.split(recipient).length - 1,
    1,
    'builder recipient must appear only in its own anchor and rule',
  );
});

test('builder recipient validation rejects corrupted recipients', () => {
  const recipient = builderRecipient(read('.sops.yaml'));

  assert.doesNotThrow(() => assertValidAgeRecipient(recipient));

  const lastCharacter = recipient.slice(-1);
  const corruptedChecksum = `${recipient.slice(0, -1)}${lastCharacter === 'q' ? 'p' : 'q'}`;
  assert.throws(() => assertValidAgeRecipient(corruptedChecksum), /checksum/i);

  const corruptedPayload = `${recipient.slice(0, 20)}${recipient[20] === 'q' ? 'p' : 'q'}${recipient.slice(21)}`;
  assert.throws(() => assertValidAgeRecipient(corruptedPayload), /checksum/i);

  assert.throws(() => assertValidAgeRecipient('age1notarecipient'), /bech32|payload|checksum/i);
  assert.throws(() => assertValidAgeRecipient('ssh-ed25519 AAAA'), /bech32/i);
});

test('builder recipient round-trips from the stored private key', (t) => {
  const stored = resolveStoredKey();
  if (stored === null) {
    t.skip(
      'no stored builder key: set MAC_BUILDER_AGE_KEY_FILE, or sign in to `op` for '
      + `${builderAgeItem}, then run under \`nix shell nixpkgs#age\``,
    );
    return;
  }
  t.after(stored.cleanup);

  const recipient = builderRecipient(read('.sops.yaml'));
  const derived = childProcess.execFileSync(
    'age-keygen',
    ['-y', stored.keyFile],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  ).trim();
  assert.equal(derived, recipient, 'builder recipient must derive from the stored private key');
});

test('repository contains no age private key material', () => {
  const leaked = repositoryFiles(repoRoot)
    .filter((file) => {
      const contents = fs.readFileSync(file);
      return !contents.includes(0) && /AGE-SECRET-KEY-1[0-9A-Z]{58}/.test(contents.toString('utf8'));
    })
    .map(file => path.relative(repoRoot, file));
  assert.deepEqual(leaked, [], 'age private keys must stay in 1Password, never in the repository');
});
