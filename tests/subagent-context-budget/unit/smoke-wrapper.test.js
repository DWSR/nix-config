'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('subagent-context-budget CLI Nix wrapper installs expected binary', () => {
  const source = readRepoFile('scripts/subagent-context-budget.nix');

  assert.match(source, /name\s*=\s*"subagent-context-budget"/);
  assert.match(source, /nodejs/);
  assert.match(source, /subagent-context-budget\.js/);
});

test('runtime smoke wrapper exposes deterministic checks and override environment', () => {
  const source = readRepoFile('scripts/subagent-context-budget-smoke-test.nix');

  for (const term of [
    'name = "subagent-context-budget-smoke-test"',
    'SUBAGENT_CONTEXT_BUDGET_SMOKE_CLI',
    'SUBAGENT_CONTEXT_BUDGET_SMOKE_METADATA',
    'SUBAGENT_CONTEXT_BUDGET_SMOKE_PLUGIN_SELF_CHECK',
    'SUBAGENT_CONTEXT_BUDGET_SMOKE_CATALOG',
    '[smoke-test-failure: %s] %s\\n',
    'cli_missing',
    'metadata_missing',
    'metadata_invalid',
    'plugin_self_check_failed',
    'smoke_plan_failed',
    'smoke-plan',
  ]) {
    assert.ok(source.includes(term), `smoke wrapper must include ${term}`);
  }
});

test('Home Manager module exposes and installs CLI and smoke-test packages', () => {
  const source = readRepoFile('home-manager/common/subagent-context-budget.nix');

  assert.match(source, /pkgs\.callPackage\s+\.\.\/\.\.\/scripts\/subagent-context-budget\.nix/);
  assert.match(source, /pkgs\.callPackage\s+\.\.\/\.\.\/scripts\/subagent-context-budget-smoke-test\.nix/);
  assert.match(source, /package\s*=\s*lib\.mkOption/);
  assert.match(source, /smokeTestPackage\s*=\s*lib\.mkOption/);
  assert.match(source, /readOnly\s*=\s*true/);
  assert.match(source, /home\.packages\s*=\s*\[/);
  assert.match(source, /cfg\.package/);
  assert.match(source, /cfg\.smokeTestPackage/);
});
