# gh-stack-mcp operator runbook

## Local and remote Stack roles

`gh-stack-mcp` exposes typed local worktree operations through the existing
mcpproxy endpoint. The local `gh stack` tracking state is stored under the
worktree's Git metadata, typically `.git/gh-stack`; it records the checkout's
trunk and ordered branches. `stack_view` refreshes and reports this local
tracking and can update local metadata. It is not a remote Stack list or proof
of a GitHub postcondition.

GitHub MCP owns remote GitHub Stack objects and their pull requests. Its Stack
tools can list, read, create, append to, and unstack remote objects, but do not
fetch or reconcile a worktree, rebase its branches, or update `.git/gh-stack`.
Local operations use the typed local Stack MCP; remote-only operations use
GitHub MCP. Some local operations such as submit, sync, push, link, and unstack
also have remote effects, so inspect both sides after them.

mcpproxy is the sole MCP entrypoint. Discover the live tool catalog before a
workflow, then use each returned qualified `name`, `call_with` route, and schema.
The designed `stack_view` route is `call_tool_write`; mutations use
`call_tool_destructive`. Every local tool call names its absolute worktree path
and Git remote. Never have an agent execute `gh stack`; if a local MCP tool is
unavailable or an operation is unsupported, provide a narrowly scoped,
user-owned terminal handoff instead.

## Authentication and host prerequisites

The extension uses the existing GitHub CLI authentication available to the
wrapper's host account and `HOME` profile. Before acceptance, check it as that
operator with `gh auth status`. If the existing host login has not been
provisioned, use the established host provisioning procedure, which uses
`gh auth login`; do not create a new secret for this integration. Never paste,
print, or log a credential value.

`MCP_GITHUB_TOKEN` authenticates the separate GitHub MCP server; it is not a
substitute for the extension's `gh` authentication. Do not copy it into `GH_TOKEN`
or add it to the Stack MCP environment or Nix configuration.

Git signing and hooks remain enabled. The runner preserves the host Git
configuration for commits made by Stack operations. A signing or hook failure
is a failed operation to inspect; do not disable signing, skip a hook, or retry
with weaker settings. For a disposable acceptance target, verify that a normal
test commit is signed under the host configuration before exercising Stack
operations.

After applying host configuration changes, restart mcpproxy and OpenCode before
discovering the tools again. A missing `gh` login or unavailable upstream is a
stop condition; use the existing provisioning path or defer the workflow rather
than supplying a token to the tool call.

## Deadlines and shared waiting limits

The wrapper command ceilings are:

| Operation | Wrapper command ceiling |
| --- | ---: |
| `view` | 45 seconds |
| `init`, `add`, `checkout` | 5 minutes |
| `rebase`, `sync`, `push`, `submit`, `link`, `unstack` | 15 minutes |

Cancellation allows up to 5 seconds for child cleanup and reaping. The request
also reserves 10 seconds for proxy delivery. Thus the longest command plus
cleanup and delivery margins fits the global mcpproxy `call_tool_timeout` of
15m15s. The existing OpenCode mcpproxy entry is 930000 milliseconds (15m30s),
leaving 15 seconds beyond that proxy deadline. These are shared proxy-entry
limits, not per-tool overrides: longer waits also apply to unrelated tools on
those entries. Existing connection and tool-listing preflights keep their
separate settings.

## Accepted trust boundaries

mcpproxy exposes an unauthenticated loopback listener on `127.0.0.1:8080`. Any
local process or account able to reach it can call the Stack MCP server with
the wrapper's `gh` credentials; loopback is not same-user isolation. OpenCode
`ask` prompts and skill confirmations are not backend authentication. Auto mode
or persistent approval can suppress a later `ask` prompt.

The pinned CLI can associate a same-named fork PR during other CLI-backed
operations. Agent-side exhaustive PR-head checks run only for `submit` and
`link`; direct MCP clients bypass those checks. A matching PR can also appear
after the check and before the CLI lookup, so the check-to-CLI lookup race
remains. Treat these as accepted limits of this integration, not as conditions
that confirmation or a successful prompt eliminates.

## Recovery after a write or uncertain result

Every write can be partial or uncertain. `exited_unverified` means the process
ended without a verified postcondition; `timed_out_unknown` can result from
deadline expiry or process cancellation/interruption; `cleanup_unknown` means
process cleanup could not be confirmed. A
timeout or cleanup result does not prove that no local or remote change landed.
Never automatically retry. After `exited_unverified`, `timed_out_unknown`,
`cleanup_unknown`, or partial output, do not claim success unless fresh local
refs and worktree status plus the affected remote PR heads and Stack membership
establish the requested postcondition. If either side is unreadable or
ambiguous, report the outcome as unknown and stop. Neither an exit code nor
success-looking CLI output proves success.

