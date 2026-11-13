'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalFailure, nixEvalJson, repoRoot } = require('./helpers');

const catalogPath = `${repoRoot}/configurations/fabro-vm/litellm-catalog.nix`;

// Fixture tables are deliberately small: providers `p` and `q` disagree only on
// the field under test, and `chatgpt` exists to exercise provider-token ids.
const fixturePrelude = `
  flake = builtins.getFlake (toString ${repoRoot});
  lib = flake.inputs.nixpkgs.lib;
  catalog = import ${catalogPath} { inherit lib; };
  p = {
    modelPrefix = "p/";
    apiBase = null;
    apiKeyEnvVar = null;
    allowedOpenAIParams = [ "reasoning_effort" ];
    requiresClientSessionHeader = false;
  };
  q = {
    modelPrefix = "q/";
    apiBase = null;
    apiKeyEnvVar = null;
    allowedOpenAIParams = [ "reasoning_effort" ];
    requiresClientSessionHeader = false;
  };
  chatgpt = {
    modelPrefix = "chatgpt/";
    apiBase = null;
    apiKeyEnvVar = null;
    allowedOpenAIParams = [ "reasoning_effort" ];
    requiresClientSessionHeader = false;
  };
  mkDeployment = provider: {
    provider = provider;
    upstreamModel = "upstream-model";
    mode = "chat";
    requestDefaults = { reasoning_effort = "high"; };
    limits = {
      contextTokens = 1000;
      maxOutputTokens = 100;
    };
  };
`;

function fixtureExpr({
  logicalModels,
  defaultModel = 'foo',
  providers = '{ inherit p q chatgpt; }',
  projection = 'modelList',
}) {
  return `
    let
      ${fixturePrelude}
    in
    (catalog.mkCatalog {
      providers = ${providers};
      logicalModels = ${logicalModels};
      defaultModel = ${JSON.stringify(defaultModel)};
    }).${projection}
  `;
}

