# Brief: gh-stack-mcp

## Problem

> Create a spec for a thin go mcp wrapper around the gh stack extension.

The operator's agents can inspect and mutate remote native Stacks through GitHub MCP, but cannot use local `gh stack` workflows through MCP. Current agent policy forbids executing the extension; a bare CLI handoff prevents an agent from coordinating local branch and Stack work through the existing MCP entrypoint.

## Current State

Both macOS hosts install `gh-stack` through Home Manager, currently at the flake-locked v0.1.0. mcpproxy exposes remote Stack API tools but no local Stack upstream; its launchd environment does not supply a stable `gh`/extension path or the caller's worktree. The native-Stacks skill and Shopify stack-captain forbid agent execution of `gh stack`.

## Desired Outcome

An agent can discover typed, noninteractive local Stack tools through mcpproxy on either host and use them under explicit worktree, preflight, confirmation, and partial-result rules. Operator tests can prove packaging, tool contracts, and host registration without rewriting real branches or calling live APIs.

## Approach

Build a small Go stdio MCP server with the official Go MCP SDK. Each tool maps a bounded set of typed inputs to the same pinned `gh-stack` v0.1.1 executable; it does not reimplement Git or GitHub Stack operations. Require an explicit absolute worktree for each call, fixed executable dependencies, bounded execution, and conservative reporting when a command can partially succeed. Register it through each host's existing mcpproxy upstream extension point. Update agent guidance to permit the vetted MCP tools, not direct CLI execution.

## Scope

- **In**: Local `view --json`; explicit `init`/`add`/branch-name `checkout`; `sync`/`rebase`/`push`; `submit`/branch-name `link`; and `unstack`. Model guarded rebase continue, opt-in `sync --prune` and `unstack --local`, `add` staging/commit modes, and `submit`/`link --open`; no arbitrary flags. Pin the installed extension and wrapper to v0.1.1; package/register the server on both hosts; raise the shared proxy and existing OpenCode MCP-entry call timeouts for bounded long-running commands; update the native-Stacks skill, Shopify stack-captain, `/restack`, and compact guidance; add deterministic checks and a runbook.
- **Out**: `merge` and rebase `--abort` via MCP; numeric or PR-URL checkout/link and PR-only link via the wrapper; local-only unstack of unnumbered/unpublished Stacks; fork-to-upstream or cross-repository workflows; generic subcommand/flag passthrough; interactive `modify`/`switch` or editor-driven flows; direct OpenCode MCP registration; new long-running services; reimplementing remote GitHub Stack REST tools; automatic replay after uncertain outcomes; and changing mcpproxy authentication.

## Boundary Candidates

- The wrapper owns input validation, worktree/executable selection, process lifetime, tool schemas, and faithful CLI result reporting; the extension owns Stack semantics and local metadata.
- Existing GitHub MCP owns remote-only native Stack inspection/mutation; agent guidance owns preflight, user confirmations, and user-owned recovery handoffs. Captain and `/restack` may use the wrapper for restack workflows; captain remains prohibited from initiating merge/unstack and read-only helpers stay read-only.
- Nix owns the shared extension version, server package, both-host registration, timeout settings, and offline checks; it does not change global Git signing or unrelated upstream registration. Raising shared call timeouts affects unrelated upstreams.

## Out of Boundary

- Do not expose arbitrary Git, shell, or `gh stack` command execution.
- Do not expose `merge`: the CLI tries a numeric target as a Stack number, then falls through to a PR number. A guaranteed Stack-only merge requires a remote existence check; the operator deferred that tool rather than expanding the thin wrapper.
- Do not expose numeric or PR-URL targets for `checkout`/`link`: CLI numeric resolution can select a different Stack or append PRs to an existing Stack. Use nonnumeric branch targets, or GitHub MCP for remote-only PR linking.
- Do not claim all Stack pushes are atomic: `sync` attempts an atomic Git push, but standalone `push` and sequential `submit` can partially land. Do not promise automatic conflict resolution or merge completion from a queue acknowledgement.
- Do not bypass Git signing for `add` commits or silently select destructive CLI flags; typed rebase continue requires a verified active Git conflict and a valid Stack recovery marker. Rebase abort remains a user-owned handoff because the CLI can hard-reset branches based on a stale marker.
- Do not claim agent-side confirmations authenticate mcpproxy clients: unauthenticated loopback access by any local process, including another local account, is an explicitly accepted risk.
- Do not invoke a private or undocumented GitHub Stack endpoint or force a repository history rewrite as a verification step.

## Upstream / Downstream

- **Upstream**: `github/gh-stack` v0.1.1, `gh` authentication, the official Go MCP SDK, existing Home Manager and mcpproxy modules, and remote Stack tools in GitHub MCP.
- **Downstream**: The native-Stacks skill, Shopify stack-captain, `/restack`, and other agents that discover the MCP tools; future policy or auth hardening remains separate.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `mcpproxy-migration` owns the daemon/routing; `ast-grep-mcp` and `grep-app-mcp` establish package/registration test patterns; `git-mcp-secure-enclave-signing` does not own subprocesses of this wrapper.

## Constraints

- Both managed nix-darwin hosts; reproducible Nix build and one shared `gh-stack` v0.1.1 executable path.
- Explicit repository identity per call; no implicit launchd cwd, inherited `GH_REPO` override, interactive TTY, or unbounded subprocess.
- The selected remote's fetch and push URLs must identify the same repository as the Stack API target. The operator deferred fork-to-upstream publication because the pinned CLI does not qualify fork head branches.
- Branch-name checkout can import a unique remote Stack only from a single-remote checkout; multiple Git remotes require a user-owned handoff because `checkout` has no explicit `--remote` flag.
- The global proxy call timeout and both existing OpenCode proxy-entry timeouts must exceed the wrapper's longest execution plus cleanup budget. The operator accepted the longer wait ceiling for unrelated MCP tools instead of adding another proxy.
- `gh-stack` matches open PRs by branch name without checking the head repository. The operator chose exhaustive same-repository PR-head preflight only before `submit`/`link`, not `view`, `init`, `sync`, `rebase`, or `push`; direct MCP callers can bypass even the publish preflight. Wrong local association and remote Stack mutation remain accepted residual risks.
- `view --json` may refresh local metadata; zero exit from some mutations does not establish full success. Treat ambiguous, timed-out, or partial outcomes as such, not as safe-to-retry failures.
- mcpproxy listens on loopback with `require_mcp_auth = false`. The operator accepted access by other local processes; the agent must still ask before high-impact operations, especially unstack, but that prompt is not server authorization.
- Captain's destructive MCP permission changes from deny to ask for vetted restack operations, not blanket allow; code-execution bypass is excluded, and it still must not initiate merge or unstack. The operator accepted that OpenCode's `ask` is best-effort because auto mode and persistent approval can skip later prompts.
