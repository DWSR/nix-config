# Requirements Document

## Introduction

`gh-stack-mcp` makes the noninteractive local Stack lifecycle available through the existing MCP entrypoint. The problem, chosen approach, and scope are in `brief.md`.

## Boundary Context

- Remote-only native Stack tools remain with GitHub MCP; these tools operate on an explicit local worktree.
- Shopify's read-only preflight helpers stay read-only. `stack-captain` may restack but must not initiate merge or unstack.

## Requirements

### Requirement 1: Typed tool and repository boundary

**Objective:** As an agent, I want named operations tied to a known worktree, so that I cannot accidentally act on an implicit checkout or run arbitrary CLI input.

#### Acceptance Criteria

1. When the MCP tool catalog is queried, the Stack MCP shall expose separate typed operations for view, init, add, checkout, sync, rebase, push, submit, link, and unstack.
2. When any operation is requested, the Stack MCP shall require an explicit absolute path to a Git worktree.
3. If the worktree path is missing, invalid, or not a Git checkout, the Stack MCP shall reject the call before invoking the extension.
4. If a branch-target input is a PR URL or numeric-only value, the Stack MCP shall reject the call before invoking the extension.
5. The Stack MCP shall not accept arbitrary subcommands, flags, shell fragments, or TUI-only commands.
6. When view is advertised, the Stack MCP shall disclose that it can refresh local Stack metadata and does not provide a remote Stack list.
7. When an operation is requested, the Stack MCP shall require an explicit Git remote identifying the target repository.
8. If the selected remote's fetch and push destinations do not identify the same repository, the Stack MCP shall reject the call before invoking the extension.

### Requirement 2: Local inspection and navigation

**Objective:** As an agent, I want local Stack topology and unambiguous branch checkout, so that I can verify my target before changing branches.

#### Acceptance Criteria

1. When view is called from a tracked worktree, the Stack MCP shall return the trunk, current branch, and bottom-to-top branch/PR observations from the extension's structured view.
2. If no local Stack is tracked, the Stack MCP shall report that condition without inventing a remote Stack view.
3. When checkout is called, the Stack MCP shall require an explicit nonnumeric branch name.
4. If checkout cannot resolve its branch uniquely without an interactive selection, the Stack MCP shall fail without opening a picker.
5. If checkout is called from a worktree with more than one Git remote, the Stack MCP shall reject the call before an implicit remote import can occur.
6. If checkout could fetch from a Git remote other than the validated target remote, the Stack MCP shall reject the call before invoking the extension.

### Requirement 3: Stack construction and add

**Objective:** As an agent, I want explicit local setup and branch additions, so that Stack membership is not inferred from an interactive prompt.

#### Acceptance Criteria

1. When init is called, the Stack MCP shall require an explicit trunk and ordered branch list.
2. When add is called, the Stack MCP shall require an explicit branch or an explicit commit-creation mode.
3. When add stages or commits changes, the Stack MCP shall apply only the caller-selected staging and message options.
4. If a Git commit or signing operation fails, the Stack MCP shall report the failure without weakening the host's signing configuration.
5. If init or add requires an editor, confirmation prompt, or missing argument, the Stack MCP shall fail instead of waiting for interactive input.
6. If add is asked to stage changes without an explicit commit message, the Stack MCP shall reject the call before invoking the extension.
7. If init must fetch a missing local trunk in a worktree with more than one Git remote, the Stack MCP shall reject the call before invoking the extension.
8. If init must fetch from a Git remote other than the validated target remote, the Stack MCP shall reject the call before invoking the extension.

### Requirement 4: Rebase and conflict recovery

**Objective:** As an agent, I want to rebase the requested part of a Stack and continue a verified conflict, so that a conflict does not trigger an unsafe generic Git command.

#### Acceptance Criteria

