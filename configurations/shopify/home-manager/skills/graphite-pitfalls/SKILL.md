---
name: graphite-pitfalls
description: >
  Recover from a Graphite (gt) failure. Load ONLY when a gt command has
  already errored — never speculatively. Triggers: gt error text containing
  "hook failed", "BAD_PARENT_NAME", "Cannot perform this operation on
  untracked branch", "Could not find branch", "Branch updated remotely",
  "Cannot perform interactive operation in non-interactive mode", phantom
  empty commits detected after restack, stale trunk entries in
  `.graphite_repo_config`, or any other gt metadata/state hygiene anomaly.
  Catalogues Category A (hook interception), B (metadata/state), and C
  (workflow/mental-model) failure modes with verified bash recoveries.
  Historical session anchors preserved per recovery for traceability.
---

# Graphite (gt) pitfalls catalog

Operational recovery reference for gt failures. Top-level AGENTS.md keeps
the decision matrix (when to use gt), the Green-path rule (gt-MCP-only
stacks don't need `--force`), the Bypass autonomy rule (always ask before
`--force` / `--no-verify` / `--force-with-lease` / `GIT_EDITOR=true`), and
the pitfall index. This skill holds the full bash recoveries.

## Bypass authorization — applies to every recovery below

Any recovery below that uses `--force`, `--no-verify`,
`--force-with-lease`, or a git environment override like
`GIT_EDITOR=true` REQUIRES user authorization first, via the `question`
tool, per the Bypass autonomy rule in AGENTS.md. No carve-outs. Cite the
specific failure (e.g. "prek 0.2.17 missing `--pre-rebase-upstream`",
"`00-commitlint` failed during `gt modify` but not direct amend") when
asking.

## Category A — Hooks intercept gt's internal git invocations

`gt create -m`, `gt modify`, and `gt rebase --onto` shell out to `git
commit` / `git rebase` / `git rebase --continue` under the hood. The
user's global hook dispatcher (`commit-msg.d/00-commitlint`,
`pre-rebase.d/01-prek`, `prepare-commit-msg.d/*`) fires on those internal
invocations. Three recurring failure modes:

### A1. Argument mangling

`gt create --message "ci(scope): pin SHA"` becomes
`git commit -m ci(scope): pin SHA -q` (split at the colon and parens).
Multi-line `--message` bodies fare worse — the `-q` flag and other
gt-internal args end up appended to the body text, then commitlint
rejects on length/format.

**Recovery (the documented happy path, NOT a fallback):**

```bash
git checkout -b <branch>
# Multi-line body: write to a tempfile to avoid argv mangling
git commit -F /tmp/cmsg.txt
gt track --parent <parent>   # main, or the prior stack branch
gt submit --no-interactive   # works normally from here
```

For single-line messages, `git commit -m "msg with quotes"` is fine; the
issue is gt's argv passing, not git's. **Confirmed 2026-05-03**: a 4-PR
globaldb-yugabyte stack with parens-and-colon subjects (`feat(testing):
enable chrony source/serverstats collectors`) plus multi-paragraph bodies
landed first try via this pattern with no hook bypass.

### A2. Hook validation rejects (or hook itself is broken)

Even with correct argv, hooks can reject for unrelated reasons:

- `01-prek` for the `pre-rebase` stage requires `--pre-rebase-upstream`
  which the global dispatcher may not pass (prek 0.2.17 enforces this
  even when no pre-rebase hooks are configured).
- commitlint may reject for length or format reasons even when the
  message body is technically conventional.
- `gt modify` (without `--message`) sometimes fails with `hook failed:
  00-commitlint` even when the commit message is unchanged. **Confirmed
  2026-05-04 in globaldb-yugabyte:** plain `git commit --amend
  --no-edit` ran cleanly under identical conditions immediately
  afterward, so the trigger is gt-specific argv shape, not the commit
  content.

**Recovery:**

- For amends through gt-modify failures where content is unchanged:
  `git commit --amend --no-edit` by hand, then `gt restack --upstack`
  to propagate. Usually doesn't need `--no-verify` — the issue is gt's
  invocation, not the commit.
