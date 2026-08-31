'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const retainedSkill = path.join(
  repoRoot,
  'configurations/shopify/home-manager/skills/graphite-pitfalls/SKILL.md',
);

function markdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
  });
}

test('agent prompts omit legacy stack guidance while retaining its recovery skill', () => {
  const promptFiles = [
    path.join(repoRoot, 'home-manager/common/agents.md'),
    path.join(repoRoot, 'home-manager/common/agents-cc-sdd.md'),
    path.join(repoRoot, 'home-manager/common/subagent-context-budget/plugin.ts'),
    path.join(repoRoot, 'home-manager/common/subagent-context-budget/smoke-catalog.json'),
    ...markdownFiles(path.join(repoRoot, 'home-manager/common/agents')),
    ...markdownFiles(path.join(repoRoot, 'home-manager/common/commands')),
    ...markdownFiles(path.join(repoRoot, 'home-manager/common/skills')),
    ...markdownFiles(path.join(repoRoot, 'home-manager/common/subagent-context-budget/instructions')),
    ...markdownFiles(path.join(repoRoot, 'configurations/shopify/home-manager/agents')),
    ...markdownFiles(path.join(repoRoot, 'configurations/shopify/home-manager/commands')),
    ...markdownFiles(path.join(repoRoot, 'configurations/shopify/home-manager/skills')),
  ].filter((file) => file !== retainedSkill);

  const forbidden = [
    /\bgraphite\b/i,
    /\bgt\b/i,
    /\bgt-mcp\b/i,
    /\.graphite(?:_|\b)/i,
  ];

  for (const file of promptFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, path.relative(repoRoot, file));
    }
  }

  assert.equal(fs.existsSync(retainedSkill), true);
  assert.match(fs.readFileSync(retainedSkill, 'utf8'), /name: graphite-pitfalls/);

  const shopifyConfig = fs.readFileSync(
    path.join(repoRoot, 'configurations/shopify/home-manager/opencode.nix'),
    'utf8',
  );
  assert.match(shopifyConfig, /opencode\/skills\/graphite-pitfalls/);
  assert.equal(
    fs.existsSync(
      path.join(repoRoot, 'configurations/shopify/home-manager/agents-graphite.md'),
    ),
    false,
  );
});
