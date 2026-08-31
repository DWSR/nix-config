---
name: github-native-stacks
description: >-
  Interact with GitHub-native pull request Stack objects through the GitHub
  MCP. Use ONLY when the user explicitly mentions GitHub native stacks,
  native Stack objects, or `gh stack`, or explicitly asks to list, inspect,
  create, extend, or unstack one. Do not trigger for generic stacked PRs or
  stacks managed by another tool.
---

# GitHub Native Stacks

Manage GitHub's remote pull request Stack objects through the `github` MCP
upstream. A native Stack is an ordered chain of existing pull requests. Each
pull request above the bottom targets the head branch of the pull request below
it.

This skill is explicit-only. Generic requests about stacked PRs continue to use
the repository's existing version-control policy. Never convert a stack managed
by another tool into a GitHub-native Stack unless the user explicitly asks.

## Scope and boundaries

The GitHub MCP can:

- List native Stacks in a repository.
- Find the Stack containing a pull request.
- Get one Stack by its human-facing Stack number.
- Create a Stack from at least two existing pull requests.
- Append existing pull requests to the top of a Stack.
- Unstack eligible pull requests remotely.
- Read each member pull request's details, checks, reviews, and comments with
  the ordinary pull request tools.

The GitHub MCP cannot perform local `gh stack` operations. It cannot fetch or
reconcile a worktree, maintain `.git/gh-stack`, cascade-rebase branches, push a
stack, reorder commits, check out a locally tracked Stack, or invoke the
stack-wide asynchronous merge operation.

Never execute `gh stack` by any mechanism. Every `gh stack` command in this
skill is a user-owned handoff, not an agent command. Inspect through MCP,
explain the capability boundary, and provide the exact command the user can
run. Use Git-MCP automatically only for the safe operations listed in
"Git-MCP recovery boundary" below.

Application-code repair on one verified existing member branch is distinct
from Stack orchestration. When the user explicitly requests a code fix,
Git-MCP may stage explicit paths and create one ordinary fix commit on that
branch. It must not amend or rewrite existing Stack commits, and the required
cascade rebase or push remains a user-owned `gh stack` handoff.

## Terminology and ordering

- Stack order is always bottom-to-top. The bottom pull request targets the
  trunk. Every later pull request targets the preceding pull request's head
  branch.
- `number` is the human-facing Stack number accepted as `stackNumber`.
- `id` is an internal database identifier. Never pass `id` as `stackNumber`.
- A remote Stack object is not local `gh stack` tracking. Remote mutations do
  not update `.git/gh-stack` in any checkout.
- A Stack can be closed while remaining readable. Do not assume list results
  contain only open Stacks.

## Discover tools before every workflow

All calls go through mcpproxy's discover-then-invoke surface. Never invent a
tool name or invoke a `github:*` tool directly.

1. Discover reads with
   `retrieve_tools(query: "github native pull request stack read")`.
2. Expect `github:pull_request_stack_read`, then invoke it through
   `call_tool_read`.
3. Discover mutations with
   `retrieve_tools(query: "github native pull request stack write")`.
4. Expect `github:pull_request_stack_write`. Its current annotation is
   destructive for every method, so invoke `create`, `add`, and `unstack`
   through `call_tool_destructive`, not `call_tool_write`.
5. Discover supplemental tools separately, such as
   `github:pull_request_read`, `github:create_pull_request`, and
   `github:update_pull_request`. Follow each result's `call_with` value.
6. If a compact signature is lossy or differs from this skill, call
   `mcpproxy_describe_tool` before use. Stop if the live schema cannot support
   the requested operation.

Every `call_tool_*` call receives the upstream parameters under `args`. Include
an operation-specific `intent_reason`. Use `intent_data_sensitivity: "public"`
only for a repository known to be public; otherwise use `"private"`.

If the Stack tools are absent, report that the running GitHub MCP does not
expose native Stacks. Do not emulate a native Stack by merely inferring a chain
of PR base branches.

## Resolve and read a Stack

Collect `owner` and `repo` plus either a Stack number or pull request number.
Parse them from a GitHub URL when possible; otherwise ask one concise question.

To find the Stack containing a pull request:

```text
pull_request_stack_read
  method: list
  owner: <owner>
  repo: <repo>
  pullNumber: <pr-number>
```

An empty list means that pull request is not currently in a native Stack. More
than one result is unexpected; stop and show the returned Stack numbers rather
than choosing one.

To read an identified Stack:

```text
pull_request_stack_read
  method: get
  owner: <owner>
  repo: <repo>
  stackNumber: <stack-number>
```

Use `method: list` with `page` and `perPage` for repository-wide listing.
Continue pagination when the user asks for all Stacks. Do not silently return
only the first page.

