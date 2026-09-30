'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const STACK_CAPTAIN_PATH = 'configurations/shopify/home-manager/agents/stack-captain.md';
const RESTACK_PATH = 'configurations/shopify/home-manager/commands/restack.md';
const STACK_HELPERS = Object.freeze([
  {
    name: 'stack-status-sweeper',
    path: 'configurations/shopify/home-manager/agents/stack-status-sweeper.md',
    permissions: {
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      mcpproxy_retrieve_tools: 'allow',
      mcpproxy_call_tool_read: 'allow',
      mcpproxy_call_tool_write: 'deny',
      mcpproxy_call_tool_destructive: 'deny',
      mcpproxy_code_execution: 'deny',
    },
  },
  {
    name: 'ci-log-sleuth',
    path: 'configurations/shopify/home-manager/agents/ci-log-sleuth.md',
    permissions: {
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      mcpproxy_retrieve_tools: 'allow',
      mcpproxy_call_tool_read: 'allow',
      mcpproxy_call_tool_write: 'deny',
      mcpproxy_call_tool_destructive: 'deny',
      mcpproxy_code_execution: 'deny',
    },
  },
  {
    name: 'bot-thread-triager',
    path: 'configurations/shopify/home-manager/agents/bot-thread-triager.md',
    permissions: {
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      mcpproxy_retrieve_tools: 'allow',
      mcpproxy_call_tool_read: 'allow',
      mcpproxy_call_tool_write: 'deny',
      mcpproxy_call_tool_destructive: 'deny',
      mcpproxy_code_execution: 'deny',
    },
  },
  {
    name: 'stack-preflight-auditor',
    path: 'configurations/shopify/home-manager/agents/stack-preflight-auditor.md',
    permissions: {
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      mcpproxy_retrieve_tools: 'allow',
      mcpproxy_call_tool_read: 'allow',
      mcpproxy_call_tool_write: 'deny',
      mcpproxy_call_tool_destructive: 'deny',
      mcpproxy_code_execution: 'deny',
    },
  },
  {
    name: 'stack-fix-reviewer',
    path: 'configurations/shopify/home-manager/agents/stack-fix-reviewer.md',
    permissions: {
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      edit: 'deny',
      write: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      mcpproxy_retrieve_tools: 'allow',
      mcpproxy_call_tool_read: 'allow',
      mcpproxy_call_tool_write: 'deny',
      mcpproxy_call_tool_destructive: 'deny',
      mcpproxy_code_execution: 'deny',
    },
  },
]);

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readAgentPolicy(relativePath) {
  const source = read(relativePath);
  const frontmatterMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatterMatch, `${relativePath} must have YAML frontmatter`);

  const frontmatter = frontmatterMatch[1];
  const lines = frontmatter.split(/\r?\n/);
  const permissionIndex = lines.indexOf('permission:');
  assert.notEqual(permissionIndex, -1, `${relativePath} must declare permissions`);

  const permissions = {};
  for (const line of lines.slice(permissionIndex + 1)) {
    if (line && !/^\s/.test(line)) break;
    const entry = line.match(/^  ([A-Za-z][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/);
    if (entry) permissions[entry[1]] = entry[2] ?? '';
  }

  return { source, frontmatter, permissions };
}

function readBashRules(frontmatter) {
  const bashMatch = frontmatter.match(/^  bash:\r?\n((?:    .*?(?:\r?\n|$))+)/m);
  assert.ok(bashMatch, 'stack-captain must declare Bash rules');

  return Object.fromEntries(
    bashMatch[1]
      .split(/\r?\n/)
      .flatMap((line) => {
        const rule = line.match(/^    "([^"]+)": (allow|ask|deny)$/);
        return rule ? [[rule[1], rule[2]]] : [];
      }),
  );
}

