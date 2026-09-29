'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const instructions = fs.readFileSync(path.join(repoRoot, 'home-manager/common/agents.md'), 'utf8');
const agentMemoryInstructions = fs.readFileSync(
  path.join(repoRoot, 'home-manager/common/agents-agentmemory.md'),
  'utf8',
);
const ccSddInstructions = fs.readFileSync(
  path.join(repoRoot, 'home-manager/common/agents-cc-sdd.md'),
  'utf8',
);

const forbiddenVaultContract =
  /\bobsidian\b|\bvault\b|\bMOCs?\b|memories\/|write-note|read-note|list-notes|search-by-tags|search-vault/i;

function renderOpenCodeContext() {
  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [ flake.outputs.overlays.custom-packages ];
    config.allowUnfree = true;
  };
  hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode.nix'))}
      "\${flake.inputs.home-manager}/modules/programs/opencode.nix"
      {
        home.username = "brandonmcnama";
         home.homeDirectory = "/Users/brandonmcnama";
         home.stateVersion = "26.05";
         programs.agentmemory.enable = false;
      }
    ];
  }).config;
in builtins.toJSON {
  context = hm.programs.opencode.context;
  titleDisabled = hm.programs.opencode.settings.agent.title.disable;
  summaryDisabled = hm.programs.opencode.settings.agent.summary.disable;
})`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}

test('AgentMemory instructions describe stock discovery, recall, sessions, and saves', () => {
  assert.match(agentMemoryInstructions, /# MANDATORY: AgentMemory/);
  assert.match(agentMemoryInstructions, /stock AgentMemory/i);
  assert.match(agentMemoryInstructions, /retrieve_tools\(query: "agentmemory/);
  assert.match(agentMemoryInstructions, /agentmemory:<tool>/);
  assert.match(agentMemoryInstructions, /AGENTMEMORY_TOOLS=core/);
  assert.match(agentMemoryInstructions, /call_tool_read/);
  assert.match(agentMemoryInstructions, /call_tool_write/);

  for (const tool of [
    'memory_recall',
    'memory_smart_search',
    'memory_sessions',
    'memory_save',
    'memory_lesson_save',
    'memory_consolidate',
    'memory_diagnose',
    'memory_reflect',
  ]) {
    assert.match(agentMemoryInstructions, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(agentMemoryInstructions, /session (?:start|created)/i);
  assert.match(agentMemoryInstructions, /session (?:end|deleted)/i);
  assert.match(agentMemoryInstructions, /observ(?:e|ation)/i);
  assert.match(agentMemoryInstructions, /memory_recall/);
  assert.match(agentMemoryInstructions, /memory_smart_search/);
  assert.match(agentMemoryInstructions, /memory_save/);
  assert.match(agentMemoryInstructions, /memory_lesson_save/);
  assert.match(agentMemoryInstructions, /durable/i);
  assert.doesNotMatch(agentMemoryInstructions, forbiddenVaultContract);
});

test('AgentMemory instructions preserve stock limitations and avoid custom claims', () => {
  assert.match(agentMemoryInstructions, /automatic context injection/i);
  assert.match(agentMemoryInstructions, /fallback/i);
  assert.match(agentMemoryInstructions, /bearer/i);
  assert.match(agentMemoryInstructions, /subprocess/i);
  assert.match(agentMemoryInstructions, /subprocesses may inherit that bearer/i);
  assert.match(agentMemoryInstructions, /no (?:strict )?project selector|no project selector/i);
  assert.match(agentMemoryInstructions, /custom fallback guard/i);
  assert.match(agentMemoryInstructions, /do not promise stable context/i);
  assert.doesNotMatch(agentMemoryInstructions, /custom (?:read|capture|retrieval) (?:facade|fallback|relay)/i);
});

test('rendered OpenCode context carries AgentMemory guidance and disabled title/summary agents', () => {
  const rendered = renderOpenCodeContext();

  assert.match(rendered.context, /# MANDATORY: AgentMemory/);
  assert.match(rendered.context, /memory_smart_search/);
  assert.match(rendered.context, /memory_lesson_save/);
  assert.match(rendered.context, /automatic context injection/i);
  assert.doesNotMatch(rendered.context, forbiddenVaultContract);
  assert.equal(rendered.titleDisabled, true);
  assert.equal(rendered.summaryDisabled, true);
});

test('global and AgentMemory fragments contain no active vault memory contract', () => {
  for (const [name, content] of [
    ['global', instructions],
    ['AgentMemory', agentMemoryInstructions],
    ['cc-sdd', ccSddInstructions],
  ]) {
    assert.doesNotMatch(content, forbiddenVaultContract, `${name} contains vault-only guidance`);
  }

  assert.match(instructions, /# Version control/);
  assert.match(instructions, /# Time and dates/);
  assert.match(ccSddInstructions, /## Workflow/);
});
