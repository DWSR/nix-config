---
name: github-native-stacks
description: >-
  Interact with GitHub-native pull request Stack objects through GitHub MCP and
  typed local Stack MCP tools. Use ONLY when the user explicitly mentions
  GitHub native stacks, native Stack objects, or `gh stack`, or explicitly asks
  to list, inspect, create, extend, or unstack one. Do not trigger for generic
  stacked PRs or stacks managed by another tool.
---

# GitHub Native Stacks

Manage GitHub-native Stacks across their remote pull request objects and local
`gh stack` tracking. Use GitHub MCP for remote Stack objects and, when
advertised, the typed local Stack MCP tools for worktree operations. A native
Stack is an ordered chain of existing pull requests. Each pull request above
the bottom targets the head branch of the pull request below it.

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

When advertised, a separate local Stack MCP provides typed worktree operations.
Discover it at runtime and use the absent-tools handoff if it is unavailable.
Local tracking and remote Stack objects are distinct: a local metadata
observation is not a remote postcondition, and a GitHub MCP mutation does not
update `.git/gh-stack`.

Never execute `gh stack` by any mechanism. Every `gh stack` command in this
skill is a user-owned handoff, not an agent command. For supported local work,
use the discovered typed Stack MCP tools. Use Git-MCP automatically only for
the safe operations listed in "Git-MCP recovery boundary" below.

Application-code repair on one verified existing member branch is distinct
from Stack orchestration. When the user explicitly requests a code fix,
Git-MCP may stage explicit paths and create one ordinary fix commit on that
branch. It must not amend or rewrite existing Stack commits. Any required
cascade rebase or push uses the typed local Stack MCP tool after its own
preflight and effects preview, or a user-owned `gh stack` handoff if that tool is
unavailable.

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
tool name or invoke a `github:*` or local Stack MCP tool directly.

### Local Stack tools

1. Discover the live local catalog for each workflow with
   `retrieve_tools(query: "local gh-stack Stack worktree operations")`.
2. The designed tool names are `stack_view`, `stack_init`, `stack_add`,
   `stack_checkout`, `stack_rebase`, `stack_sync`, `stack_push`,
   `stack_submit`, `stack_link`, and `stack_unstack`. The returned `name` is
   authoritative; use its exact qualified value and its `call_with` route.
3. The designed route for `stack_view` is `call_tool_write` because it refreshes
   local Stack metadata. The designed route for every mutation is
   `call_tool_destructive`. Follow the live `call_with` value, and stop to
   inspect the schema if the discovered route or tool contract differs.
4. If local Stack tools are not advertised, say the running proxy does not
   expose them. Do not emulate them with GitHub MCP, Git-MCP sequences, or
   individual pull-request calls; give the matching user-owned `gh stack`
   handoff from the operation guidance below.

### Remote GitHub MCP tools

1. Discover reads with
   `retrieve_tools(query: "github native pull request stack read")`.
2. Expect `github:pull_request_stack_read`, then invoke it through
   `call_tool_read` using the exact discovered name and `call_with` value.
3. Discover mutations with
   `retrieve_tools(query: "github native pull request stack write")`.
4. Expect `github:pull_request_stack_write`. Its current annotation is
   destructive for every method, so invoke `create`, `add`, and `unstack`
   through `call_tool_destructive`, not `call_tool_write`, when that is the
   discovered route.
5. Discover supplemental tools separately, such as
   `github:pull_request_read`, `github:create_pull_request`, and
   `github:update_pull_request`. Follow each result's exact `name` and
   `call_with` value.
6. If a compact signature is lossy or differs from this skill, call
   `mcpproxy_describe_tool` before use. Stop if the live schema cannot support
   the requested operation.

Every `call_tool_*` call receives the upstream parameters under `args`. Include
an operation-specific `intent_reason`. Use `intent_data_sensitivity: "public"`
only for a repository known to be public; otherwise use `"private"`.

If the remote GitHub Stack tools are absent, report that the running GitHub MCP
does not expose native Stacks. Do not emulate a native Stack by merely
inferring a chain of PR base branches.

## Local Stack MCP workflow

### User-owned CLI handoffs when local tools are absent