function realCatalogExpr(attributePath) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      lib = flake.inputs.nixpkgs.lib;
      catalog = import ${catalogPath} { inherit lib; };
    in
    catalog.${attributePath}
  `;
}

let cachedRealCatalog;

function realCatalog() {
  if (cachedRealCatalog === undefined) {
    cachedRealCatalog = nixEvalJson(realCatalogExpr('catalog'));
  }
  return cachedRealCatalog;
}

test('disagreeing mode fails naming both deployments and the field', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'bar',
    logicalModels: `{
      bar = {
        deployments = [
          ((mkDeployment "p") // { mode = "chat"; })
          ((mkDeployment "q") // { mode = "responses"; })
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'bar' deployments 'bar@p' and 'bar@q' disagree on 'mode'/,
  );
});

test('disagreeing requestDefaults fails naming both deployments and the field', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'bar',
    logicalModels: `{
      bar = {
        deployments = [
          ((mkDeployment "p") // { requestDefaults = { reasoning_effort = "high"; }; })
          ((mkDeployment "q") // { requestDefaults = { reasoning_effort = "low"; }; })
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'bar' deployments 'bar@p' and 'bar@q' disagree on 'requestDefaults'/,
  );
});

test('disagreeing limits.contextTokens fails naming both deployments and the field', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'bar',
    logicalModels: `{
      bar = {
        deployments = [
          ((mkDeployment "p") // { limits = { contextTokens = 1000; maxOutputTokens = 100; }; })
          ((mkDeployment "q") // { limits = { contextTokens = 2000; maxOutputTokens = 100; }; })
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'bar' deployments 'bar@p' and 'bar@q' disagree on 'limits.contextTokens'/,
  );
});

test('disagreeing limits.maxOutputTokens fails naming both deployments and the field', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'bar',
    logicalModels: `{
      bar = {
        deployments = [
          ((mkDeployment "p") // { limits = { contextTokens = 1000; maxOutputTokens = 100; }; })
          ((mkDeployment "q") // { limits = { contextTokens = 1000; maxOutputTokens = 200; }; })
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'bar' deployments 'bar@p' and 'bar@q' disagree on 'limits.maxOutputTokens'/,
  );
});

test('a deployment missing limits.contextTokens names the deployment and the field', () => {
  const failure = nixEvalFailure(fixtureExpr({
    logicalModels: `{
      foo = {
        deployments = [
          ((mkDeployment "p") // { limits = { maxOutputTokens = 100; }; })
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'foo' deployment 'foo@p' is missing field 'limits.contextTokens'/,
  );
});

test('a deployment missing mode names the deployment and the field', () => {
  const failure = nixEvalFailure(fixtureExpr({
    logicalModels: `{
      foo = {
        deployments = [
          (builtins.removeAttrs (mkDeployment "p") [ "mode" ])
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'foo' deployment 'foo@p' is missing field 'mode'/,
  );
});

test('an empty group names the logical model', () => {
  const failure = nixEvalFailure(fixtureExpr({
    logicalModels: `{
      foo = {
        deployments = [ ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'foo' has no deployments/,
  );
});

test('an unknown provider names the deployment and the provider', () => {
  const failure = nixEvalFailure(fixtureExpr({
    logicalModels: `{
      foo = {
        deployments = [
          ((mkDeployment "p") // { provider = "nope"; })
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'foo' deployment 'foo@nope' names unknown provider 'nope'/,
  );
});

test('a logical id containing a slash names the id and the token', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'foo/bar',
    logicalModels: `{
      "foo/bar" = {
        deployments = [
          (mkDeployment "p")
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'foo\/bar' must not contain provider or path token '\/'/,
  );
});

test('a logical id containing a provider token names the id and the token', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'chatgptfoo',
    logicalModels: `{
      chatgptfoo = {
        deployments = [
          (mkDeployment "chatgpt")
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'chatgptfoo' must not contain provider or path token 'chatgpt'/,
  );
});

test('a duplicate deployment id names the logical model and the duplicate', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'baz',
    logicalModels: `{
      baz = {
        deployments = [
          (mkDeployment "p")
          (mkDeployment "p")
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: logical model 'baz' has duplicate deployment id 'baz@p'/,
  );
});

test('an invalid default model names the model', () => {
  const failure = nixEvalFailure(fixtureExpr({
    defaultModel: 'nope',
    logicalModels: `{
      foo = {
        deployments = [
          (mkDeployment "p")
        ];
      };
    }`,
  }));

  assert.match(
    failure,
    /litellm-catalog: default model 'nope' is not a logical model/,
  );
});

test('a deployment without weight emits weight 1', () => {
  const modelList = nixEvalJson(fixtureExpr({
    defaultModel: 'solo',
    logicalModels: `{
      solo = {
        deployments = [
          (mkDeployment "p")
        ];
      };
    }`,
  }));

  assert.equal(modelList.length, 1);
  assert.equal(modelList[0].model_info.id, 'solo@p');
  assert.equal(modelList[0].litellm_params.weight, 1);
});

test('the real catalog weights every deployment and keeps deployment ids unique', () => {
  const catalog = realCatalog();

  assert.equal(catalog.modelList.length, 11);
  assert.equal(catalog.logicalIds.length, 10);
  assert.equal(catalog.maxGroupSize, 2);

  const deploymentIds = catalog.modelList.map((entry) => entry.model_info.id);
  assert.equal(
    new Set(deploymentIds).size,
    deploymentIds.length,
    `duplicate deployment id in ${JSON.stringify(deploymentIds)}`,
  );

  const weights = catalog.modelList.map((entry) => entry.litellm_params.weight);
  for (const [index, weight] of weights.entries()) {
    assert.ok(
      Number.isInteger(weight),
      `deployment ${deploymentIds[index]} has non-integer weight ${JSON.stringify(weight)}`,
    );
    assert.equal(weight, 1, `deployment ${deploymentIds[index]} does not default to weight 1`);
  }
  assert.ok(weights.includes(1), 'no deployment carries the default weight 1');
});

test('the real catalog forwards client headers for exactly the OpenCode-backed ids', () => {
  const catalog = realCatalog();
  const expected = [
    'beam-free',
    'big-pickle',
    'deepseek-v4.1-flash',
    'glm-5.3-flash',
    'gpt-6-luna',
    'longcat-2.0',
    'omen-alpha',
  ];

  assert.deepEqual(catalog.forwardClientHeaders, expected);
  for (const logicalId of catalog.forwardClientHeaders) {
    assert.ok(
      catalog.logicalIds.includes(logicalId),
      `forwarded id ${logicalId} is not a logical model`,
    );
  }
});

test('repeated evaluation returns identical catalog projections', () => {
  const catalogExpr = realCatalogExpr('catalog');
  const firstCatalog = JSON.stringify(nixEvalJson(catalogExpr));
  const secondCatalog = JSON.stringify(nixEvalJson(catalogExpr));
  assert.equal(secondCatalog, firstCatalog);

  const modelListExpr = realCatalogExpr('catalog.modelList');
  const firstModelList = JSON.stringify(nixEvalJson(modelListExpr));
  const secondModelList = JSON.stringify(nixEvalJson(modelListExpr));
  assert.equal(secondModelList, firstModelList);
});
