'use strict';

// Acceptance checks for Kiro task 1.1: the deployment catalog is pure data and
// matches the design's Initial Catalog. These assertions intentionally read the
// exported table directly; the mkCatalog validation/projection suite lives in
// tests/litellm-routing (tasks 1.2-1.4, 5.1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { nixEvalJson, repoRoot } = require('./helpers');

const catalogPath = path.join(repoRoot, 'configurations/fabro-vm/litellm-catalog.nix');

const expectedProviders = {
  chatgpt: {
    modelPrefix: 'chatgpt/',
    apiBase: null,
    apiKeyEnvVar: null,
    allowedOpenAIParams: ['reasoning_effort'],
    requiresClientSessionHeader: false,
  },
  'opencode-go': {
    modelPrefix: 'openai/',
    apiBase: 'https://opencode.ai/zen/go/v1',
    apiKeyEnvVar: 'OPENCODE_API_KEY',
    allowedOpenAIParams: ['reasoning_effort'],
    requiresClientSessionHeader: true,
  },
  'opencode-zen': {
    modelPrefix: 'openai/',
    apiBase: 'https://opencode.ai/zen/v1',
    apiKeyEnvVar: 'OPENCODE_API_KEY',
    allowedOpenAIParams: ['reasoning_effort'],
    requiresClientSessionHeader: true,
  },
};

const expectedDeployments = [
  {
    logical: 'big-pickle',
    provider: 'opencode-zen',
    upstreamModel: 'big-pickle',
    mode: 'chat',
    requestDefaults: {},
    contextWindow: 200000,
    maxOutputTokens: 32000,
    weight: 1,
  },
  {
    logical: 'deepseek-v4.1-flash',
    provider: 'opencode-go',
    upstreamModel: 'deepseek-v4.1-flash',
    mode: 'chat',
    requestDefaults: {},
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    weight: 1,
  },
  {
    logical: 'glm-5.3-flash',
    provider: 'opencode-go',
    upstreamModel: 'glm-5.3-flash',
    mode: 'chat',
    requestDefaults: {},
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    weight: 1,
  },
  {
    logical: 'gpt-6-astra',
    provider: 'chatgpt',
    upstreamModel: 'gpt-6-astra',
    mode: 'responses',
    requestDefaults: { reasoning_effort: 'xhigh' },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    weight: 1,
  },
  {
    logical: 'gpt-6-luna',
    provider: 'chatgpt',
    upstreamModel: 'gpt-6-luna',
    mode: 'responses',
    requestDefaults: { reasoning_effort: 'xhigh' },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    weight: 1,
  },
  {
    logical: 'gpt-6-luna',
    provider: 'opencode-go',
    upstreamModel: 'gpt-6-luna',
    mode: 'responses',
    requestDefaults: { reasoning_effort: 'xhigh' },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    weight: 1,
  },
  {
    logical: 'gpt-6-luna-none',
    provider: 'chatgpt',
    upstreamModel: 'gpt-6-luna',
    mode: 'responses',
    requestDefaults: { reasoning_effort: 'none' },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    weight: 1,
  },
  {
    logical: 'gpt-6.1-sol',
    provider: 'chatgpt',
    upstreamModel: 'gpt-6.1-sol',
    mode: 'responses',
    requestDefaults: { reasoning_effort: 'xhigh' },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    weight: 1,
  },
  {
    logical: 'longcat-2.5-preview-free',
    provider: 'opencode-go',
    upstreamModel: 'longcat-2.5-preview-free',
    mode: 'chat',
    requestDefaults: {},
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    weight: 1,
  },
];