Present Stack members bottom-to-top. Include the Stack number, `open` state,
base ref, and each pull request's number, state, draft status, merge time, head
ref, and head SHA. Fetch detailed pull request state only when needed:

- `pull_request_read` method `get` for base/head refs and ordinary PR state.
- `get_check_runs` for CI status.
- `get_reviews` for approvals and change requests.
- `get_review_comments` for review threads.

Fan out read-only calls in parallel, but preserve bottom-to-top ordering in the
reported result.

## Mutation authorization and snapshots

Read the latest Stack and affected pull requests immediately before every
mutation.

An explicit request naming the repository and exact PR order authorizes one
`create` or `add` call after a successful preflight and preview. Ask before the
call when the repository, order, target Stack, or intended PR set was inferred.

Always ask immediately before `unstack`, even when it was requested earlier.
State which PRs are eligible to leave, which merged or queued PRs may remain,
and that local `.git/gh-stack` state will not be changed.

Before a multi-call workflow, capture and report a snapshot containing:

- Stack number and internal ID.
- Stack base ref.
- Bottom-to-top PR numbers.
- Each PR's base ref, head ref, head SHA, state, draft state, and merge state.

A confirmation authorizes only the described operation. It does not authorize
a changed order, additional PRs, force-push, merge, or a retry after state has
changed. Re-read before retrying.

## Create a Stack

Creation links existing PRs; it does not create branches or pull requests.

1. Require at least two unique PR numbers in explicit bottom-to-top order.
2. Read every PR and verify it belongs to the same repository.
3. Verify the bottom PR targets the intended trunk.
4. Verify each later PR's base ref equals the preceding PR's head ref.
5. Find Stack membership for every PR with `method: list` plus `pullNumber`.
   Stop if any PR already belongs to another Stack.
6. Preview the trunk and full bottom-to-top chain.
7. Invoke `pull_request_stack_write` through `call_tool_destructive`:

```text
method: create
owner: <owner>
repo: <repo>
pullNumbers: [<bottom>, ..., <top>]
```

8. Read the returned Stack number with `method: get` and verify the exact order
   and head SHAs before reporting success.

Do not silently update PR bases to make an invalid chain pass validation. Base
changes alter review diffs and can require branch-history rewrites.

## Add to a Stack

The API only appends to the top. It cannot insert into the middle.

1. Get the current Stack and identify its current top PR and head ref.
2. Require at least one unique new PR in bottom-to-top segment order.
3. Verify the first new PR targets the current top PR's head ref.
4. Verify each remaining PR targets the preceding new PR's head ref.
5. Verify none of the new PRs belongs to another Stack.
6. Preview the existing chain and appended segment.
7. Invoke through `call_tool_destructive`:

```text
method: add
owner: <owner>
repo: <repo>
stackNumber: <stack-number>
pullNumbers: [<first-new>, ..., <new-top>]
```

8. Get the Stack again and verify the complete order and head SHAs.

If the requested PR belongs in the middle, follow the restructuring guidance;
never append it and claim the requested order was achieved.

## Unstack remotely

Unstacking removes eligible PRs from the remote grouping. It does not delete
branches or PRs and does not change their base branches. Merged, queued, or
otherwise locked PRs can remain in the Stack.

1. Get the latest Stack and snapshot its members.
2. Explain that this is a remote-only mutation and always ask for confirmation.
3. Invoke through `call_tool_destructive` without `pullNumbers`:

```text
method: unstack
owner: <owner>
repo: <repo>
stackNumber: <stack-number>
```

4. Interpret `dissolved: true` as complete dissolution. The old Stack can no
   longer be fetched; verify completion by filtering for each former PR and
   expecting no Stack membership.
5. Interpret `dissolved: false` plus `stack` as partial unstacking. Get the
   retained Stack, report every retained PR, and verify removed PRs by their
   membership filters. Do not claim dissolution.

If a local checkout tracks the Stack, tell the user that the next local sync or
submit can recreate the remote grouping. After complete remote dissolution,
provide this specifically targeted cleanup handoff when they want local
tracking removed too:

```bash
gh stack unstack <stack-number> --local
```

After a partial remote unstack, locked PRs still remain grouped remotely. The
same local-only command may remove local tracking if the user explicitly wants
that independent effect, but it cannot make both sides fully unstacked. Never
execute the command from the skill.

## Stack-wide operations

The public Stack API exposes list, get, create, append, and unstack. It does not
expose cascade sync, cascade rebase, arbitrary reorder, local checkout, push,
or stack-wide merge. Never simulate one of these operations by looping a
single-PR tool when the semantics differ.

### Cascade sync

For a sync request, inspect the remote Stack and fan out PR/check/review reads.
If a local path is available, Git-MCP may inspect status, branches, worktrees,
logs, and diffs with that explicit absolute path. This is diagnosis only.

