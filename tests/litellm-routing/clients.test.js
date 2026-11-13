'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { nixEvalJson, repoRoot } = require('./helpers');

// One bulk evaluation caches both client projections and the deployment table
// they must agree with. The table supplies the group limits each Fabro record
// is compared against.
const clientExpr = `
  let
    flake = builtins.getFlake (toString ${repoRoot});
    lib = flake.inputs.nixpkgs.lib;
    catalog = (import ${repoRoot}/configurations/fabro-vm/litellm-catalog.nix { inherit lib; }).catalog;
  in
  {
    inherit (catalog) logicalIds openCode fabro;
    tables = catalog.tables;
  }
`;

let cachedClients;

function clientCatalog() {
  if (cachedClients === undefined) {
    cachedClients = nixEvalJson(clientExpr);
  }
  return cachedClients;
}

const clientFiles = [
  `${repoRoot}/configurations/fabro-vm/opencode.nix`,
  `${repoRoot}/configurations/fabro-vm/fabro.nix`,
];

// A provider-scoped literal starts with one of the removed provider prefixes;
// the trailing id characters are captured so a finding names the whole id.
// Old Fabro record keys are matched as whole words so a bare `gpt-6-luna`
// logical id does not trip the scan.
const legacyPatterns = [
  /(?:chatgpt|opencode-go|opencode-zen)\/[\w.-]*/g,
  /\bgo-gpt-6-luna\b|\bgo-beam-free\b|\bgo-omen-alpha\b/g,
];

function scanLegacyIds(filePath, sourceText) {
  const findings = [];
  const lines = sourceText.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const pattern of legacyPatterns) {
      for (const match of line.matchAll(pattern)) {
        findings.push({
          file: filePath,
          line: index + 1,
          match: match[0],
        });
      }
    }
  }

  return findings;
}

function assertNoLegacyIds(filePath, sourceText) {
  const findings = scanLegacyIds(filePath, sourceText);

  if (findings.length > 0) {
    throw new Error(
      'litellm clients: removed provider-scoped model id or old Fabro record key found:\n'
      + findings
        .map(({ file, line, match }) => `  ${file}:${line} '${match}'`)
        .join('\n'),
    );
  }
}

test('both client projections expose exactly the catalog ids', () => {
  const { logicalIds, openCode, fabro } = clientCatalog();

  assert.equal(logicalIds.length, 10);
  assert.deepEqual(Object.keys(openCode.models).sort(), logicalIds);
  assert.deepEqual(Object.keys(fabro.models).sort(), logicalIds);

  assert.ok(
    logicalIds.includes(openCode.defaultModel),
    `OpenCode default '${openCode.defaultModel}' is not a served logical id`,
  );
  assert.ok(
    logicalIds.includes(fabro.defaultModel),
    `Fabro default '${fabro.defaultModel}' is not a served logical id`,
  );
});

test('OpenCode and Fabro agree on the display name for every logical id', () => {
  const { logicalIds, openCode, fabro } = clientCatalog();

  for (const logicalId of logicalIds) {
    assert.equal(
      openCode.models[logicalId].name,
      fabro.models[logicalId].display_name,
      `client surfaces disagree on the display name for '${logicalId}'`,
    );
  }
});

test('every Fabro record enables caching and cache_routing with the catalog limits', () => {
  const { logicalIds, fabro, tables } = clientCatalog();

  for (const logicalId of logicalIds) {
    const record = fabro.models[logicalId];
    const [deployment] = tables.logicalModels[logicalId].deployments;

    assert.equal(record.api_model, logicalId, `Fabro record '${logicalId}' has api_model '${record.api_model}'`);
    assert.equal(
      record.capabilities.caching,
      true,
      `Fabro record '${logicalId}' does not set capabilities.caching`,
    );
    assert.equal(
      record.capabilities.cache_routing,
      true,
      `Fabro record '${logicalId}' does not set capabilities.cache_routing`,
    );
    assert.equal(record.capabilities.text, true, `Fabro record '${logicalId}' does not set capabilities.text`);
    assert.equal(record.capabilities.tools, true, `Fabro record '${logicalId}' does not set capabilities.tools`);
    assert.equal(
      record.capabilities.reasoning,
      true,
      `Fabro record '${logicalId}' does not set capabilities.reasoning`,
    );
    assert.equal(
      record.limits.context_tokens,
      deployment.limits.contextTokens,
      `Fabro record '${logicalId}' context_tokens disagrees with the catalog`,
    );
    assert.equal(
      record.limits.max_output_tokens,
      deployment.limits.maxOutputTokens,
      `Fabro record '${logicalId}' max_output_tokens disagrees with the catalog`,
    );
  }

  const smallDefaults = logicalIds.filter((logicalId) => fabro.models[logicalId].small_default === true);
  assert.deepEqual(smallDefaults, ['deepseek-v4.1-flash']);

  for (const logicalId of logicalIds) {
    if (logicalId === 'deepseek-v4.1-flash') {
      continue;
    }
    assert.equal(
      Object.hasOwn(fabro.models[logicalId], 'small_default'),
      false,
      `Fabro record '${logicalId}' must not carry small_default`,
    );
  }
});

