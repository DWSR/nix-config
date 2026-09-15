'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const specialists = Object.freeze({
  'nix-pkg': {
    file: path.join(repoRoot, 'home-manager/common/agents/nix-pkg.md'),
    preserved: [
      /edit: allow/,
      /write: allow/,
      /webfetch: allow/,
      /"\*": ask/,
      /"git \*": deny/,
      /"nix \*": allow/,
      /buildRustPackage/,
      /buildGoModule/,
      /buildNpmPackage/,
      /home\.packages/,
      /nix build/,
      /nix fmt/,
      /darwinConfigurations\.ShopifyLaptop/,
      /darwinConfigurations\.Brandons-MacBook-Pro/,
    ],
  },
  'nvim-tailor': {
    file: path.join(repoRoot, 'home-manager/common/agents/nvim-tailor.md'),
    preserved: [
      /edit: allow/,
      /write: allow/,
      /webfetch: allow/,
      /"\*": ask/,
      /"git \*": deny/,
      /"nix \*": allow/,
      /"nvim --headless \*": allow/,
      /nixvim/,
      /nvim-treesitter/,
      /blink\.cmp/,
      /conform\.nvim/,
      /nix flake check/,
      /keymap conflict detector/,
    ],
  },
  'security-auditor': {
    file: path.join(repoRoot, 'home-manager/common/agents/security-auditor.md'),
    preserved: [
      /edit: deny/,
      /write: deny/,
      /webfetch: allow/,
      /"\*": ask/,
      /"git \*": deny/,
      /cd \/tmp\/security-review\/\*": allow/,
      /mkdir -p \/tmp\/security-review\/\*": allow/,
      /severity-ranked/,
      /Every finding must cite .*<path>:<line>/,
      /outbound-network calls/,
      /Do NOT run the target's test suite or build scripts/,
    ],
  },
});

const forbiddenMemoryWorkflow =
  /\bobsidian\b|\bvault\b|\bMOCs?\b|memories\/|write-note|read-note|list-notes|search-by-tags|search-vault|(?:write|read|create|update) (?:a )?(?:memory )?note|persist (?:findings )?to (?:the )?vault/i;

function readSpecialist(name) {
  return fs.readFileSync(specialists[name].file, 'utf8');
}

function assertAgentMemoryContract(name, content) {
  assert.match(content, /retrieve_tools\(query: "agentmemory core recall"\)/, name);
  assert.match(content, /retrieve_tools\(query: "agentmemory smart search"\)/, name);
  assert.match(content, /retrieve_tools\(query: "agentmemory memory save lesson"\)/, name);
  assert.match(content, /call_tool_read/, name);
  assert.match(content, /call_tool_write/, name);
  for (const tool of [
    'memory_recall',
    'memory_smart_search',
    'memory_save',
    'memory_lesson_save',
  ]) {
    assert.match(content, new RegExp(`\\b${tool}\\b`), `${name} names ${tool}`);
  }
  assert.match(content, /exact returned `name`/, name);
  assert.match(content, /`call_with`/, name);
  assert.match(content, /`args`/, name);
  assert.match(content, /MEMORY_ID:/, name);
  assert.match(content, /MEMORY_QUERY:/, name);
  assert.match(content, /Do not call AgentMemory REST endpoints directly/i, name);
  const memoryGuidance = content.match(/## AgentMemory workflow[\s\S]*?(?=\n## )/i)?.[0] || '';
  const searchHints = content.match(/## AgentMemory search hints[\s\S]*?(?=\n## )/i)?.[0] || '';
  assert.doesNotMatch(`${memoryGuidance}\n${searchHints}`, /\bMOCs?\b|\btags?\b/i, name);
}

test('common specialist prompts use AgentMemory through mcpproxy only', () => {
  for (const [name, contract] of Object.entries(specialists)) {
    const content = readSpecialist(name);

    assert.doesNotMatch(content, forbiddenMemoryWorkflow, `${name} retains a retired memory workflow`);
    assertAgentMemoryContract(name, content);
    for (const pattern of contract.preserved) {
      assert.match(content, pattern, `${name} lost non-memory contract ${pattern}`);
    }
  }
});

test('security auditor keeps repository read-only while saving findings through AgentMemory', () => {
  const content = readSpecialist('security-auditor');

  assert.match(content, /never modify source files/i);
  assert.match(content, /call_tool_write.*memory_save|memory_save.*call_tool_write/is);
  assert.match(content, /memory_lesson_save/);
  assert.match(content, /filesystem artifact/i);
  assert.doesNotMatch(content, /path:\s*["'`]?memories\//i);
  assert.doesNotMatch(content, /fetch\s*\([^)]*agentmemory|curl[^\n]*agentmemory|\/agentmemory\//i);
});