1. When rebase is requested, the Stack MCP shall support explicitly selected whole-Stack, upstack, downstack, or no-trunk scope.
2. If rebase stops on a conflict, the Stack MCP shall return the reported conflict and pending recovery state without claiming the Stack is synchronized.
3. When continue is requested, the Stack MCP shall require a valid pending Stack rebase marker and an active matching Git rebase in the selected worktree.
4. If the marker, branch, or Git rebase state is missing or inconsistent, the Stack MCP shall reject continue without invoking a generic Git rebase.
5. When rebase completes, the Stack MCP shall distinguish local history changes from a subsequent push.
6. The Stack MCP shall not expose a rebase abort operation in this release.

### Requirement 5: Sync and push

**Objective:** As an agent, I want explicit reconciliation and publication, so that local and remote Stack state are not confused.

#### Acceptance Criteria

1. When sync or push is requested, the Stack MCP shall use the validated target remote without implicit remote selection.
2. When sync is requested without prune, the Stack MCP shall leave prune disabled.
3. When prune is explicitly requested, the Stack MCP shall disclose that merged local branches can be removed.
4. When push is requested, the Stack MCP shall disclose that a multi-branch push can partially succeed.
5. If sync skips work or a push does not fully land, the Stack MCP shall not claim that the entire Stack is synchronized or published solely from the command exit code.

### Requirement 6: Submit and link

**Objective:** As an agent, I want explicit publication targets and review state, so that PR creation or base changes are not mistaken for a read-only action.

#### Acceptance Criteria

1. When submit is requested, the Stack MCP shall use a noninteractive submission mode against the validated target remote.
2. When link is requested, the Stack MCP shall require explicit ordered nonnumeric branch targets and use the validated target remote.
3. When submit or link is requested without open, the Stack MCP shall leave the ready-for-review option disabled.
4. When open is explicitly requested, the Stack MCP shall disclose that affected PRs can be marked ready for review.
5. If submit or link creates only some PRs, changes only some bases, or fails to reconcile the remote Stack, the Stack MCP shall report an unverified outcome rather than claim complete publication.
6. If a pending modify state would cause submit to unstack a previous remote Stack, the Stack MCP shall reject the call before invoking submit.

### Requirement 7: Unstack and merge boundary

**Objective:** As an agent, I want explicit unstack targeting and a clear merge handoff, so that a numeric target is not silently interpreted as the wrong operation.

#### Acceptance Criteria

1. When unstack is requested, the Stack MCP shall require an explicit Stack number and remote-or-local removal mode.
2. When local-only unstack is requested, the Stack MCP shall state that remote grouping is unchanged.
3. If remote unstack leaves locked or merged members grouped, the agent workflow shall report the remaining members after reinspection without claiming full dissolution.
4. The Stack MCP shall not delete PRs or branches as an implicit effect of an unstack tool request.
5. The Stack MCP shall not expose a merge tool in this release.
6. If a local Stack has no remote Stack number, the Stack MCP shall leave local-only unstack to a user-owned handoff.

### Requirement 8: Bounded execution and truthful outcomes

**Objective:** As an operator, I want bounded, auditable tool results, so that failed or timed-out commands do not look safe to repeat.

#### Acceptance Criteria

1. When an operation starts, the Stack MCP shall use the pinned extension without a shell or interactive terminal.
2. When an operation ends, the Stack MCP shall return its exit status, bounded diagnostic output, and whether the requested postcondition has been verified or remains unknown.
3. If an operation times out or is interrupted, the Stack MCP shall stop waiting within a finite deadline and mark its result as uncertain.
4. If a write has an uncertain or partial outcome, the Stack MCP shall not retry it automatically.
5. If the extension or authentication is unavailable, the Stack MCP shall report an actionable dependency or authentication error without logging a credential.
6. When a tool can change branch history, PR state, or Stack membership, its MCP metadata shall not describe it as read-only.

### Requirement 9: Declarative deployment

**Objective:** As the operator, I want the wrapper deployed consistently on both hosts, so that agents reach the same tested extension and MCP surface.

#### Acceptance Criteria