Before any retry, re-inspect both sides. If either inspection is unreadable or
ambiguous, report unknown and stop; do not retry. A retry requires complete,
unambiguous fresh inspections and fresh scoped authorization. For an agent
workflow, discover and use Git-MCP status, branch, log, and reflog reads with
the same explicit absolute `path` on every call. Use GitHub MCP reads for
remote PR and Stack membership. For example, follow the live tool names and
routes for:

```text
Git-MCP: git_status(path="<absolute-worktree>")
Git-MCP: git_branch(mode="list", path="<absolute-worktree>")
Git-MCP: git_reflog(ref="refs/heads/<affected-branch>", path="<absolute-worktree>")
GitHub MCP: pull_request_stack_read(
  method="get", owner="<owner>", repo="<repo>", stackNumber=<number>
)
```

Use the discovered qualified tool name and pass inputs under `args`; do not
assume these example routes or schemas without discovery. For publication,
inspect every affected branch's PR head/base and Stack membership. If snapshots
do not show one unambiguous outcome, report unknown and stop rather than
replaying the operation.

Operation-specific recovery limits:

- Standalone `push` is non-atomic and uses per-branch force-with-lease. Check
  each affected remote branch; some can land while another is rejected.
- Sequential publication can be partial: `submit` may create only some PRs, and
  `link` may update only some bases before failing. Inspect each affected PR and
  Stack membership before deciding whether a later targeted action is needed.
- A `sync` exit code 0 is not proof that sync completed; for example, a
  noninteractive divergence path can return without syncing. Re-read local refs
  and remote PR/Stack state.
- Remote unstack can leave locked or merged members remaining in the Stack.
  Report the retained members from a fresh GitHub MCP read; local-only unstack
  does not change remote membership.
- Only the guarded typed `stack_rebase` `continue` is available, and only when
  its recovery marker and active Git rebase match. Rebase abort is a user-owned
  handoff, not a typed tool. If the operator explicitly chooses that recovery,
  provide `gh stack rebase --abort` for the operator's terminal; the agent must
  not execute `gh stack` or substitute a generic Git rebase command.

## Optional operator-owned disposable-repository smoke

This is an optional manual acceptance procedure after activation. It is
operator-owned and may change the disposable repository. CI stays offline: it
does not mutate GitHub or call a live Stacks API. Use a disposable target, not
production data or a production repository, and do not use a fork for this
smoke.

1. Create a disposable same-repository test target that you own, preferably a
   throwaway private GitHub repository and a fresh worktree whose fetch and push
   remotes identify that same repository. Prepare a trunk and two throwaway
   branches in bottom-to-top ancestry order. Do not use a fork, production
   repository, or valuable branches.
2. Confirm `gh auth status` for the host account/profile used by mcpproxy. Keep
   host signing and hooks enabled and create the throwaway commits normally; do
   not paste credentials or bypass a failed signer or hook.
3. Discover `gh-stack-mcp` tools through mcpproxy with
   `retrieve_tools(query: "local gh-stack Stack worktree operations")`. Use the
   exact discovered tool names, `call_with` routes, and schemas. Confirm
   `stack_view` is routed through `call_tool_write` and mutations through
   `call_tool_destructive`. Separately discover remote GitHub MCP Stack/PR reads.
4. Take fresh Git-MCP snapshots for the absolute worktree and fresh GitHub MCP
   reads for the target repository and affected branches. Confirm the remote,
   branch order, PR matches, and current Stack membership. Request exact
   preflight and authorization for this disposable worktree, remote, branches,
   and operation before each mutation.
5. Call typed `stack_init` once for the explicit trunk and bottom-to-top branch
   list. Then call `stack_view` and verify local tracking and branch order
   separately from GitHub MCP; an absent remote Stack at this point is not a
   failed local initialization.
6. To test publication as well, paginate through all open PRs in this disposable
   repository and inspect exact head and base repositories for each target
   branch. Stop for a foreign/unknown head or base, multiple matches, or
   incomplete pagination. After separate exact authorization to publish, call
   typed `stack_submit` once, then verify local refs and view with Git-MCP/local
   Stack MCP and verify PR heads, bases, and remote Stack order with GitHub MCP.
   Verify local and remote results separately; do not use `stack_view` as proof
   of a remote postcondition.
7. If any call is partial, timed out, or uncertain, follow “Recovery after a
   write or uncertain result” and inspect both sides before any later action.
   Do not replay `stack_init` or `stack_submit` merely because a response was
   missing or incomplete.

The test suite exercises the Go server against fake executables, renders host
configuration, routes calls through isolated proxy fixtures, and checks this
runbook as static text. It does not invoke `gh stack`, access an operator
checkout, or contact live GitHub. The manual smoke above is never run by CI.
