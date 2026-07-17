'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { repoRoot } = require('./helpers');

const hostname = 'Brandons-MacBook-Pro.local';
const privatePemHeader = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const certificateDirectory = path.join(repoRoot, 'certificates/local-binary-cache');
const caCertificate = path.join(certificateDirectory, 'ca.pem');
const serverCertificate = path.join(certificateDirectory, 'server.pem');
const jwtPublicKey = path.join(certificateDirectory, 'jwt-public.pem');
const cachePublicKey = path.join(certificateDirectory, 'cache-public-key.txt');
const personalSecrets = path.join(repoRoot, 'secrets/local-binary-cache.personal.yaml');
const shopifySecrets = path.join(repoRoot, 'secrets/local-binary-cache.shopify.yaml');

function run(executable, args) {
  return childProcess.execFileSync(executable, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

function assertExactCreationRules(policy) {
  const lines = policy.split('\n').map(line => line.trimEnd());
  const headers = lines.flatMap((line, index) => {
    const match = line.match(/^  - path_regex: (.+)$/);
    return match === null ? [] : [{ index, path: match[1] }];
  });
  const expectedRules = new Map([
    ['secrets/local-binary-cache\\.personal\\.yaml$', 'host_personal'],
    ['secrets/local-binary-cache\\.shopify\\.yaml$', 'host_shopify'],
  ]);
  const relevantPathLines = lines.filter(
    line => line.includes('path_regex:') && line.includes('local-binary-cache'),
  );
  assert.deepEqual(
    relevantPathLines,
    [...expectedRules.keys()].map(rulePath => `  - path_regex: ${rulePath}`),
    'local cache creation rule headers must be unique and canonical',
  );

  for (const [rulePath, recipientAlias] of expectedRules) {
    const matches = headers.filter(header => header.path === rulePath);
    assert.equal(matches.length, 1, `expected one creation rule for ${rulePath}`);
    const start = matches[0].index;
    const nextHeader = headers.find(header => header.index > start);
    const block = lines
      .slice(start, nextHeader?.index ?? lines.length)
      .filter(line => line.trim() !== '');
    assert.deepEqual(block, [
      `  - path_regex: ${rulePath}`,
      '    key_groups:',
      '      - age:',
      `          - *${recipientAlias}`,
    ], `${rulePath} must have exactly one age key group and recipient`);
  }

  const hostRecipients = new Map();
  for (const alias of expectedRules.values()) {
    const declarations = lines.filter(line => line.includes(`&${alias}`));
    assert.equal(declarations.length, 1, `expected one declaration for ${alias}`);
    const match = declarations[0].match(new RegExp(`^  - &${alias}\\s+(age1[a-z0-9]+)$`));
    assert.notEqual(match, null, `${alias} must resolve to one age recipient`);
    hostRecipients.set(alias, match[1]);
  }
  assert.notEqual(
    hostRecipients.get('host_personal'),
    hostRecipients.get('host_shopify'),
    'personal and Shopify recipients must remain distinct',
  );
}

function certificateExtensionValues(details, extensionName) {
  const lines = details.split('\n');
  const heading = `X509v3 ${extensionName}:`;
  const headings = lines.flatMap((line, index) => (
    line.trim().startsWith(heading) ? [index] : []
  ));
  assert.equal(headings.length, 1, `server leaf must contain one ${extensionName} extension`);
  const headingIndex = headings[0];
  const headingIndent = lines[headingIndex].search(/\S/);
  const valueLines = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.trim() === '') {
      continue;
    }
    if (line.search(/\S/) <= headingIndent) {
      break;
    }
    valueLines.push(line.trim());
  }
  assert.notEqual(valueLines.length, 0, `${extensionName} extension is empty`);
  return valueLines.join(' ').split(/,\s*/);
}

function assertExactLeafIdentity(details) {
  assert.match(details, /Basic Constraints: critical\s+CA:FALSE/);
  assert.deepEqual(
    certificateExtensionValues(details, 'Subject Alternative Name'),
    [`DNS:${hostname}`],
    'server leaf SAN set must contain only the declared DNS hostname',
  );
  assert.deepEqual(
    certificateExtensionValues(details, 'Extended Key Usage'),
    ['TLS Web Server Authentication'],
    'server leaf extended key usage must contain only server authentication',
  );
}

