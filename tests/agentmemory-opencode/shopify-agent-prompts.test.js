'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const agentRoot = path.join(repoRoot, 'configurations/shopify/home-manager/agents');
const scopedAgents = Object.freeze([
  'yb-issue-validator',
  'yb-sleuth',
  'yb-backlog-validator',
  'stack-captain',
  'yb-fix-pr-author',
  'yb-issue-oneshot',
]);
const producers = new Set([
  'yb-issue-validator',
  'yb-sleuth',
  'stack-captain',
  'yb-fix-pr-author',
  'yb-issue-oneshot',
]);
const consumers = new Set(['yb-backlog-validator', 'yb-fix-pr-author', 'yb-issue-oneshot']);

const forbiddenMemoryWorkflow =
  /\bobsidian\b|\bvault\b|\bMOCs?\b|memories\/|memory path|note path|write-note|read-note|list-notes|search-by-tags|search-vault|(?:write|read|create|update) (?:a )?(?:memory )?note/i;

function readAgent(name) {
  return fs.readFileSync(path.join(agentRoot, `${name}.md`), 'utf8');
}

function assertAgentMemoryTools(name, content) {
  assert.match(content, /retrieve_tools\(query: "agentmemory core recall"\)/, name);
  assert.match(content, /call_tool_read/, name);
  for (const tool of [
    'memory_recall',
    'memory_smart_search',
    'memory_sessions',
  ]) {
    assert.match(content, new RegExp(`\\b${tool}\\b`), `${name} names ${tool}`);
  }
  assert.match(content, /exact returned\s+`name`/, name);
  assert.match(content, /`call_with`/, name);
  assert.match(content, /`args`/, name);
  assert.doesNotMatch(content, /(?:fetch|curl)[^\n]*(?:agentmemory|\/agentmemory\/)/i, name);
}

test('scoped Shopify agent sources use AgentMemory through mcpproxy only', () => {
  for (const name of scopedAgents) {
    const content = readAgent(name);
    assert.doesNotMatch(content, forbiddenMemoryWorkflow, `${name} retains a retired memory workflow`);
    assertAgentMemoryTools(name, content);
  }
});

test('Shopify durable-memory producers return searchable handoffs', () => {
  for (const name of producers) {
    const content = readAgent(name);
    assert.match(content, /memory_save|memory_lesson_save/, `${name} names a durable save tool`);
    assert.match(content, /call_tool_write/, `${name} saves through the write operation class`);
    assert.match(content, /MEMORY_ID:\s*<id>/, `${name} returns the saved record ID`);
    assert.match(content, /MEMORY_QUERY:\s*<distinctive title and concepts>/, `${name} returns a searchable query`);
  }
});

test('Shopify memory consumers recall by query and verify the returned ID', () => {
  for (const name of consumers) {
    const content = readAgent(name);
    assert.match(content, /recall by `MEMORY_QUERY`/i, `${name} recalls by the handoff query`);
    assert.match(
      content,
      /verify\s+the returned record ID\s+equals\s+`MEMORY_ID`/i,
      `${name} verifies the handoff ID`,
    );
    assert.match(content, /(?:do not|never) fetch by ID/i, `${name} does not fetch by ID`);
  }
});