- For amends where the hook actually rejects: `git commit --amend
  --no-edit --no-verify`, then `gt restack`.
- For rebases on broken pre-rebase hooks: `git rebase --no-verify
  --onto <new-base> <upstream> <branch>`. Acceptable only for unpushed
  commits.
- For new commits where commitlint rejects: `git commit -F /tmp/cmsg.txt
  --no-verify`, then `gt track --parent <parent>`.

### A3. `prepare-commit-msg` hook hangs `git rebase --continue` on an editor

Symptom: after resolving conflicts and staging files, `git rebase
--continue` (or `gt restack` continuing from a conflict) produces an
`npm` policy-blocked error followed by `Nvim: Caught deadly signal
'SIGTERM'` after the bash tool's 2-minute timeout. Status afterwards:
rebase still paused, all conflicts resolved, no commit produced.

Root cause: the `prepare-commit-msg` hook tries to invoke an `npm`-based
prepare-msg tool. `npm` is blocked here by Shopify's
`minimum_dependency_age` policy. The hook then opens `$EDITOR` (Neovim)
to let a human author the message; in a non-interactive bash session
`nvim` blocks indefinitely waiting for input until SIGTERM.

**Recovery:**

```bash
GIT_EDITOR=true git rebase --continue
```

`true` exits 0 immediately, so the editor invocation no-ops and the
rebase proceeds with the existing commit message. This skips ONLY the
editor invocation; hooks still run. Cleaner than `--no-verify` because
it leaves hook validation in place. **Confirmed 2026-05-04,
globaldb-yugabyte chrony-collectors-default stack.**

## Category B — Graphite metadata / state hygiene

Graphite stores stack topology in `.git/.graphite_cache_persist` (the
parent/SHA cache for tracked branches) and trunk configuration in
`.git/.graphite_repo_config` (which trunks gt should validate on every
command). State drifts in seven recurring ways.

### B1. Untracked branch (`BAD_PARENT_NAME`)

Symptom: `gt restack` / `gt log` / `gt state` errors with "Cannot perform
this operation on untracked branch <name>" or "Could not find branch
<name>". Cache file shows `validationResult: BAD_PARENT_NAME`.

**Recovery:**

```bash
gt track --parent <parent>   # usually main for a single-PR off main
```

Then retry the failing operation.

### B2. "Branch updated remotely outside of Graphite" after local rebase

Root cause: a local rebase changed your branch's SHAs. The remote head
is unchanged but gt's view sees divergence. `gt sync` won't help — gt
considers the branch "up to date with remote" even when the local was
rebased onto a different parent.

**Recovery:**

```bash
gt submit --no-interactive --force
```

VERIFY FIRST that the remote only has YOUR commits, not someone else's,
by inspecting `git log origin/<branch>` against your local rebased
history. If a teammate has pushed to the branch, a `--force` push will
clobber their work. See B7 below for a related but distinct case where
diff-equivalence holds despite SHA divergence.

### B3. Cross-worktree cache poisoning

Multiple worktrees share the canonical `.git/.graphite_cache_persist`.
A branch-deletion or change in worktree A can leave dangling references
that error in worktree B as "Could not find branch X" — even though
that branch is unrelated to the current operation.

**Recovery (in priority order):**

1. `gt sync` — usually recovers; fast-forwards main, prunes deleted
   branches, restacks tracked branches.
2. `gt untrack <stale-branch>` — for known-stale entries.
3. `gt repo init` — full metadata rebuild. Last resort; preserves
   tracked branches but recomputes their parents.

For diagnostic detail, the cache is JSON:

```bash
python3 -c "import json; print(json.dumps(json.load(open('.git/.graphite_cache_persist')), indent=2))" | less
```

### B4. `gt create` from a worktree where main is checked out elsewhere

Symptom: `gt create` fails because git refuses to let two worktrees
check out the same branch.

**Recovery:**

