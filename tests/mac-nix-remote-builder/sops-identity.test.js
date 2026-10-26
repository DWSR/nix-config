'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
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

function builderRecipient(policy) {
  const declarations = policy.split('\n').filter(line => line.includes('&host_mac_builder'));
  assert.equal(declarations.length, 1, 'expected exactly one &host_mac_builder declaration');
  const match = declarations[0].match(/^  - &host_mac_builder\s+(age1[a-z0-9]+)$/);
  assert.notEqual(match, null, '&host_mac_builder must resolve to one age recipient');
  return match[1];
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

test('builder recipient round-trips from the stored private key', (t) => {
  const keyFile = process.env.MAC_BUILDER_AGE_KEY_FILE;
  if (keyFile === undefined) {
    t.skip('set MAC_BUILDER_AGE_KEY_FILE to the builder private key and run under `nix shell nixpkgs#age`');
    return;
  }
  assert.equal(fs.existsSync(keyFile), true, `missing builder private key: ${keyFile}`);

  const recipient = builderRecipient(read('.sops.yaml'));
  const derived = childProcess.execFileSync(
    'age-keygen',
    ['-y', keyFile],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  ).trim();
  assert.equal(derived, recipient, 'builder recipient must derive from the stored private key');
});
