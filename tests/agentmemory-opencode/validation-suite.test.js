'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const runnerPath = path.join(__dirname, 'index.js');
const flakePath = path.join(repoRoot, 'flake.nix');

test('the feature runner registers every AgentMemory test except Pi compatibility', () => {
  const runner = fs.readFileSync(runnerPath, 'utf8');
  const expectedTests = fs.readdirSync(__dirname)
    .filter((name) => /\.test\.(?:js|cjs|mjs)$/.test(name))
    .filter((name) => name !== 'pi-compatibility.test.mjs')
    .sort();

  for (const testFile of expectedTests) {
    assert.match(runner, new RegExp(`['"](?:\\./)?${testFile.replaceAll('.', '\\.')}['"]`));
  }
  assert.doesNotMatch(runner, /pi-compatibility\.test\.mjs/);
});

test('the feature gate contains no Pi acceptance criteria', () => {
  const featureFiles = fs.readdirSync(__dirname)
    .filter((name) => /\.test\.(?:js|cjs|mjs)$/.test(name))
    .filter((name) => !['pi-compatibility.test.mjs', 'validation-suite.test.js'].includes(name));
  featureFiles.push(
    ...fs.readdirSync(__dirname).filter((name) => name.endsWith('.nix')),
    'fixtures/cavemem-import-fixture.js',
  );

  for (const featureFile of featureFiles) {
    const source = fs.readFileSync(path.join(__dirname, featureFile), 'utf8');
    assert.doesNotMatch(source, /\bpi\b/i, `${featureFile} contains Pi acceptance logic`);
  }
});

test('the core MCP registration rejects every undeclared environment variable', () => {
  const source = fs.readFileSync(path.join(__dirname, 'core-surface.test.js'), 'utf8');

  assert.match(source, /assert\.deepEqual\(rendered\.agentmemoryServer\.env,\s*\{/);
});

test('the suite validates personal evaluation and activation with missing bearer ciphertext', () => {
  for (const relativePath of [
    'activation-secret.test.js',
    'missing-secret-activation.nix',
    'personal-secret-validation.nix',
    'fixtures/missing-agentmemory-bearer.yaml',
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, relativePath)), true, `${relativePath} is missing`);
  }

  const runner = fs.readFileSync(runnerPath, 'utf8');
  assert.match(runner, /['"]activation-secret\.test\.js['"]/);
});

test('the canonical flake check runs the complete suite with packaged runtimes', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');

  assert.match(flake, /node tests\/agentmemory-opencode\/index\.js/);
  assert.match(flake, /AGENTMEMORY_PACKAGE_PATH/);
  assert.match(flake, /AGENTMEMORY_MISSING_SECRET_ACTIVATION_PROOF/);
  assert.match(flake, /MCPPROXY_PACKAGE_PATH/);
  assert.match(flake, /AGENTMEMORY_IMPORTER_NODE_BIN/);
  assert.match(flake, /AGENTMEMORY_IMPORTER_NODE_PATH/);
  assert.match(flake, /AGENTMEMORY_IMPORTER_BIN/);
  assert.match(flake, /AGENTMEMORY_CONFIGURED_IMPORTER_BIN/);
  assert.match(flake, /AGENTMEMORY_CONFIGURED_IMPORTER_ENDPOINT/);
  assert.match(flake, /pkgs\.sqlite/);
  assert.match(flake, /pkgs\.which/);
  assert.doesNotMatch(
    flake,
    /node --test tests\/agentmemory-opencode\/matrix\.test\.js/,
  );
});

test('the local feature runner detaches linked worktrees before resolving flakes', () => {
  const runner = fs.readFileSync(runnerPath, 'utf8');

  assert.match(runner, /\.git/);
  assert.match(runner, /cpSync/);
  assert.match(runner, /test-concurrency=1/);
});