1. When either host is built, the configuration shall install the same pinned `gh-stack` v0.1.1 executable for the GitHub CLI extension and the Stack MCP runtime.
2. When either host renders mcpproxy configuration, the configuration shall include the Stack MCP as a stdio upstream with its executable dependencies available.
3. When either host renders OpenCode settings, the configuration shall preserve mcpproxy as the sole MCP entrypoint.
4. The integration shall not require a new secret.
5. The integration shall preserve global Git signing and existing GitHub MCP Stack tools.
6. The integration shall not add a background listener.
7. If the wrapper cannot start, the operator shall see a Stack-MCP-specific diagnostic without blocking unrelated MCP upstreams.
8. When a managed host renders configuration, the shared proxy and existing OpenCode MCP-entry call deadlines shall exceed the Stack MCP's longest operation and cleanup deadline.
9. The operator guidance shall disclose that those longer shared deadlines apply to unrelated MCP calls.

### Requirement 10: Agent authorization and workflow

**Objective:** As the operator, I want existing Stack agents to use the new tools under deliberate preflight, so that a tool call is not mistaken for broad authorization.

#### Acceptance Criteria

1. When local Stack work is requested, the native-Stacks guidance shall discover and invoke typed Stack MCP tools rather than executing `gh stack` directly.
2. When remote-only Stack work is requested, the native-Stacks guidance shall continue using GitHub MCP.
3. Before a history rewrite, push, submit, link, or unstack, the agent workflow shall inspect the local target and any affected remote Stack or PRs and describe the expected effects.
4. Before unstack, the agent workflow shall request explicit confirmation for the exact target and operation after the latest state inspection.
5. If the target or state changes after confirmation or an outcome is uncertain, the agent workflow shall stop and request fresh inspection before retrying.
6. Before `stack-captain` invokes a history rewrite or push, its guidance shall request user authorization for the specific operation and target.
7. When `/restack` is invoked, its workflow shall use the vetted tools for eligible local Stack operations instead of instructing an agent to run arbitrary Git or `gh stack` commands.
8. The `stack-captain` workflow shall not initiate merge or unstack.
9. The integration shall preserve read-only helper boundaries.
10. When `stack-captain` invokes a destructive Stack MCP tool, its OpenCode outer-tool permission shall be configured to ask, with no code-execution bypass available to that agent.
11. The operator guidance shall state that unauthenticated loopback clients, including other local accounts, can invoke the Stack MCP and agent confirmations are not backend authentication.
12. The operator guidance shall disclose that auto mode or persistent OpenCode approval can suppress later `ask` prompts.
13. Before add stages untracked files or sync prunes branches, the agent workflow shall preview the affected paths or branches and ask for that opt-in effect.
14. Before submit or link, the agent workflow shall enumerate all open PRs matching each affected branch name and stop if a match has a foreign or unknown head repository, or if more than one match exists.
15. The operator guidance shall disclose that other CLI-backed operations can associate a same-named fork PR and that direct MCP callers can bypass the agent's PR-head preflight.
16. Before init, add, rebase, sync, push, submit, or link, the agent workflow shall request authorization for the exact worktree, remote, affected branches, and side effects after the latest inspection.

### Requirement 11: Offline verification and operator guidance

**Objective:** As the maintainer, I want repeatable checks and explicit recovery guidance, so that rollout does not require risky live Stack mutations in CI.

#### Acceptance Criteria

1. When repository checks run, the test suite shall exercise tool schemas, valid and rejected inputs, noninteractive invocation, deadline behavior, conflict recovery, and uncertain or partial outcomes against controlled fixtures.
2. When configuration checks run, the test suite shall verify the shared extension pin, executable availability, and Stack MCP registration on both hosts.
3. When automated verification runs, the test suite shall not mutate an operator repository or call the live GitHub Stacks API.
4. When an operator reviews the runbook, the runbook shall distinguish local tracking from remote Stack objects, document authentication prerequisites, and provide post-failure inspection steps.
5. When operator guidance is updated, the native-Stacks skill, `stack-captain`, `/restack`, and their compact context variants shall present consistent permission, confirmation, and no-direct-CLI rules.