```bash
git checkout -b <branch>   # plain git, doesn't conflict
gt track --parent main
```

### B5. Phantom empty commits from mid-stack restack

After inserting a new branch into the middle of a stack and running
`gt restack`, downstream branches end up with empty-tree commits
duplicated above the real commit that was the basis of the inserted
branch.

**Detection:**

```bash
git log --oneline origin/main..HEAD
# Look for adjacent commits with identical titles
git diff-tree --no-commit-id --name-only <suspect-sha>   # empty = phantom
git rev-parse <suspect-sha>^{tree} <prior-sha>^{tree}    # identical = phantom
```

**Recovery:**

```bash
git rebase --onto <new-base-sha> <phantom-sha> <branch>
gt restack --upstack   # propagate the drop downstream
```

### B6. Stale trunk in `.git/.graphite_repo_config`

Symptom: every `gt` command (including `gt state`, `gt log`, `gt untrack`,
even `gt repo init` non-interactive) errors immediately with `ERROR:
Could not find branch <name>` referring to a stale trunk that was
registered in another worktree or by an old `gt repo init` and has
since been deleted.

Root cause: `.git/.graphite_repo_config` is a JSON file with a top-level
`trunk` (singular, the primary) and `trunks` (plural, the list). gt
validates every entry on every command, so any dead entry blocks ALL
commands.

`gt repo init` cannot fix this non-interactively: it prompts to confirm
"You are about to reset your trunk branches…" and `gt-mcp:run_gt_cmd`
(invoked via `call_tool_write`) can't answer the prompt, so it errors
with `Cannot perform interactive operation in non-interactive mode`.

**Recovery (surgical, no flags needed):**

```bash
# Inspect:
cat .git/.graphite_repo_config
# Edit the JSON to remove the dead entry from "trunks":[...]
# Leave "trunk":"main" alone if main is still your real trunk.
```

Example before → after:

```json
{ "trunk": "main",
  "trunks": [ { "name": "main" }, { "name": "molecule-zones-base" } ] }
```

becomes

```json
{ "trunk": "main", "trunks": [ { "name": "main" } ] }
```

The file is regenerated by `gt repo init` / `gt aliases` / etc., so
editing it is reversible. After the edit, `gt state` returns immediately.

This is distinct from B3 (which is about `.graphite_cache_persist` and
CAN be fixed with `gt sync` / `gt untrack` / `gt repo init`); B6 cannot
use those because they all run validation first and fail.

### B7. Local restack vs. remote auto-rebase produce different SHAs with identical diffs

Symptom: `gt submit` reports "Branch updated remotely" even though
nobody pushed manually. Comparing local and remote: different head SHAs
but `git diff origin/main...local` equals `git diff origin/main...remote`
(same tree, different commit identity).

Root cause: when a downstream PR in a Graphite stack merges to main,
Graphite's server-side automation auto-rebases the remaining stack
branches on the new main and pushes the rebased SHAs back. When the
agent runs `gt restack` locally, gt computes its own rebase (also onto
the new main), producing different SHAs with the same tree. `gt submit`
sees divergence and refuses.

This is NOT a B2 conflict — there's no real divergence in either
branch's content; it's purely commit-identity drift between two
equivalent rebases.

**Recovery (in order of preference):**

1. **Don't fight it** — adopt the remote auto-rebased SHAs as local
   truth:

   ```bash
   git fetch origin <branch>
   git reset --hard origin/<branch>
   gt track --parent <parent>
   ```

   Caveat: a subsequent `gt restack` (without intervening changes) will
   regenerate different SHAs and B7 will recur on the next submit. The
   reset is durable only if you submit immediately afterwards.

2. **Force-with-lease push** — verify diff-equivalence first:

   ```bash
   diff <(git diff origin/main...local-branch) \
        <(git diff origin/main...origin/local-branch) \
     && echo identical
   # If identical, force-push is safe (semantically a no-op):
   gt submit --no-interactive --force   # AFTER user authorization
   ```

If the diff-equivalence check does NOT return "identical", you have a
real B2 divergence — investigate before clobbering remote.