Never replace a missing local MCP tool with a GitHub API or Git-MCP sequence.
Give the matching command for the user to run in their own terminal. The
designed local CLI forms for operations not detailed in later sections are:

```bash
gh stack view
gh stack init --base <trunk> <bottom> ... <top>
gh stack add <branch> [-u|-A] [-m <message>]
gh stack checkout <branch>
gh stack link --remote <remote>
gh stack unstack <stack-number>          # remoteAndLocal
gh stack unstack <stack-number> --local   # localOnly
```

The unqualified unstack form is `remoteAndLocal`; `--local` is `localOnly`.
Use the operation-specific handoffs below for checkout, rebase, sync, push, and
submit. These are user-owned handoffs only; never execute them from the agent.

### Snapshots, previews, and local tool calls

`stack_view` is a local observation that refreshes Stack metadata, so it is a
write-class call, not a read-only operation. Use Git-MCP with the explicit
absolute worktree `path` on every call to identify the target worktree, current
branch, status, branch refs, and configured remote before local Stack work.
Use GitHub MCP to inspect the relevant remote Stack membership and affected PR
state; record when no remote Stack or PR is associated with the target. Call
`stack_view` whenever local tracking state is needed for inspection, preflight,
or postflight. Name its exact worktree and remote, and disclose that it refreshes
local metadata.

Before each local mutation (`stack_init`, `stack_add`, `stack_checkout`,
`stack_rebase`, `stack_sync`, `stack_push`, `stack_submit`, `stack_link`, or
`stack_unstack`):

1. Take fresh Git-MCP and relevant GitHub MCP snapshots for the exact worktree,
   remote, branches, and PRs. Present the local branch order and status plus
   the remote Stack number/order and affected PR refs, states, and membership.
2. Preview the exact branches, paths, and side effects. For `stack_add` with
   `stage: all`, enumerate every untracked and changed path before staging; do
   not silently stage unrelated files. For `stack_sync` with pruning, enumerate
   the exact local branches that would be pruned. For rebase, sync, and push,
   name every affected branch and disclose history rewrites, per-branch
   force-with-lease, and non-atomic push effects as applicable.
3. Call the exact discovered tool for the inspected absolute worktree, Git
   remote, GitHub owner/repository, affected branches in order, operation, and
   options. No additional human authorization or confirmation is required for
   any `gh-stack-mcp` tool call, including `stack_unstack` or a verified retry.
   If the inspected state changes, repeat the snapshots and preview before
   calling. Ask for missing target details only when the target or mode cannot
   be established from the request and the snapshots.

### Submit and link PR-head preflight

Before any local `stack_submit` or `stack_link`, and before a remote-only
workflow creates PRs by branch name, enumerate all open PRs in the target
repository with the discovered GitHub MCP list operation. Paginate through
every page until all pages are exhausted; a head-filtered query or first
page alone is not an exhaustive check. For each affected branch, match
`head.ref` by exact branch name and inspect both the head repository and base
repository associations.

Stop before submit/link for incomplete pagination, a matching PR with a foreign
or unknown head or base repository association, or multiple matches for an
affected branch (more than one open PR). Report the matching PR number, exact
head, and both repository associations. A branch with no matching PR is not an
existing PR: stop a `stack_link` until an existing PR is identified; for
`stack_submit`, include any missing PR creation in the preview before proceeding.
Never create PRs implicitly during a link or an unverified retry.

After submit/link, inspect local refs with Git-MCP and re-read the affected PRs
and Stack membership with GitHub MCP. Verify each branch-to-PR association,
expected head/base refs, and exact Stack order before reporting success. Stop
and report uncertainty rather than retrying when the result is ambiguous.

### Unstack locally

After the latest local and remote snapshots, preview the exact Stack number,
absolute worktree, remote and GitHub repository, affected branches, and `mode`:
`remoteAndLocal` or `localOnly`. State the effects of the selected mode, then
call `stack_unstack` without an additional human confirmation.

Require a positive explicit Stack number in either mode; never infer the active
Stack number. If the local Stack has no remote Stack number, do not call the
tool and provide a user-owned local CLI handoff.

- `remoteAndLocal` removes eligible remote Stack grouping and local tracking;
  it does not delete branches or PRs, and merged, queued, or locked PRs may
  remain in the remote Stack.
- `localOnly` removes local tracking only; remote Stack grouping is unchanged.