test('the real client configuration contains no legacy ids', () => {
  for (const filePath of clientFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const findings = scanLegacyIds(filePath, source);

    assert.equal(
      findings.length,
      0,
      `legacy client references: ${findings
        .map((finding) => `${finding.file}:${finding.line} '${finding.match}'`)
        .join(', ')}`,
    );
    assert.deepEqual(scanLegacyIds(filePath, source), []);
    assert.doesNotThrow(() => assertNoLegacyIds(filePath, source));
  }
});

test('a reintroduced provider-scoped api_model is reported with the file and id', () => {
  const filePath = 'configurations/fabro-vm/fabro.nix';
  const source = [
    'llm.providers.litellm.models = {',
    '  deepseek-v4.1-flash.api_model = "opencode-go/deepseek-v4.1-flash";',
    '};',
  ].join('\n');

  assert.deepEqual(scanLegacyIds(filePath, source), [
    {
      file: filePath,
      line: 2,
      match: 'opencode-go/deepseek-v4.1-flash',
    },
  ]);
});

test('every removed provider prefix is reported with the whole scoped id', () => {
  const filePath = 'configurations/fabro-vm/opencode.nix';
  const source = [
    'model = "chatgpt/gpt-6-luna";',
    'model = "opencode-go/beam-free";',
    'api_model = "opencode-zen/longcat-2.0";',
  ].join('\n');

  assert.deepEqual(scanLegacyIds(filePath, source), [
    { file: filePath, line: 1, match: 'chatgpt/gpt-6-luna' },
    { file: filePath, line: 2, match: 'opencode-go/beam-free' },
    { file: filePath, line: 3, match: 'opencode-zen/longcat-2.0' },
  ]);
});

test('each old Fabro record key is reported with its line', () => {
  const filePath = 'configurations/fabro-vm/fabro.nix';
  const source = [
    'models = {',
    '  go-gpt-6-luna = { };',
    '  go-beam-free = { };',
    '  go-omen-alpha = { };',
    '};',
  ].join('\n');

  assert.deepEqual(scanLegacyIds(filePath, source), [
    { file: filePath, line: 2, match: 'go-gpt-6-luna' },
    { file: filePath, line: 3, match: 'go-beam-free' },
    { file: filePath, line: 4, match: 'go-omen-alpha' },
  ]);
});

test('a source with only provider-free catalog ids produces no findings', () => {
  const source = [
    'models = {',
    '  deepseek-v4.1-flash = { api_model = "deepseek-v4.1-flash"; };',
    '  gpt-6-luna = { display_name = "GPT-6 Luna"; };',
    '};',
  ].join('\n');

  assert.deepEqual(scanLegacyIds('configurations/fabro-vm/fabro.nix', source), []);
});

test('a finding fails the check with the file and matched string named', () => {
  const filePath = 'configurations/fabro-vm/fabro.nix';
  const source = 'api_model = "opencode-go/deepseek-v4.1-flash";\n';

  assert.throws(
    () => assertNoLegacyIds(filePath, source),
    (error) => {
      assert.ok(
        error.message.includes(filePath),
        `failure message does not name '${filePath}': ${error.message}`,
      );
      assert.ok(
        error.message.includes('opencode-go/deepseek-v4.1-flash'),
        `failure message does not name the matched id: ${error.message}`,
      );
      return true;
    },
  );
});