Do not call `update_pull_request_branch` for every PR. That endpoint updates
one branch independently and does not reconcile local Stack metadata, preserve
commit boundaries, perform a bottom-to-top cascade, or provide atomic rollback.

Provide this handoff:

```bash
gh stack sync --remote <remote>
```

Add `--prune` only when the user explicitly wants merged local branches
deleted. Never omit `--remote` unless `remote.pushDefault` is known to be
configured.

Explain the effects before handing off: sync fetches remote changes,
reconciles local and remote Stack composition, fast-forwards trunk, rebases
bottom-to-top, atomically pushes rewritten active branches with per-branch
force-with-lease, refreshes PR state, and reconciles the remote Stack object.
History rewrites can invalidate approvals and restart CI across every changed
upstack PR.

If sync reports a conflict, inspect its restoration summary. When it confirms
that every branch was restored, do not reset anything; hand off to the
conflict-capable rebase workflow below. If it reports any restoration failure,
use Git-MCP status, log, and reflog reads to diagnose the remaining state, then
stop. Do not recommend another rebase or synthesize hard-reset commands until
the exact branch tips are known.

### Cascade rebase

The GitHub website has a server-side **Rebase Stack** operation, but the
documented API does not expose it. Do not call an undocumented endpoint. Warn
that server-side rebases create unsigned commits; repositories requiring signed
commits should use the local CLI.

Provide the command matching the requested scope:

```bash
gh stack rebase --remote <remote>
gh stack rebase --upstack --remote <remote>
gh stack rebase --downstack --remote <remote>
gh stack rebase --no-trunk
```

Use `--upstack` after editing a lower layer. Use `--downstack` to update only
the path from trunk through the current layer. Use `--no-trunk` only when the
user explicitly wants to align Stack branches without pulling trunk.

A local rebase does not push. After success, provide:

```bash
gh stack push --remote <remote>
```

Explain that push uses per-branch force-with-lease and is not atomic. The user
must inspect and retry any rejected branch rather than assuming the whole Stack
landed.

For a rebase conflict, the agent may inspect and edit conflicted files, then
stage explicit resolved paths through Git-MCP. The user must advance or restore
the Stack with:

```bash
gh stack rebase --continue
gh stack rebase --abort
```

Never substitute generic `git-mcp:git_rebase` continue or abort. Those
operations know only the current Git rebase; they do not advance the remaining
Stack branches or restore branches already rebased by `gh stack`.

### Reorder, insert, drop, rename, or change trunk

Changing Stack metadata or PR base fields does not rewrite Git ancestry. Never
reorder by only changing PR bases, and never invent `git rebase --onto`
boundaries. A wrong boundary can duplicate or drop commits from every upstack
branch.

For a human interactive session, provide:

```bash
gh stack modify
```

`modify` is TUI-only. Never execute it from an agent session.

For a non-interactive rebuild, provide the shape of the workflow without
inventing the history-rewrite commands:

```bash
gh stack unstack
# Rewrite branch ancestry bottom-to-top using verified old boundary SHAs.
gh stack init --base <trunk> <bottom> ... <top>
gh stack submit --auto --remote <remote>
```

Tell the user to capture every old branch tip and parent boundary before
rewriting anything. Existing PRs survive unstacking; submit updates their bases
and relinks the Stack after ancestry is correct.

A remote-only metadata relink through MCP is allowed only when every PR's
existing base ref already matches the requested bottom-to-top order. Snapshot
the original Stack and PR bases, explain that unstack plus recreate is
non-atomic, and ask for confirmation that also authorizes best-effort rollback
to the captured order. Stop if any PR is merged, queued, locked, or requires a
base or history change.

### Stack-wide merge

Use Stack and PR read tools to report the exact merge set and blockers. Read
draft state, checks, and reviews for every unmerged PR in that set.

Never loop `merge_pull_request`. Individual merges do not reproduce the Stack
API's all-or-nothing validation or merge-queue behavior and can leave the Stack
partially merged.

The CLI interprets a bare number as a Stack number before trying it as a PR
number. Resolve the target type through MCP before composing the command. For a
PR-scoped merge, first verify that `method: get` with the same numeric value
does not resolve a Stack, then verify that filtering by the PR number returns
the intended Stack. If the value resolves as a Stack number, do not describe
the command as PR-scoped.

Provide one scoped handoff:

```bash
gh stack merge <stack-number-or-pr-number> --yes
gh stack merge <target> --yes --squash
gh stack merge <target> --yes --merge
gh stack merge <target> --yes --rebase
```

Ask which merge method to show when the user did not specify one. A PR number
means that PR plus every unmerged PR below it; a Stack number means every
unmerged PR in the Stack. If the base uses a merge queue, the queue chooses the
method and may land the PRs in separate groups.

### Submit or link