After `remoteAndLocal`, re-inspect membership for every former PR with GitHub
MCP and verify local state with Git-MCP. Report any retained locked, merged, or
queued PRs. Claim full dissolution only after every former eligible PR is
verified to have no Stack membership. Never imply that unstack deletes a
branch or PR.

### Postflight and uncertain outcomes

Every local mutation can return `exited_unverified`; an exit code or
success-looking CLI output is not proof of its postcondition. After that status
or any timeout, cleanup uncertainty, partial result, or other uncertainty,
re-inspect local refs and worktree state with Git-MCP and relevant remote PR
and Stack membership with GitHub MCP before claiming success or retrying. If
the snapshots do not establish one unambiguous outcome, stop, report what is
known, and do not retry. A later attempt requires fresh, unambiguous snapshots
and an effects preview, not human authorization. Never retry a Stack mutation
in a loop.

These checks are agent-side safeguards, not backend authentication. Other
CLI-backed operations can associate a same-named fork PR; direct MCP or loopback
clients can bypass this agent's PR-head preflight; and a PR can appear between
the exhaustive list and the CLI lookup, creating a check-to-CLI race. Do not
describe the agent's preview as preventing those cases.

## Resolve and read a remote Stack

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

## Remote GitHub MCP mutation authorization and snapshots

Read the latest Stack and affected pull requests immediately before every
mutation.

An explicit request naming the repository and exact PR order authorizes one
`create` or `add` call after a successful preflight and preview. Ask before the
call when the repository, order, target Stack, or intended PR set was inferred.

For remote GitHub MCP `unstack`, follow the combined local/remote preflight in
"Unstack remotely" before asking, even when it was requested earlier. The
preview must include the latest remote Stack and affected-PR membership/state
plus a Git-MCP snapshot of the exact local worktree using its explicit absolute
`path`; if no local checkout is in scope, record that explicitly. Ask only
after both snapshots and their preview. Name the exact Stack number and
`remote-only` mode, identify eligible PRs and any merged, queued, or otherwise
locked PRs that may remain, state that branches and PRs are not deleted, and
state that local `.git/gh-stack` tracking will remain unchanged.

Before a multi-call workflow, capture and report a snapshot containing:

- Stack number and internal ID.
- Stack base ref.
- Bottom-to-top PR numbers.
- Each PR's base ref, head ref, head SHA, state, draft state, and merge state.

A confirmation authorizes only the described operation. It does not authorize
a changed order, additional PRs, force-push, merge, or a retry after state has
changed. Re-read before retrying.

## Create a remote Stack

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

## Add to a remote Stack

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

1. Get the latest remote Stack and inspect the membership and current state of
   every affected PR with GitHub MCP. Record the Stack order and each PR's
   membership/state.
2. Before confirmation, snapshot the exact local checkout in scope with
   Git-MCP, passing its explicit absolute `path` on every call. Record the
   worktree path/identity, status, current branch, configured remote(s),
   branch refs, and local Stack tracking when Git-MCP exposes it; otherwise
   record that local Stack tracking was not observable. If no local checkout is
   in scope, record that explicitly. If the local target is ambiguous, stop and
   ask for its exact absolute path or clarification that no checkout is in
   scope; do not guess a worktree or mutate.
3. Preview both snapshots together. Immediately after the preview, ask for
   confirmation naming the exact Stack number and `remote-only` mode. State
   which PRs are eligible to leave, which merged, queued, or otherwise locked
   PRs may remain, that branches and PRs are not deleted, and that local
   `.git/gh-stack` tracking will remain unchanged. Do not make another tool
   call after completing both snapshots and before asking for confirmation.
4. Invoke through `call_tool_destructive` without `pullNumbers`:

```text
method: unstack
owner: <owner>
repo: <repo>
stackNumber: <stack-number>
```

5. Interpret `dissolved: true` as complete dissolution. The old Stack can no
   longer be fetched; verify completion by filtering for each former PR and
   expecting no Stack membership.
6. Interpret `dissolved: false` plus `stack` as partial unstacking. Get the
   retained Stack, report every retained PR, and verify removed PRs by their
   membership filters. Do not claim dissolution.