**Confirmed 2026-05-04 globaldb-yugabyte chrony-collectors stack:**
After PR 5895 merged, remote auto-rebased production+default to new
SHAs. Local `gt restack` produced different SHAs. Diff equivalence
verified. Force-with-lease push aligned remote.

## Category C — Workflow / mental-model traps

These are not "errors" gt surfaces; they are silent UX traps that produce
wrong-looking outcomes.

### C1. `gt modify` commits on the CURRENT branch, not the file's owning PR

`gt modify` amends/commits on whatever branch is checked out. It does
NOT detect which PR a file change belongs to based on path or diff
history.

**Common mistake:** edit a file that belongs to PR 2 while checked out
on PR 5's branch, then `gt modify` — the change lands on PR 5.

**Pre-emptive rule:** ALWAYS `git checkout <target-branch>` BEFORE
editing files for a stack-mid PR. Verify with `git status` before
running `gt modify`.

**Recovery if committed on wrong branch:**

```bash
git reset HEAD~1
git checkout -- <file>           # restore on wrong branch
git checkout <correct-branch>    # switch to correct branch
# re-apply the edit, stage, gt modify
```

### C2. `gt submit --no-interactive` only submits downstack

From the bottom of the stack, `gt submit --no-interactive` submits
exactly the bottom branch. Upstack PRs are NOT submitted.

**Pre-emptive rule:** when at the bottom of a stack, ALWAYS pass
`--stack`:

```bash
gt submit --no-interactive --stack
```

When at the top, `--stack` is implicit (everything below is downstack).

### C3. Force-pushing the bottom of an N-PR stack invalidates approvals

After `gt restack` propagates a fix from the bottom up, every upstream
PR's head SHA changes. GitHub invalidates existing approvals on all N-1
upstream PRs.

**Pre-emptive rule:** before applying even tiny fixes to a bottom
branch, surface the re-approval cost to the user. Ask whether the fix
is worth re-approval cycles for every upstream PR, or whether the fix
should be applied higher in the stack.

### C4. Open-source repos: don't use gt

User policy: Shopify open-source repos (e.g., `Shopify/cli-kit`) go
through GitHub PRs, NOT Graphite. The user has explicitly stated this
multiple times.

**Pre-emptive rule:**

- Internal Shopify monorepos (shop/world, infra-central,
  globaldb-yugabyte, similar): default to gt.
- Open-source Shopify repos: use plain git + `gh pr create`. Ask the
  user if uncertain.
- Personal repos (e.g., `DWSR/nix-config`): plain git unless the user
  is already using gt locally.

### C5. `gt submit --no-interactive` always creates PRs as drafts

After a successful `gt submit --no-interactive`, all created PRs show
`isDraft: true`. There is no flag to override the draft default in
non-interactive mode. gt's own output makes this explicit:

> Running in non-interactive mode. Inline prompts to fill PR fields
> will be skipped and new PRs will be created in draft mode.

In practice the title and body ARE populated correctly from the commit
subject and body — gt parses those into the PR fields. The "skipped
inline prompts" only matter for assignees, reviewers, labels, and
choosing draft-vs-ready.

**Pre-emptive rule:** never claim a stack is "ready for review" right
after a non-interactive submit. Verify each PR's title/body/isDraft
with `gh pr view <num> --json title,body,isDraft` and ask the user
whether to leave as drafts or convert:

```bash
# Convert all stack PRs to ready-for-review:
gh pr ready <num1> <num2> <num3> <num4> --repo <owner/repo>
```

Drafts are also a useful affordance: they let the user inspect the
diff and PR description before reviewers are notified. Default to
leaving as draft unless the user asks otherwise.

### C6. `pull_request_review_write` does NOT have a `resolve_thread` method

The GitHub MCP `pull_request_review_write` tool (invoked via mcpproxy's
`retrieve_tools` + `call_tool_write` idiom) supports only `method` values
`create`, `submit_pending`, and `delete_pending`. There is NO
`resolve_thread` method. Older runbooks claimed it exists; they're wrong.