The MCP can perform the remote-only portion when all branches already exist on
GitHub. It may create missing PRs bottom-to-top with `create_pull_request`, then
create or append the native Stack after a separate preview and authorization.

Do not create missing PRs implicitly. State that the multi-call workflow is
not atomic and report each created PR immediately so a later failure can be
resumed without duplication. Check for an existing PR by head branch before
every creation retry.

The MCP cannot push local branches, generate or maintain `.git/gh-stack`, or
rebase an invalid chain. When any of those are needed, provide:

```bash
gh stack submit --auto --remote <remote>
```

Add `--open` only when the user wants new and existing PRs marked ready for
review. Otherwise new PRs remain drafts.

### Push

Do not loop `git-mcp:git_push` as a stack-wide push. Per-branch calls lose the
CLI's lease coordination and can leave an unreported partial result. Provide:

```bash
gh stack push --remote <remote>
```

Explain that this pushes every active branch with per-branch force-with-lease,
is not atomic, and never creates or updates PRs.

### Checkout and navigation

The MCP can return the bottom-to-top branch order. Git-MCP may check out an
existing local branch after verifying it belongs to the requested remote
Stack, but that does not create local Stack tracking.

Provide this handoff when local tracking or missing branches are involved. Use
the PR URL form when targeting a PR so intent is explicit:

```bash
gh stack checkout <stack-number>
gh stack checkout https://github.com/<owner>/<repo>/pull/<pr-number>
```

For `up`, `down`, `top`, `bottom`, or `trunk`, report the resolved target branch
from remote order. Use Git-MCP checkout only when the branch already exists
locally and the user asked to switch. Otherwise provide the matching
`gh stack` navigation command. Never use the interactive `gh stack switch`.

### Split, combine, or remove one member

The unstack endpoint removes every eligible member, not one selected PR. A
split, combine, middle removal, or trunk change is a restructuring workflow.
Use the reorder guidance. Stop when merged or queued PRs lock the existing
Stack shape.

### Fan-out operations across members

Read-only fan-out, such as checks, reviews, files, or comments, is safe to run
in parallel and report bottom-to-top.

Additive or idempotent per-PR writes, such as requesting the same reviewers,
may run only after an explicit request naming the affected PR set. State that
the operation is not atomic, process deterministically, and report each partial
success or failure.

Never fan out merges, base changes, branch updates, closes, force-pushes, or
other topology/history mutations as a substitute for a Stack operation.

## Git-MCP recovery boundary

Every Git-MCP call must include the explicit absolute repository `path`.

Git-MCP may perform these supporting operations when requested:

- Read status, current branch, branch lists, worktrees, logs, and diffs.
- Fetch a named remote after explicit authorization to update local refs.
- Check out an existing local branch identified from remote Stack order.
- Stage explicit paths and create one ordinary fix commit for an explicitly
  requested code repair on a verified member branch.
- Stage explicit conflict-resolution paths after the files are resolved.

Git-MCP must not be used to imitate these `gh stack` operations:

- Cascade rebase or sync.
- Continue or abort a `gh stack` rebase.
- Multi-branch or atomic Stack push.
- Amend, reset, or rewrite existing Stack member commits.
- Stack reorder, split, combine, or commit-boundary reconstruction.
- Hard-reset rollback of a partially changed Stack.
- Editing or synthesizing `.git/gh-stack` metadata.

If a safe automatic Git-MCP recovery is unavailable, stop after diagnosis and
provide the exact `gh stack` command. Do not downgrade to a sequence with weaker
atomicity or recovery guarantees.

## Error handling

- `404` from list commonly means native Stacks are unavailable for the
  repository. From get it can also mean the Stack number does not exist.
  Preserve the API message and explain both possibilities when ambiguous.
- `409` means another request is modifying the Stack. Re-read it, show the new
  order and SHAs, and ask before retrying. Never retry in a loop.
- `422` means the requested PR chain or mutation is invalid, or unstacking
  cannot remove any locked member. Re-read PR bases and Stack membership;
  never coerce the request with unapproved base changes.
- A timeout does not prove a mutation failed. Read the Stack or filter by PR
  before retrying so the operation is not duplicated.
- On any partial multi-call workflow, stop at the first unexpected failure,
  report completed mutations, and present a recovery based on the captured
  snapshot.

## Completion checks

Before claiming create or add succeeded:

1. Get the Stack again by its human-facing number.
2. Verify the base ref, exact bottom-to-top PR order, and head SHAs.
3. Verify every affected PR still has the expected base and head refs.

Before claiming unstack succeeded:

1. For complete dissolution, verify every former eligible PR has no Stack
   membership. Treat the old Stack's `404` as the expected postcondition.
2. For partial unstacking, get the retained Stack and verify both retained and
   removed memberships.

For every operation, report remote-only effects and local follow-up separately,
and state any unsupported or user-owned `gh stack` handoff still pending.