If a local checkout tracks the Stack, tell the user that the next local sync or
submit can recreate the remote grouping. If they separately want local tracking
removed, treat it as a new local-only operation; the earlier `remote-only`
confirmation does not select local cleanup by itself. Take fresh Git-MCP and
GitHub MCP snapshots for the exact absolute worktree, remote/repository,
affected branches, and current remote Stack/PR membership. Preview the exact
Stack number, `localOnly` mode, worktree, remote/repository, branches, and local
tracking removal, then call `stack_unstack` without a second confirmation.

If the user wants the agent to perform the cleanup and `stack_unstack` is
advertised, invoke it through the exact returned `name` and `call_with`, with
`stackNumber: <stack-number>`, `mode: localOnly`, and the same `path` and
`remote`. Afterward, verify local tracking with a fresh `stack_view` observation
and Git-MCP worktree/branch snapshot; disclose that `stack_view` refreshes local
metadata. Local-only cleanup leaves remote grouping unchanged. If the remote
unstack was partial, preserve the report of every retained PR, including
locked, merged, queued, or otherwise remaining members; local cleanup does not
remove them remotely. Do not claim full remote dissolution based on local
cleanup.

Use this targeted CLI handoff only if local Stack tools are unavailable or the
user explicitly wants to run the CLI themselves:

```bash
gh stack unstack <stack-number> --local
```

If the user runs the handoff, request `gh stack view` output and verify local
tracking before claiming cleanup. Never execute the command from the skill.

## Stack-wide operations

The remote GitHub Stack API exposes list, get, create, append, and unstack. It
does not expose cascade sync, cascade rebase, arbitrary reorder, local checkout,
push, or stack-wide merge. Use the typed local Stack MCP tools for supported
local operations; never simulate a Stack-wide operation by looping single-PR or
Git calls when the semantics differ.

### Cascade sync

For local sync, use `stack_sync` after the snapshots and branch-prune preview
above. If local Stack tools are not advertised, provide the CLI handoff below.
For remote-only diagnosis, inspect the remote Stack and fan out PR/check/review
reads; Git-MCP may inspect status, branches, worktrees, logs, and diffs with
that explicit absolute path.

Do not call `update_pull_request_branch` for every PR. That endpoint updates
one branch independently and does not reconcile local Stack metadata, preserve
commit boundaries, perform a bottom-to-top cascade, or provide atomic rollback.

Provide this handoff only when local Stack tools are unavailable or the user
will run the operation themselves:

```bash
gh stack sync --remote <remote>
```

Select `prune: true` only when removing merged local branches is part of the
requested sync; preview the affected branches. Never omit `--remote` unless
`remote.pushDefault` is known to be configured.

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

For local cascade rebase, use `stack_rebase` with the verified `start` action
and exact scope after preflight. A conflict may be continued only through the
guarded `stack_rebase` `continue` action when its recorded conflict branch and
active Git rebase match. `stack_rebase` does not provide abort; abort remains a
user-owned `gh stack rebase --abort` handoff. If local Stack tools are absent,
provide the matching command below.

The GitHub website has a server-side **Rebase Stack** operation, but the
documented API does not expose it. Do not call an undocumented endpoint. Warn
that server-side rebases create unsigned commits; repositories requiring signed
commits should use the local CLI.

For a user-owned local CLI handoff, provide the command matching the requested
scope:

```bash
gh stack rebase --remote <remote>
gh stack rebase --upstack --remote <remote>
gh stack rebase --downstack --remote <remote>
gh stack rebase --no-trunk
```

Use `--upstack` after editing a lower layer. Use `--downstack` to update only
the path from trunk through the current layer. Use `--no-trunk` when the
requested scope is to align Stack branches without pulling trunk.

A local rebase does not push. When the user owns the CLI workflow, provide:

```bash
gh stack push --remote <remote>
```

Explain that push uses per-branch force-with-lease and is not atomic. The user
must inspect and retry any rejected branch rather than assuming the whole Stack
landed.

For a rebase conflict, the agent may inspect and edit conflicted files, then
stage explicit resolved paths through Git-MCP. Use the guarded local MCP
`continue` action only when its preconditions hold; otherwise the user must
advance or restore the Stack with:

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

For a non-interactive rebuild, provide the shape of the user-owned workflow
without inventing history-rewrite commands. Require the explicit Stack number
and mode before showing its unstack step:

