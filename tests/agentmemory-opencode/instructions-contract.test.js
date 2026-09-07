'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const instructionsPath = path.join(repoRoot, 'home-manager/common/agents.md');
const instructions = fs.readFileSync(instructionsPath, 'utf8');

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
  assert.match(instructions, /# MANDATORY: AgentMemory \+ Obsidian/);
  assert.match(instructions, /stock AgentMemory/i);
  assert.match(instructions, /retrieve_tools\(query: "agentmemory/);
  assert.match(instructions, /agentmemory:<tool>/);
  assert.match(instructions, /AGENTMEMORY_TOOLS=core/);
  assert.match(instructions, /call_tool_read/);
  assert.match(instructions, /call_tool_write/);

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
    assert.match(instructions, new RegExp(`\\b${tool}\\b`));
  }

  assert.match(instructions, /session (?:start|created)/i);
  assert.match(instructions, /session (?:end|deleted)/i);
  assert.match(instructions, /observ(?:e|ation)/i);
  assert.match(instructions, /save|remember/i);
});

test('AgentMemory instructions preserve stock limitations and avoid custom claims', () => {
  assert.match(instructions, /automatic context injection/i);
  assert.match(instructions, /fallback/i);
  assert.match(instructions, /bearer/i);
  assert.match(instructions, /subprocess/i);
  assert.match(instructions, /no (?:strict )?project selector|no project selector/i);
  assert.match(instructions, /custom fallback guard/i);
  assert.doesNotMatch(instructions, /All sessions MUST use BOTH Obsidian vault \+ cavemem/i);
  assert.doesNotMatch(instructions, /Cavemem = ambient/i);
  assert.match(instructions, /do not promise stable context/i);
  assert.doesNotMatch(instructions, /custom (?:read|capture|retrieval) (?:facade|fallback|relay)/i);
});

test('rendered OpenCode context carries AgentMemory guidance and disabled title/summary agents', () => {
  const rendered = renderOpenCodeContext();

  assert.match(rendered.context, /# MANDATORY: AgentMemory \+ Obsidian/);
  assert.match(rendered.context, /memory_smart_search/);
  assert.match(rendered.context, /automatic context injection/i);
  assert.equal(rendered.titleDisabled, true);
  assert.equal(rendered.summaryDisabled, true);
});

test('manual Obsidian curation rules remain in the rendered instructions', () => {
  assert.match(instructions, /## Obsidian Memory Recall/);
  assert.match(instructions, /## Memories/);
  assert.match(instructions, /## Obsidian Tool Reference/);
  assert.match(instructions, /## Tag Guidelines/);
  assert.match(instructions, /call_tool_destructive/);
  assert.match(instructions, /(?:manually curated|curated agent-authored)/i);
  assert.match(instructions, /vault-curator|manually curated/i);
});