test('stack-captain keeps operation-scoped authorization and native CLI boundaries', () => {
  const captain = readAgentPolicy(STACK_CAPTAIN_PATH);

  assert.equal(captain.permissions.mcpproxy_call_tool_destructive, 'ask');
  assert.equal(captain.permissions.mcpproxy_code_execution, 'deny');
  assert.deepEqual(readBashRules(captain.frontmatter), {
    '*': 'allow',
    'gh stack': 'deny',
    'gh stack *': 'deny',
    git: 'deny',
    'git *': 'deny',
  });

  assert.match(captain.source, /request explicit user\s+authorization for one operation/);
  assert.match(
    captain.source,
    /Name the absolute worktree, Git remote and\s+GitHub owner\/repository, operation and rebase scope\/options, affected\s+branches in bottom-to-top order, and effects including rewritten history/,
  );
  assert.match(
    captain.source,
    /effects including rewritten history,\s+review\/CI impact, per-branch force-with-lease, and possible partial or\s+non-atomic publication/,
  );
  assert.match(
    captain.source,
    /Authorization for a\s+rebase does not cover a later push; inspect again and obtain separate push\s+authorization/,
  );
  assert.match(
    captain.source,
    /request explicit, operation-specific user\s+authorization naming the exact absolute worktree, Git remote and\s+repository, source branch, upstream\/target ref, commit SHAs and subjects,\s+and this normal, non-force Git-MCP push/,
  );
  assert.match(captain.source, /Do not merge PRs\./);
  assert.match(captain.source, /Never initiate merge or unstack by any route\./);
  assert.doesNotMatch(captain.source, /\b(?:stack_merge|stack_unstack)\b|gh stack (?:merge|unstack)\b/);
});

test('Shopify Stack helpers preserve read-only permissions and deny proxy code execution', () => {
  for (const helper of STACK_HELPERS) {
    const policy = readAgentPolicy(helper.path);
    assert.deepEqual(
      policy.permissions,
      helper.permissions,
      `${helper.name} must retain its existing read-only permissions and explicit proxy denies`,
    );
  }
});

test('/restack stays in the invoking agent and uses typed operations with targeted handoffs', () => {
  const restack = read(RESTACK_PATH);

  assert.match(restack, /Keep `\/restack` in\s+the invoking agent/);
  assert.doesNotMatch(restack, /^agent:\s*stack-captain\s*$/m);
  assert.match(restack, /invoke the\s+discovered `stack_checkout`/);
  assert.match(restack, /`stack_rebase` with\s+`action: start`, and invoke the exact discovered typed tool/);
  assert.match(restack, /fresh scoped\s+authorization for `stack_rebase` `action: continue`/);
  assert.match(restack, /Call the discovered tool\s+without a scope only when the marker, conflict branch, and active Git rebase\s+match/);
  assert.match(
    restack,
    /separate fresh\s+scoped authorization for the exact `stack_push` target; rebase\s+authorization\s+does not authorize push\. Invoke the exact discovered typed tool/,
  );

  assert.match(
    restack,
    /Use a user-owned handoff only when a typed tool is unavailable, the user\s+explicitly prefers the CLI, or the requested operation is unsupported\./,
  );
  assert.match(restack, /Give\s+only the exact matching command and stop; never run a handed-off command\./);
  assert.match(restack, /Checkout a Stack: `gh stack checkout <stack-number>`/);
  assert.match(
    restack,
    /Checkout a pull request: `gh stack checkout https:\/\/github\.com\/<owner>\/<repo>\/pull\/<pr-number>`/,
  );
  assert.match(restack, /Rebase start: use the exact matching verified scope:/);
  assert.match(restack, /Guarded continue by explicit CLI preference or unavailable tool:\s+`gh stack rebase --continue`/);
  assert.match(restack, /Push: `gh stack push --remote <remote>`/);
  assert.match(restack, /Abort only when explicitly requested: `gh stack rebase --abort`/);
  assert.match(restack, /TUI restructuring: `gh stack modify`/);
  assert.match(restack, /Never execute `gh stack`, imitate Stack operations with per-branch Git calls/);
  assert.match(restack, /Do not initiate merge or unstack from `\/restack`\./);
  assert.doesNotMatch(restack, /gh stack (?:merge|unstack)\b/);
});

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