```bash
gh stack unstack <stack-number>          # remoteAndLocal
gh stack unstack <stack-number> --local  # localOnly
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

For local Stack publication, use `stack_submit` or `stack_link` after the
exhaustive PR-head preflight, snapshots, and effects preview above. Include any
missing PR creation in the `stack_submit` preview; `stack_link` requires
existing PRs. When local tools are unavailable, provide the user-owned CLI
handoff below.

For a remote-only workflow, GitHub MCP can operate when all branches already
exist on GitHub. It may create missing PRs bottom-to-top with
`create_pull_request`, then create or append the native Stack after a separate
preview and authorization. Run the exhaustive PR-head preflight above before
creating or linking by branch name.

Do not create missing PRs implicitly. State that the multi-call workflow is
not atomic and report each created PR immediately so a later failure can be
resumed without duplication. Check for an existing PR by head branch before
every creation retry.

The remote-only GitHub MCP cannot push local branches, generate or maintain
`.git/gh-stack`, or rebase an invalid chain. When any of those are needed and
local Stack tools are unavailable, provide:

```bash
gh stack submit --auto --remote <remote>
```

Add `--open` only when the user wants new and existing PRs marked ready for
review. Otherwise new PRs remain drafts.

For a user-owned link handoff, provide:

```bash
gh stack link --remote <remote>
```

### Push

For local Stack pushes, use `stack_push` after fresh snapshots and an effects
preview. Do not loop `git-mcp:git_push` as a stack-wide push: per-branch calls
lose the CLI's lease coordination and can leave an unreported partial result.
If local Stack tools are unavailable or the user will run the operation
themselves, provide:

```bash
gh stack push --remote <remote>
```

Explain that this pushes every active branch with per-branch force-with-lease,
is not atomic, and never creates or updates PRs.

### Checkout and navigation

GitHub MCP can return the bottom-to-top branch order. For local Stack checkout,
use `stack_checkout` after verifying the target branch and worktree. Git-MCP
checkout of an ordinary existing branch does not create or maintain local Stack
tracking.

Provide this handoff when local Stack tools are unavailable or missing branches
require the CLI. Use the PR URL form when targeting a PR so intent is explicit:

```bash
gh stack checkout <stack-number>
gh stack checkout https://github.com/<owner>/<repo>/pull/<pr-number>
```

For `up`, `down`, `top`, `bottom`, or `trunk`, report the resolved target branch
from remote order. Use `stack_checkout` for supported local Stack navigation;
otherwise provide the matching `gh stack` navigation command. Never use the
interactive `gh stack switch`.

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
- Fetch a named remote for preflight or recovery when the target is unambiguous;
  re-inspect refs afterward.
- Check out an existing ordinary local branch after explicit request. For
  native Stack navigation, prefer `stack_checkout` so local Stack tracking is
  maintained.
- Stage explicit paths and create one ordinary fix commit for an explicitly
  requested code repair on a verified member branch.
- Stage explicit conflict-resolution paths after the files are resolved.

Git-MCP must not be used to imitate these `gh stack` operations:

- Any supported typed local Stack MCP operation when that tool is unavailable.
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
- For remote GitHub MCP, `409` means another request is modifying the Stack.
  Re-read it, show the new order and SHAs, and ask before retrying that remote
  call. For a typed local Stack MCP call, follow the local postflight and retry
  after fresh unambiguous snapshots and an effects preview, without human
  authorization. Never retry in a loop.
- `422` means the requested PR chain or mutation is invalid, or unstacking
  cannot remove any locked member. Re-read PR bases and Stack membership;
  never coerce the request with unrequested base changes.
- A timeout does not prove a mutation failed. Read the Stack or filter by PR
  before retrying so the operation is not duplicated.
- On any partial multi-call workflow, stop at the first unexpected failure,
  report completed mutations, and present a recovery based on the captured
  snapshot.

## Completion checks

Before claiming a local Stack mutation succeeded, verify its local branch/ref
postconditions with Git-MCP and any affected remote PR or Stack postconditions
with GitHub MCP. For submit/link, verify exact head/base repositories, branch
associations, and Stack order; for uncertain results, stop when reinspection is
ambiguous.

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
