# Working with Graphite (gt)

`gt` (Graphite CLI, available via `hub_gt_mcp__run_gt_cmd`) is the preferred
tool for stacked PRs in internal Shopify repos. It wraps git but has known
failure modes when the repo has strict commit/rebase hooks, when worktrees
share metadata, or when state drifts. Apply the recovery patterns below
INSTEAD OF inventing new ones; they are documented from prior sessions.

The deeper reference catalog lives at
`memories/2026-04-30-graphite-pitfalls.md` in the Obsidian vault. This
section is the operational summary loaded into the agent's context.

## Decide whether to use gt at all

Before any gt command, decide:

- **Internal Shopify monorepos** (shop/world, infra-central, globaldb-yugabyte,
  similar): default to gt.
- **Open-source Shopify repos** (e.g., Shopify/cli-kit): default to plain
  git + `gh pr create`. ASK the user if unsure — they have explicit policy
  on this.
- **Personal repos** (e.g., DWSR/nix-config): plain git unless the user is
  already using gt locally.

## Bypass autonomy rule

ALWAYS ask the user via the `question` tool before invoking any
`--no-verify`, `--force`, or `--force-with-lease` flag, regardless of how
unambiguous the documented recovery looks. Even when this guidance marks a
bypass as "the documented recovery", confirm with the user in the current
session before applying it. The cost of asking is low; the cost of an
unauthorized force-push or hook-bypass is high. No carve-outs, including
the prek pre-rebase case.

## Category A — Hooks intercept gt's internal git invocations

`gt create -m`, `gt modify`, and `gt rebase --onto` all shell out to
`git commit` / `git rebase`, which fire commit-msg and pre-rebase hooks.
Two recurring patterns:

1. **Argument mangling.** `gt create --message "ci(scope): pin SHA"`
   becomes `git commit -m ci(scope): pin SHA -q` (split at the colon).
   Multi-line `--message` bodies get mangled into trailing args (`-q` and
   other gt flags end up inside the body, then commitlint rejects).

2. **Hook validation rejects the commit.** Even when argv is correct, the
   commitlint or prek hooks may reject for unrelated reasons (e.g.,
   `01-prek` for the pre-rebase stage requires `--pre-rebase-upstream`
   which the global dispatcher may not pass).

**Recovery patterns:**

- For new branches with multi-line messages: `git checkout -b <branch>`,
  write the message to `/tmp/cmsg.txt`, run `git commit -F /tmp/cmsg.txt`,
  then `gt track --parent <parent>`. From there, `gt submit --no-interactive`
  works.
- For amends: `git commit --amend --no-edit` first; if the hook still
  rejects, ASK the user before adding `--no-verify`. Then `gt restack`.
- For rebases on broken pre-rebase hooks: `git rebase --onto …` first;
  if the hook fails, ASK the user before adding `--no-verify`. Acceptable
  only for unpushed commits.

Cite the specific failure (e.g., "prek 0.2.17 missing --pre-rebase-upstream")
when asking for bypass authorization.

## Category B — Graphite metadata / state hygiene

Graphite stores stack topology in `.git/.graphite_cache_persist`. Common
drift modes and recovery:

- **`BAD_PARENT_NAME` / "Cannot perform this operation on untracked
  branch":** Branch isn't registered in gt's cache. Fix: `gt track
  --parent <parent>`. For a single-PR off main, that's `gt track --parent
  main`.
- **"Branch X has been updated remotely outside of Graphite":** Local
  rebase changed your branch's SHAs. The remote head is unchanged but gt
  sees divergence. Fix requires `--force` — ASK the user first. Verify
  the remote only has YOUR commits before running
  `gt submit --no-interactive --force`.
- **"Could not find branch X" from `gt log` / `gt state`:** Cross-worktree
  pollution — another worktree referenced a branch that no longer exists.
  Fix priority: `gt sync` → `gt untrack <stale>` → `gt repo init`.
- **`gt create` fails because main is checked out in another worktree:**
  `git checkout -b <branch> && gt track --parent main`.
- **Phantom empty commits after mid-stack restack:** Detect via
  `git log --oneline origin/main..HEAD` (adjacent same-title commits).
  Confirm with `git diff-tree --no-commit-id <sha>` (empty) and tree-SHA
  comparison. Drop via
  `git rebase --onto <new-base> <phantom-sha> <branch>`, then
  `gt restack --upstack` to propagate.

## Category C — Workflow / mental-model traps

- **`gt modify` commits on the CURRENT branch.** It does NOT detect which
  PR a file change "belongs to". Before editing files for a mid-stack PR,
  ALWAYS `git checkout <target-branch>` first. Verify with `git status`
  before running `gt modify`.
- **`gt submit --no-interactive` from the bottom only submits downstack.**
  Add `--stack` to submit the entire stack regardless of position. Safe
  default at the top, but at the bottom `--stack` is required.
- **Force-pushing the bottom of an N-PR stack invalidates approvals on
  all N-1 upstream PRs.** Surface this re-approval cost to the user
  before applying small fixes to a bottom branch.
- **Worktree mental model:** keep track of which worktree owns which
  branch. Graphite metadata is shared across worktrees via the main
  `.git/`, so changes in one worktree affect `gt log` / `gt state`
  output in others.

## Workflow rules summary

1. Try `gt <command>` as documented.
2. If it errors, classify (Category A / B / C above).
3. Apply the documented recovery.
4. If the recovery requires `--no-verify`, `--force`, or `--force-with-lease`,
   ASK THE USER FIRST via the `question` tool. No exceptions.
5. After every plain-git rebase or amend, validate with
   `git log --oneline origin/main..HEAD` looking for adjacent same-title
   or same-tree commits (phantom detection).
6. After every `gt restack` / `gt submit --force`, sanity-check the
   remote state with `gh pr view <num> --json mergeable,mergeStateStatus`
   — `DIRTY` is "computing" (~30s lag); `MERGEABLE` or `BLOCKED` is
   settled.

When in doubt, present the failure and proposed workaround to the user
via the `question` tool before bypassing.
