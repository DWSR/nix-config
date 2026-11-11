'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

// One bulk evaluation caches the real gateway value, the catalog projection,
// the rendered YAML, and the service wiring. The YAML is rendered with the
// current-system `pkgs.formats.yaml` so a Darwin host never builds an
// aarch64-linux config directory.
const gatewayExpr = `
  let
    flake = builtins.getFlake (toString ${repoRoot});
    system = builtins.currentSystem;
    pkgs = import flake.inputs.nixpkgs { inherit system; };
    lib = flake.inputs.nixpkgs.lib;
    vm = flake.nixosConfigurations.fabro-vm.config;
    settings = vm.services.litellm.settings;
    catalog = (import ${repoRoot}/configurations/fabro-vm/litellm-catalog.nix { inherit lib; }).catalog;
  in
  {
    inherit settings catalog;
    yaml = builtins.readFile ((pkgs.formats.yaml { }).generate "config.yaml" settings);
    sopsPlaceholder = vm.sops.placeholder."opencode-api-key";
    execStart = vm.systemd.services.litellm.serviceConfig.ExecStart;
    pythonpath = vm.services.litellm.environment.PYTHONPATH;
    dontWrite = vm.services.litellm.environment.PYTHONDONTWRITEBYTECODE;
    dynamicUser = vm.systemd.services.litellm.serviceConfig.DynamicUser or null;
    healthGate = vm.systemd.services.litellm.serviceConfig.ExecStartPost;
  }
`;

let cachedGateway;

function gateway() {
  if (cachedGateway === undefined) {
    cachedGateway = nixEvalJson(gatewayExpr);
  }
  return cachedGateway;
}

function errorFrom(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the gateway check to fail, but it passed');
}

function truncate(value, limit = 40) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

// Fails a rendered configuration that carries a credential value: every
// present `api_key` must be a runtime `os.environ/...` reference, the YAML
// text must not contain a literal `sk-` key or the exact sops placeholder,
// and every `api_key` line in the rendered text must be an env reference.
function assertSettingsSafe(settings, yaml, sopsPlaceholder) {
  for (const entry of settings.model_list ?? []) {
    const params = entry.litellm_params ?? {};
    if (!Object.hasOwn(params, 'api_key')) {
      continue;
    }
    const value = params.api_key;
    if (typeof value !== 'string' || !value.startsWith('os.environ/')) {
      throw new Error(
        `litellm gateway: logical model '${entry.model_name ?? '<missing model_name>'}' `
        + `carries a literal api_key value '${truncate(value)}' (expected os.environ/<VAR>)`,
      );
    }
  }

  if (yaml.includes('sk-')) {
    throw new Error('litellm gateway: rendered config.yaml contains a literal \'sk-\' credential value');
  }

  if (sopsPlaceholder !== undefined && sopsPlaceholder !== '' && yaml.includes(sopsPlaceholder)) {
    throw new Error(
      `litellm gateway: rendered config.yaml contains the sops placeholder '${sopsPlaceholder}'`,
    );
  }

  for (const match of yaml.matchAll(/^\s*api_key:\s*(.+)$/gm)) {
    const value = match[1].trim();
    if (!value.startsWith('os.environ/')) {
      throw new Error(
        `litellm gateway: rendered config.yaml api_key '${truncate(value)}' `
        + 'is not an os.environ/<VAR> reference',
      );
    }
  }
}

test('model_list is exactly the catalog projection with unique ids and explicit weights', () => {
  const { settings, catalog } = gateway();
  const { model_list: modelList } = settings;

  assert.deepEqual(modelList, catalog.modelList);
  assert.equal(modelList.length, 11);
  assert.equal(catalog.modelList.length, 11);

  const deploymentIds = modelList.map((entry) => entry.model_info.id);
  assert.equal(
    new Set(deploymentIds).size,
    deploymentIds.length,
    `duplicate model_info.id in ${JSON.stringify(deploymentIds)}`,
  );

  for (const entry of modelList) {
    const logicalId = entry.model_name;
    assert.ok(
      catalog.logicalIds.includes(logicalId),
      `gateway model_name '${logicalId}' is not a catalog logical model`,
    );
    assert.equal(
      logicalId.includes('/'),
      false,
      `gateway model_name '${logicalId}' must be provider-free`,
    );
    assert.equal(
      Object.hasOwn(entry.litellm_params, 'weight'),
      true,
      `deployment '${entry.model_info.id}' does not declare an explicit weight`,
    );
    assert.ok(
      Number.isInteger(entry.litellm_params.weight),
      `deployment '${entry.model_info.id}' has non-integer weight `
      + `${JSON.stringify(entry.litellm_params.weight)}`,
    );
  }
});

test('router_settings matches the documented contract including derived max_fallbacks', () => {
  const { settings, catalog } = gateway();
  const router = settings.router_settings;

  assert.deepEqual(Object.keys(router).sort(), [
    'allowed_fails',
    'cooldown_time',
    'deployment_affinity_ttl_seconds',
    'enable_weighted_failover',
    'max_fallbacks',
    'num_retries',
    'optional_pre_call_checks',
    'routing_strategy',
  ]);

  assert.equal(router.routing_strategy, 'simple-shuffle');
  assert.deepEqual(router.optional_pre_call_checks, ['session_affinity']);
  assert.equal(router.deployment_affinity_ttl_seconds, 21600);
  assert.equal(router.num_retries, 0);
  assert.equal(router.enable_weighted_failover, true);
  assert.equal(router.allowed_fails, 0);
  assert.equal(router.cooldown_time, 60);

  assert.equal(catalog.maxGroupSize, 2);
  assert.equal(router.max_fallbacks, catalog.maxGroupSize - 1);
  assert.equal(router.max_fallbacks, 1);

  for (const key of [
    'deployment_affinity',
    'fallbacks',
    'context_window_fallbacks',
    'model_group_alias',
    'rpm',
    'tpm',
  ]) {
    assert.equal(
      Object.hasOwn(router, key),
      false,
      `router_settings must not declare '${key}'`,
    );
  }
});

