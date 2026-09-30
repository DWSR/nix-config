---
description: Restack a GitHub-native Stack with vetted local Stack tools
---

# Rebase Native Stack

Load `github-native-stacks` and follow it for this workflow. Keep `/restack` in
the invoking agent; do not route through `stack-captain` or run its Binks/CI
workflow.

Use GitHub MCP for remote Stack and PR state. Use Git-MCP with an explicit
absolute `path` for every local snapshot and explicit conflict-file staging.
Never execute `gh stack`, imitate Stack operations with per-branch Git calls,
or change PR bases to imitate a local operation.

## Instructions

1. Discover the live GitHub MCP Stack-read tools and local Stack tools through
   mcpproxy. Use each exact returned `name`, `call_with`, and schema.
2. Resolve the owner/repo, current PR, and remote Stack membership/order with
   GitHub MCP. Snapshot the local worktree, current branch, refs, status, and
   remote with Git-MCP using its explicit absolute `path`.
3. For supported local checkout, preview the exact target and obtain the
   operation-specific authorization required by the skill, then invoke the
   discovered `stack_checkout`. If the branch is missing and the skill requires
   CLI checkout, hand off the exact command below and stop.
4. For a requested rebase, choose only the verified scope permitted by the
   skill. Take fresh local/remote snapshots, preview affected branches and
   history-rewrite effects, obtain scoped authorization for `stack_rebase` with
   `action: start`, and invoke the exact discovered typed tool. Never use an
   ordinary Git rebase.
5. For `conflict_pending`, inspect the active rebase and recovery marker through
   the skill's preflight. Resolve only intended files and stage only explicit
   resolved paths through Git-MCP. Before continuing, take fresh local/remote
   snapshots, preview the exact continuation, and obtain fresh scoped
   authorization for `stack_rebase` `action: continue`. Call the discovered tool
   without a scope only when the marker, conflict branch, and active Git rebase
   match. If checks fail, stop at the skill's exact user-owned recovery handoff.
   Never use generic Git rebase continue or abort.
6. Before push, repeat the skill's snapshots and preview every affected branch,
   per-branch force-with-lease, and non-atomic effects. Obtain separate fresh
   scoped authorization for the exact `stack_push` target; rebase authorization
   does not authorize push. Invoke the exact discovered typed tool.
7. After `exited_unverified` or any uncertainty, follow the skill's postflight:
   re-inspect local refs/worktree and affected remote PR/Stack state before
   claiming success or retrying. Stop if the outcome is ambiguous. If state
   changed, repeat the preview and obtain fresh authorization.

## Targeted CLI handoffs

Use a user-owned handoff only when a typed tool is unavailable, the user
explicitly prefers the CLI, or the requested operation is unsupported. Give
only the exact matching command and stop; never run a handed-off command.
Use the skill's PR URL form when checkout targets a pull request.

- Checkout a Stack: `gh stack checkout <stack-number>`.
- Checkout a pull request: `gh stack checkout https://github.com/<owner>/<repo>/pull/<pr-number>`.
- Rebase start: use the exact matching verified scope: `gh stack rebase --remote <remote>`,
  `gh stack rebase --upstack --remote <remote>`,
  `gh stack rebase --downstack --remote <remote>`, or
  `gh stack rebase --no-trunk`.
- Guarded continue by explicit CLI preference or unavailable tool:
  `gh stack rebase --continue`.
- Push: `gh stack push --remote <remote>`.
- Abort only when explicitly requested: `gh stack rebase --abort`.
- TUI restructuring: `gh stack modify`.

Do not initiate merge or unstack from `/restack`.