**Recovery (no flags / no auth needed beyond gh):**

Find the threadId from a comment's `databaseId` (returned by
`pull_request_read get_review_comments`):

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        nodes {
          id isResolved isOutdated
          comments(first: 1) {
            nodes { databaseId author { login } path }
          }
        }
      }
    }
  }
}' -F owner=<org> -F repo=<repo> -F pr=<num>
```

Match by `databaseId` to find the right `id` (PRRT_…), then resolve:

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}' -F threadId=PRRT_xxxxxxxxxxxxxxxxxxx
```

**Confirmed 2026-05-04 globaldb-yugabyte PR 5897.**

### C7. CI-fix cycles on stacked PRs are amplified-cost

Every CI-failure-fix cycle on a stacked PR is far more expensive than
on a single PR:

- Amend the affected branch (`gt modify` or `git commit --amend`)
- `gt restack --upstack` propagates new SHAs through every upstack branch
- Force-push each rebased branch (B2 / B7 territory)
- GitHub invalidates approvals on every upstack PR (C3)
- CI re-runs on every branch

A single 5-cycle CI debugging session in a 4-PR stack means ~20
force-pushes, ~16 invalidated approvals, and ~20 CI re-runs.
**Confirmed 2026-05-04 chrony-collectors stack:** five separate Ansible
CI failures discovered serially over ~5 hours (variable-precedence
trap, self-referential Jinja, binary-version flag mismatch,
wrapper-role meta-deps version pin, etc.) each requiring its own
amend+restack+force-push cycle.

**Pre-emptive rule:** before pushing a stacked PR for the first time,
invest aggressively in local validation — molecule for Ansible,
`nix flake check` for nix changes, `bin/dev test` for Rails,
language-server diagnostics + targeted unit tests for everything
else. The first push should be the LAST push if at all possible.

When a CI failure IS discovered, batch related speculative fixes
into a single cycle when uncertainty is high — the marginal cost of
adding one more change to an already-failing rebase is much lower
than the cost of an extra full cycle.

When iteration on a stack starts to feel expensive (≥3 CI cycles
deep), surface the alternative to the user: collapsing the stack
into a single PR for the duration of the debugging session, then
re-splitting once green.

## Workflow rules summary

1. Try `gt <command>` as documented.
2. If it errors, classify (Category A / B / C above). On a gt-MCP-only
   stack `gt submit --no-interactive` should succeed without `--force`;
   if it doesn't, the stack has left the green path (Category B2/B3/B7
   most likely) and one of the documented recoveries applies.
3. Apply the documented recovery from the catalog.
4. If the recovery requires `--no-verify`, `--force`, `--force-with-lease`,
   or a Git environment override like `GIT_EDITOR=true`, ASK THE USER
   FIRST via the `question` tool. No exceptions. Conversely, do NOT
   pre-emptively reach for these flags on a stack you've only touched
   via the gt MCP — the green path doesn't need them.
5. After every plain-git rebase or amend, validate with
   `git log --oneline origin/main..HEAD` looking for adjacent same-title
   or same-tree commits (phantom detection — see B5).
6. Before any `--force` push (B2/B7), verify diff-equivalence with
   `diff <(git diff origin/main...local) <(git diff origin/main...remote)`
   to ensure you're not clobbering teammate work. If they differ, the
   situation is B2 (real divergence), not B7 (auto-rebase) — investigate
   before clobbering.
7. After every `gt restack` / `gt submit --force`, sanity-check the
   remote state with `gh pr view <num> --json mergeable,mergeStateStatus`
   — `DIRTY` is "computing" (~30s lag); `MERGEABLE` or `BLOCKED` is
   settled.
8. After `gt submit --no-interactive`, verify each PR's title/body/isDraft
   with `gh pr view <num> --json title,body,isDraft` before declaring the
   work done; ask the user whether to leave as drafts or `gh pr ready`
   them (see C5).

When in doubt, present the failure and proposed workaround to the user
via the `question` tool before bypassing.
