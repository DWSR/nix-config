'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runbookPath = path.join(__dirname, '..', '..', 'docs', 'gh-stack-mcp.md');

test('operator runbook documents the Stack MCP contract and offline/manual boundary', () => {
  assert.ok(fs.existsSync(runbookPath), `operator runbook exists: ${runbookPath}`);
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const assertFact = (pattern, description) => {
    assert.ok(pattern.test(runbook), `runbook documents ${description}`);
  };

  assertFact(/## Local and remote Stack roles/i, 'local and remote Stack roles');
  assertFact(/\.git\/gh-stack/, 'local tracking metadata');
  assertFact(/remote GitHub Stack object/i, 'remote Stack objects');
  assertFact(/typed local Stack MCP/i, 'typed local worktree operations');
  assertFact(/GitHub MCP/i, 'the remote GitHub MCP role');

  assertFact(/`gh auth status`/, 'the existing gh authentication check');
  assertFact(/`gh auth login`/, 'the existing host provisioning path');
  assertFact(
    /`MCP_GITHUB_TOKEN`[\s\S]{0,180}(?:not|isn't|is not)[\s\S]{0,100}substitute/i,
    'that MCP_GITHUB_TOKEN does not replace gh authentication',
  );
  assertFact(/Git signing and hooks remain enabled/i, 'host signing and hooks');

  assertFact(/\| `view` \| 45 seconds \|/i, 'the 45-second view ceiling');
  assertFact(/\| `init`, `add`, `checkout` \| 5 minutes \|/i, 'the 5-minute setup ceilings');
  assertFact(
    /\| `rebase`, `sync`, `push`, `submit`, `link`, `unstack` \| 15 minutes \|/i,
    'the 15-minute mutation ceilings',
  );
  assertFact(/5 seconds[\s\S]{0,80}(?:cleanup|reap)/i, 'the cleanup and reaping reserve');
  assertFact(/10 seconds[\s\S]{0,80}(?:proxy.delivery|delivery reserve)/i, 'the proxy delivery reserve');
  assertFact(/15m15s/, 'the global mcpproxy timeout');
  assertFact(/930000 milliseconds/, 'the OpenCode timeout value');
  assertFact(/15m30s/, 'the OpenCode timeout duration');
  assertFact(/unrelated (?:MCP )?tools/i, 'the shared effect on unrelated tools');

  assertFact(/127\.0\.0\.1:8080/, 'the loopback listener address');
  assertFact(/unauthenticated loopback/i, 'the unauthenticated loopback boundary');
  assertFact(/any\s+local process or account/i, 'access by any local process or account');
  assertFact(/allows typed local Stack MCP calls without a human authorization prompt/i, 'approval-free local Stack tool calls');
  assertFact(/Agent-side preflight and effects previews are not backend authentication/i, 'that agent checks are not backend authentication');
  assertFact(/same.named fork PR/i, 'same-named fork association risk');
  assertFact(/only for `submit` and\s+`link`/i, 'the publication-only agent head check');
  assertFact(/direct MCP clients? bypass/i, 'the direct-client preflight bypass');
  assertFact(/check.to.CLI lookup race/i, 'the check-to-CLI race');

  assertFact(/`exited_unverified`/, 'completed but unverified writes');
  assertFact(/`timed_out_unknown`/, 'timed-out outcomes');
  assertFact(
    /`timed_out_unknown` can result from\s+deadline expiry or process cancellation\/interruption/i,
    'deadline expiry or process cancellation/interruption as timed-out unknown outcomes',
  );
  assertFact(/`cleanup_unknown`/, 'uncertain cleanup outcomes');
  assertFact(/Never retry without reinspection/i, 'the no-blind-retry rule');
  assertFact(/unambiguous fresh inspections and an effects preview, not human authorization/i, 'approval-free verified retries');
  assertFact(/Git-MCP[\s\S]{0,180}absolute `path`/i, 'explicit-path local inspection');
  assertFact(/GitHub MCP[\s\S]{0,180}(?:PR|Stack) membership/i, 'remote PR and Stack inspection');
  assertFact(
    /After `exited_unverified`,\s*`timed_out_unknown`,\s*`cleanup_unknown`, or partial output,\s*do not claim success unless fresh local\s+refs and worktree status[\s\S]{0,160}affected remote PR heads and Stack membership[\s\S]{0,100}postcondition/i,
    'the before-success local and remote postcondition gate after unverified or partial writes',
  );
  assertFact(/standalone `push` is non.atomic/i, 'non-atomic standalone push');
  assertFact(/per.branch force.with.lease/i, 'per-branch push leases');
  assertFact(/sequential publication[\s\S]{0,100}`submit`[\s\S]{0,100}`link`/i, 'sequential partial publication');
  assertFact(/`sync`[\s\S]{0,160}exit code 0[\s\S]{0,100}not proof/i, 'unverified sync exit-zero results');
  assertFact(/unstack[\s\S]{0,180}(?:locked|merged)[\s\S]{0,100}remain/i, 'partial unstack with retained members');
  assertFact(/only the guarded typed `stack_rebase` `continue`/i, 'guarded typed rebase continuation');
  assertFact(/abort[\s\S]{0,140}user.owned/i, 'the user-owned rebase abort handoff');
  assertFact(/agent must\s+not execute `gh stack`/i, 'the no-direct-cli agent boundary');

  assertFact(/## Optional operator.owned disposable.repository smoke/i, 'the optional operator-owned smoke procedure');
  assertFact(/(?:same.repository[\s\S]{0,100}disposable|disposable[\s\S]{0,100}same.repository)/i, 'a disposable same-repository target');
  assertFact(/not\s+production/i, 'the prohibition on production test data');
  assertFact(/retrieve_tools/, 'live tool discovery');
  assertFact(/exact\s+preflight and effects preview/i, 'preflight and effects preview');
  assertFact(/before each mutation; no human authorization is needed/i, 'approval-free local smoke calls');
  assertFact(/verify local and remote results separately/i, 'separate local and remote postflight');
  assertFact(/CI[\s\S]{0,120}(?:does not|never)[\s\S]{0,100}(?:mutate|call).*GitHub/i, 'the no-live-GitHub CI boundary');
});
