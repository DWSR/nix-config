'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('make-stack-green treats a standalone PR as a one-member Stack', () => {
  const command = read(
    'configurations/shopify/home-manager/commands/make-stack-green.md',
  );
  const captain = read(
    'configurations/shopify/home-manager/agents/stack-captain.md',
  );
  const preflight = read(
    'configurations/shopify/home-manager/agents/stack-preflight-auditor.md',
  );

  assert.match(command, /PR without native\nStack membership as a one-PR Stack/);
  assert.match(captain, /An empty list is `kind: standalone`/);
  assert.match(captain, /push the ordinary fix commit through Git-MCP without\n   force/);
  assert.match(captain, /standalone PR skips only native\n    topology and cascade operations/);
  assert.match(preflight, /Empty\n  membership is standalone/);
  assert.match(preflight, /Do not recommend `gh stack` for a standalone target/);
});