test('header forwarding equals the catalog projection', () => {
  const { settings, catalog } = gateway();
  const forwarding =
    settings.litellm_settings.model_group_settings.forward_client_headers_to_llm_api;

  assert.deepEqual(forwarding, catalog.forwardClientHeaders);
  assert.deepEqual(forwarding, [
    'beam-free',
    'big-pickle',
    'deepseek-v4.1-flash',
    'glm-5.3-flash',
    'gpt-6-luna',
    'longcat-2.0',
    'omen-alpha',
  ]);
  assert.equal(forwarding.length, 7);
  assert.equal(new Set(forwarding).size, forwarding.length);
});

test('callbacks names the affinity bridge instance', () => {
  const { settings } = gateway();

  assert.deepEqual(
    settings.litellm_settings.callbacks,
    ['litellm_affinity_bridge.proxy_handler_instance'],
  );
});

test('the service runs the generated config directory', () => {
  const { execStart, pythonpath, dontWrite, dynamicUser, healthGate } = gateway();

  assert.match(pythonpath, /-litellm-config$/);
  assert.ok(
    execStart.endsWith(`--config ${pythonpath}/config.yaml`),
    `ExecStart '${execStart}' does not end with '--config ${pythonpath}/config.yaml'`,
  );
  assert.ok(
    execStart.includes('--config '),
    `ExecStart '${execStart}' does not pass --config`,
  );
  assert.equal(dontWrite, '1');
  assert.equal(dynamicUser, true);
  assert.equal(typeof healthGate, 'string');
  assert.ok(healthGate.length > 0, 'ExecStartPost health gate is empty');
});

test('the real settings and rendered YAML carry no credential values', () => {
  const { settings, yaml, sopsPlaceholder } = gateway();

  assert.equal(sopsPlaceholder.length > 0, true);
  assert.equal(
    yaml.includes(sopsPlaceholder),
    false,
    'rendered YAML must not embed the sops placeholder',
  );
  assert.equal(yaml.includes('sk-'), false, 'rendered YAML must not contain sk- values');

  const apiKeyLines = Array.from(yaml.matchAll(/^\s*api_key:\s*(.+)$/gm), (match) => match[1].trim());
  assert.equal(apiKeyLines.length, 7);
  for (const value of apiKeyLines) {
    assert.ok(
      value.startsWith('os.environ/'),
      `rendered YAML api_key '${value}' is not an environment reference`,
    );
  }

  assert.doesNotThrow(() => assertSettingsSafe(settings, yaml, sopsPlaceholder));
});

test('a literal sk-test api_key names the offending logical model', () => {
  const fixture = {
    model_list: [
      {
        model_name: 'fixture-model',
        litellm_params: { api_key: 'sk-test' },
      },
    ],
  };

  const error = errorFrom(() => assertSettingsSafe(fixture, 'model_list: []\n', '<SOPS:fixture:PLACEHOLDER>'));
  assert.match(error.message, /logical model 'fixture-model'/);
  assert.match(error.message, /sk-test/);
});

test('a literal api_key without sk- still names the logical model', () => {
  const fixture = {
    model_list: [
      {
        model_name: 'fixture-model',
        litellm_params: { api_key: 'literal-key' },
      },
    ],
  };

  const error = errorFrom(() => assertSettingsSafe(fixture, 'model_list: []\n', '<SOPS:fixture:PLACEHOLDER>'));
  assert.match(error.message, /logical model 'fixture-model'/);
  assert.match(error.message, /literal-key/);
  assert.equal(error.message.includes('sk-'), false);
});

test('a rendered YAML containing sk- names the rendered config', () => {
  const yaml = 'model_list:\n- litellm_params:\n    api_key: sk-test\n';

  const error = errorFrom(() => assertSettingsSafe(
    { model_list: [] },
    yaml,
    '<SOPS:fixture:PLACEHOLDER>',
  ));
  assert.match(error.message, /rendered config\.yaml/);
  assert.match(error.message, /sk-/);
});

test('a rendered YAML containing the sops placeholder names the rendered config', () => {
  const placeholder = '<SOPS:fixture:PLACEHOLDER>';
  const yaml = `model_list: []\n# credential: ${placeholder}\n`;

  const error = errorFrom(() => assertSettingsSafe({ model_list: [] }, yaml, placeholder));
  assert.match(error.message, /rendered config\.yaml/);
  assert.match(error.message, /sops placeholder/);
  assert.ok(error.message.includes(placeholder));
});

test('a rendered YAML api_key that is not an environment reference fails', () => {
  const yaml = 'model_list:\n- litellm_params:\n    api_key: literal-key\n';

  const error = errorFrom(() => assertSettingsSafe(
    { model_list: [] },
    yaml,
    '<SOPS:fixture:PLACEHOLDER>',
  ));
  assert.match(error.message, /rendered config\.yaml/);
  assert.match(error.message, /literal-key/);
  assert.match(error.message, /os\.environ/);
});