function evalCatalog() {
  return nixEvalJson(`
    let
      catalog = import ${JSON.stringify(catalogPath)};
      table = catalog.table;
      logicalIds = builtins.attrNames table.logicalModels;
      deployments = builtins.concatLists (builtins.map (logical:
        builtins.map (deployment: {
          inherit logical;
          provider = deployment.provider;
          upstreamModel = deployment.upstreamModel;
          inherit (deployment)
            mode
            requestDefaults
            contextWindow
            maxOutputTokens
            weight
            ;
        }) table.logicalModels.\${logical}.deployments) logicalIds);
    in
    {
      topLevelKeys = builtins.attrNames catalog;
      tableKeys = builtins.attrNames table;
      providers = table.providers;
      logicalIds = logicalIds;
      modelCount = builtins.length logicalIds;
      deploymentCount = builtins.length deployments;
      deployments = deployments;
      defaultModel = table.defaultModel;
    }
  `);
}

test('catalog module exports only the pure table', () => {
  const rendered = evalCatalog();

  assert.equal(rendered.topLevelKeys.includes('table'), true);
  assert.deepEqual(rendered.tableKeys.sort(), ['defaultModel', 'logicalModels', 'providers']);
});

test('catalog declares exactly the three design providers', () => {
  const rendered = evalCatalog();

  assert.deepEqual(rendered.providers, expectedProviders);
});

test('catalog declares eight logical models with provider-free ids', () => {
  const rendered = evalCatalog();

  assert.deepEqual(rendered.logicalIds, [
    'big-pickle',
    'deepseek-v4.1-flash',
    'glm-5.3-flash',
    'gpt-6-astra',
    'gpt-6-luna',
    'gpt-6-luna-none',
    'gpt-6.1-sol',
    'longcat-2.5-preview-free',
  ]);
  assert.equal(rendered.modelCount, 8);

  for (const id of rendered.logicalIds) {
    assert.equal(id.includes('/'), false, `logical id ${id} contains a slash`);
    for (const token of ['chatgpt/', 'opencode-go/', 'opencode-zen/']) {
      assert.equal(id.includes(token), false, `logical id ${id} contains ${token}`);
    }
  }
});

test('catalog declares the nine design deployments with defaults and limits', () => {
  const rendered = evalCatalog();

  assert.equal(rendered.deploymentCount, 9);
  assert.deepEqual(rendered.deployments, expectedDeployments);
});

test('gpt-6-luna is the only two-deployment group and the default model is set', () => {
  const rendered = evalCatalog();
  const grouped = {};
  for (const deployment of rendered.deployments) {
    grouped[deployment.logical] = (grouped[deployment.logical] || 0) + 1;
  }

  assert.deepEqual(grouped, {
    'big-pickle': 1,
    'deepseek-v4.1-flash': 1,
    'glm-5.3-flash': 1,
    'gpt-6-astra': 1,
    'gpt-6-luna': 2,
    'gpt-6-luna-none': 1,
    'gpt-6.1-sol': 1,
    'longcat-2.5-preview-free': 1,
  });

  assert.equal(rendered.defaultModel, 'deepseek-v4.1-flash');
  assert.equal(rendered.logicalIds.includes(rendered.defaultModel), true);
});

test('catalog data carries no derivations, host paths, or literal credentials', () => {
  const rendered = evalCatalog();
  const serialized = JSON.stringify(rendered);
  const source = fs.readFileSync(catalogPath, 'utf8');

  for (const forbidden of ['/nix/store', '/home/', '/Users/', 'sk-', 'sops', 'BEGIN ']) {
    assert.equal(serialized.includes(forbidden), false, `catalog data contains ${forbidden}`);
  }
  for (const forbidden of [
    'builtins.storePath',
    'builtins.toFile',
    'builtins.derivation',
    'pkgs.',
    'home.',
    'config.',
  ]) {
    assert.equal(source.includes(forbidden), false, `catalog source contains ${forbidden}`);
  }

  for (const provider of Object.values(rendered.providers)) {
    if (provider.apiKeyEnvVar !== null) {
      assert.match(provider.apiKeyEnvVar, /^[A-Z][A-Z0-9_]*$/);
    }
  }
});