function assertRs256Verifier(details, algorithmDetails) {
  assert.match(details, /Public-Key: \((?:2048|3072|4096) bit\)/);
  const algorithms = [...algorithmDetails.matchAll(/\bOBJECT\s+:([^\s]+)\s*$/gm)]
    .map(match => match[1]);
  assert.deepEqual(
    algorithms,
    ['rsaEncryption'],
    'JWT verifier algorithm must be rsaEncryption for RS256',
  );
}

function replaceOnce(value, original, replacement) {
  assert.equal(value.split(original).length, 2, `fixture does not contain exactly one ${original}`);
  return value.replace(original, replacement);
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

test('committed public identity bundle has the exact Stage 0 contract', () => {
  for (const artifact of [caCertificate, serverCertificate, jwtPublicKey]) {
    assert.equal(fs.existsSync(artifact), true, `missing public identity: ${artifact}`);
  }
  assert.equal(fs.existsSync(cachePublicKey), false, 'cache identity belongs to Task 5.3');

  const caText = fs.readFileSync(caCertificate, 'utf8');
  const serverText = fs.readFileSync(serverCertificate, 'utf8');
  const jwtText = fs.readFileSync(jwtPublicKey, 'utf8');
  assert.equal((caText.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length, 1);
  assert.equal((serverText.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length, 1);
  assert.match(jwtText, /^-----BEGIN PUBLIC KEY-----$/m);

  const caDetails = run('openssl', ['x509', '-in', caCertificate, '-noout', '-text']);
  assert.match(caDetails, /Basic Constraints: critical\s+CA:TRUE/);
  assert.match(caDetails, /Key Usage: critical\s+Certificate Sign, CRL Sign/);

  const leafDetails = run('openssl', ['x509', '-in', serverCertificate, '-noout', '-text']);
  assertExactLeafIdentity(leafDetails);

  const verified = run('openssl', [
    'verify',
    '-CAfile', caCertificate,
    '-purpose', 'sslserver',
    '-verify_hostname', hostname,
    serverCertificate,
  ]);
  assert.match(verified, /server\.pem: OK/);

  const jwtDetails = run('openssl', ['pkey', '-pubin', '-in', jwtPublicKey, '-text_pub', '-noout']);
  const jwtAlgorithmDetails = run('openssl', ['asn1parse', '-in', jwtPublicKey, '-inform', 'PEM', '-i']);
  assertRs256Verifier(jwtDetails, jwtAlgorithmDetails);
});

test('public identity validation rejects every extra SAN', () => {
  const details = run('openssl', ['x509', '-in', serverCertificate, '-noout', '-text']);
  const withIpSan = replaceOnce(
    details,
    `DNS:${hostname}`,
    `DNS:${hostname}, IP Address:127.0.0.1`,
  );
  assert.throws(() => assertExactLeafIdentity(withIpSan), /SAN/);
});

test('public identity validation rejects every extra EKU', () => {
  const details = run('openssl', ['x509', '-in', serverCertificate, '-noout', '-text']);
  const withClientAuth = replaceOnce(
    details,
    'TLS Web Server Authentication',
    'TLS Web Server Authentication, TLS Web Client Authentication',
  );
  assert.throws(() => assertExactLeafIdentity(withClientAuth), /extended key usage/i);
});

test('public identity validation rejects an RSA-PSS verifier', () => {
  const details = run('openssl', ['pkey', '-pubin', '-in', jwtPublicKey, '-text_pub', '-noout']);
  const algorithmDetails = run('openssl', ['asn1parse', '-in', jwtPublicKey, '-inform', 'PEM', '-i']);
  const rsaPssAlgorithm = replaceOnce(algorithmDetails, ':rsaEncryption', ':rsassaPss');
  assert.throws(() => assertRs256Verifier(details, rsaPssAlgorithm), /rsaEncryption/);
});

test('cache identity creation rules are exact and remain host-isolated', () => {
  const policy = fs.readFileSync(path.join(repoRoot, '.sops.yaml'), 'utf8');
  assertExactCreationRules(policy);
});

test('cache identity creation rules reject every additional recipient form', () => {
  const policy = fs.readFileSync(path.join(repoRoot, '.sops.yaml'), 'utf8');
  const shopifyRecipient = policy.match(/^\s+- &host_shopify\s+(age1[a-z0-9]+)$/m)?.[1];
  assert.notEqual(shopifyRecipient, undefined, 'Shopify age recipient is missing');
  const personalAlias = '          - *host_personal';
  const personalRule = [
    '  - path_regex: secrets/local-binary-cache\\.personal\\.yaml$',
    '    key_groups:',
    '      - age:',
    personalAlias,
  ].join('\n');
  for (const additionalRecipient of [
    '          - *host_shopify',
    `          - ${shopifyRecipient}`,
    '      - pgp:\n          - 0123456789ABCDEF0123456789ABCDEF01234567',
  ]) {
    const mutated = replaceOnce(
      policy,
      personalRule,
      `${personalRule}\n${additionalRecipient}`,
    );
    assert.throws(() => assertExactCreationRules(mutated));
  }
});

test('cache identity creation rules reject duplicate or malformed relevant rules', () => {
  const policy = fs.readFileSync(path.join(repoRoot, '.sops.yaml'), 'utf8');
  const personalRule = [
    '  - path_regex: secrets/local-binary-cache\\.personal\\.yaml$',
    '    key_groups:',
    '      - age:',
    '          - *host_personal',
  ].join('\n');
  assert.throws(() => assertExactCreationRules(`${policy}\n${personalRule}\n`));
  assert.throws(() => assertExactCreationRules(replaceOnce(
    policy,
    `${personalRule.split('\n')[0]}\n    key_groups:`,
    `${personalRule.split('\n')[0]}\n    malformed_key_groups:`,
  )));
});

test('personal runtime identities are SOPS ciphertext with one personal recipient', () => {
  assert.equal(fs.existsSync(personalSecrets), true, 'missing encrypted personal identity store');
  assert.equal(fs.existsSync(shopifySecrets), false, 'Shopify token store belongs to Task 5.3');

  const encrypted = fs.readFileSync(personalSecrets, 'utf8');
  const policy = fs.readFileSync(path.join(repoRoot, '.sops.yaml'), 'utf8');
  const personalRecipient = policy.match(/^\s+- &host_personal (age1[a-z0-9]+)$/m)?.[1];
  assert.notEqual(personalRecipient, undefined, 'personal age recipient is missing');
  const topLevelEntries = new Map(
    [...encrypted.matchAll(/^([a-z][a-z0-9-]*):\s*(.*)$/gm)].map(match => [match[1], match[2]]),
  );
  assert.deepEqual(
    [...topLevelEntries.keys()].filter(key => key !== 'sops').sort(),
    ['local-binary-cache-jwt-private-key', 'local-binary-cache-tls-key'],
  );
  for (const key of ['local-binary-cache-jwt-private-key', 'local-binary-cache-tls-key']) {
    assert.match(topLevelEntries.get(key), /^ENC\[AES256_GCM,/);
  }
  assert.deepEqual(
    [...encrypted.matchAll(/^\s+recipient: (age1[a-z0-9]+)$/gm)].map(match => match[1]),
    [personalRecipient],
  );
  assert.equal(privatePemHeader.test(encrypted), false);

  const status = JSON.parse(run('sops', ['filestatus', personalSecrets]));
  assert.equal(status.encrypted, true);
});

test('runbook fixes the secret names, consumers, ownership, and mode before host wiring', () => {
  const runbook = fs.readFileSync(path.join(repoRoot, 'secrets/README.md'), 'utf8');
  const section = runbook.indexOf('## Local binary cache identity lifecycle');
  assert.ok(section >= 0, 'missing local binary cache identity lifecycle runbook');

  const generation = runbook.indexOf('### Generation', section);
  const bootstrap = runbook.indexOf('### Bootstrap ordering', section);
  const rotation = runbook.indexOf('### Rotation ordering', section);
  const recovery = runbook.indexOf('### Recovery ordering', section);
  assert.ok(section < generation && generation < bootstrap && bootstrap < rotation && rotation < recovery);

  assert.match(
    runbook,
    /`local-binary-cache-tls-key`[^\n]*login user[^\n]*`0400`/,
  );
  assert.match(
    runbook,
    /`local-binary-cache-jwt-private-key`[^\n]*root[^\n]*`0400`/,
  );
  assert.match(runbook, /Task 5\.2[^\n]*`sops\.secrets`/);
});

test('repository contains no plaintext private PEM artifact', () => {
  const leaks = [];

  for (const file of repositoryFiles(repoRoot)) {
    const contents = fs.readFileSync(file);
    if (contents.includes(0)) {
      continue;
    }
    if (privatePemHeader.test(contents.toString('utf8'))) {
      leaks.push(path.relative(repoRoot, file));
    }
  }

  assert.deepEqual(leaks, []);
});
