---
name: create-yb-fix-pr
description: >-
  Create an upstream fix PR on yugabyte/yugabyte-db from a completed issue
  analysis (e.g. the artifact produced by validate-yb-issue). Dispatches the
  yb-fix-pr-author subagent, wrapping the in-repo .claude/skills/create-pr
  skill with the quirks of this host and checkout — critically, the branch
  MUST be named feature-stack/<issue>-<slug> because upstream rulesets only
  accept pushes in the feature-stack/* namespace. Use when the user asks to
  implement a fix for a validated yugabyte-db issue and publish it as a
  GitHub PR.
---

# Create YugabyteDB Fix PR

Turn a validated issue analysis into a fix landed on a `feature-stack/*`
branch, pushed to `yugabyte/yugabyte-db` (`origin` in this checkout), and
opened as a PR against `master`.

## Execution model — dispatch the subagent

This skill runs as a dispatcher in the main session; the heavy work happens in
the `yb-fix-pr-author` subagent, which inherits OpenCode's configured default
model without a model-specific variant override and has full permissions.

**If you ARE the `yb-fix-pr-author` subagent, skip this section and execute
the workflow below directly. Never re-dispatch.**

As the dispatcher:

1. Pin down the inputs: issue number, the analysis artifact path (or the
   analysis content itself), and any authorizations the user has ALREADY
   granted this session (commit-hook bypass, force-with-lease, draft vs
   ready). Default: nothing is pre-authorized.
2. Launch via the Task tool with `subagent_type: "yb-fix-pr-author"`. The
   prompt must contain: the issue reference, the analysis artifact path or
   inline analysis, the authorization state, and the required return format
   (branch name, commit SHAs, build/test/lint evidence, PR URL +
   post-creation verification, pending items).
3. The workflow contains hard authorization gates (`noVerify` commit,
   `forceWithLease` push, draft-vs-ready). When the subagent returns with a
   pending authorization, relay it to the user via the question tool, then
   resume the same task (pass the prior `task_id`) with the answer.
4. Present the PR URL and verification evidence to the user; do not silently
   re-do the subagent's work in the main session.

## Relationship to the in-repo create-pr skill

Read `.claude/skills/create-pr/SKILL.md` before starting. Its confidentiality
rules, metadata gathering (Step 3), title format (Step 4), PR body layout, and
post-creation REST workarounds all apply here unchanged. This skill REPLACES
its push/PR mechanics, which assume a personal-fork remote this checkout does
not have. Where the two conflict, this skill wins.

| in-repo skill / src/AGENTS.md says      | this checkout does                                          |
| --------------------------------------- | ----------------------------------------------------------- |
| never push to `yugabyte/yugabyte-db`    | push IS allowed, but only branches named `feature-stack/*`  |
| push to your fork via `create-pr.sh` / `git-push.sh` | both are unusable: the sole remote `origin` points at the upstream, so fork auto-detection fails and `git-push.sh`'s fork==upstream guard exits 1 by design |
| `git commit -F` / raw `git push` in bash | bash `git` is denied in the opencode sandbox — all git goes through `git-mcp:*` with an explicit absolute `path` |
| cross-repo head `<user>:<branch>`       | same-repo head `feature-stack/<...>` (no owner prefix needed for `gh pr create`) |

The confidentiality scrub is not weakened by any of this: branch name, commit
messages, code, tests, PR title/body are all public. Scrub per
`src/AGENTS.md` § Confidentiality before every publish step.

## Step 0: Inputs and memory recall

- **Analysis** — `/tmp/claude/yb-issue-<NNNN>-analysis.md` from
  `validate-yb-issue`, a memory note, or equivalent in-conversation
  analysis. It must name the root cause (file:line), fix direction, and test
  strategy. Verdict must be VALIDATED (or the user explicitly waives it).
- **Issue number** — required for branch and title. If none exists, follow
  `.claude/skills/create-issue/SKILL.md` to file one first.
- Search Obsidian memories for the issue number and for
  `create-pr` / `feature-stack` tags — pushes or partial PRs may already
  exist from a prior session. Check for an existing PR before doing anything:

  ```bash
  gh api 'repos/yugabyte/yugabyte-db/pulls?state=all&head=yugabyte:feature-stack/<branch>' \
    --jq '.[] | {number, state, html_url}'
  ```

## Step 1: Branch — `feature-stack/*` is mandatory

**Name: `feature-stack/<issue>-<short-kebab-slug>`**, e.g.
`feature-stack/31078-pgss-track-all-default` (user-confirmed convention).

Why: `yugabyte/yugabyte-db` repository rulesets block `creation`, `update`,
and `required_linear_history` for ordinary branch names, but the
`feature-stack/*` namespace is exempt. Verify anytime with:

```bash
gh api 'repos/yugabyte/yugabyte-db/rules/branches/feature-stack%2F<branch-rest>'   # → []  (pushable)
gh api 'repos/yugabyte/yugabyte-db/rules/branches/any-plain-name'                  # → creation/update/... rules (blocked)
```

Hard-won corollaries:

- **A push rejected with 403 means "wrong branch name" first**, not broken
  credentials. A prior session burned time swapping the push URL to SSH and
  back — dead end. Rename the branch and retry before touching remotes.
- **Create the branch from a fresh base with an explicit start point**:
  `git-mcp:git_fetch` (remote `origin`), then `git-mcp:git_branch`
  `mode: create` with `startPoint: "origin/master"`, then checkout.
  Do NOT use `git_checkout` with `createBranch: true` — it branches from the
  current `HEAD` and has no start-point argument; run from another PR branch
  it contaminates the new branch with that PR's commits (verified failure).
- **Wrong-named existing branch**: `git-mcp:git_branch` `mode: rename` to the
  compliant name, then push. Local commits are preserved.
- **Never work on `master`** (src/AGENTS.md), and the branch name becomes the
  PR's public head ref — name it after the change, never after a customer.

## Step 2: Implement the fix and regression test

Follow the analysis artifact's "Proposed fix direction" and "Test strategy".
House rules that bite:

- Build/test only via `yb_build.sh` (see `src/AGENTS.md` for fast-path flags,
  `--cxx-test <target> --gtest_filter '<OneCase>'`, and incremental-build
  pitfalls like `reinitdb`).
- Tests exercise the fixed path through PUBLIC entry points; do not add
  test-only production APIs.
- ASCII only in code and commit messages.
- Changes under `src/postgres/` (upstream-owned files) trip the lint check
  `postgres/missing_yb_marker_for_yb_changes` unless YB-introduced
  identifiers carry a `yb`/`ysql`/`yuga` prefix or a YB comment marks the
  hunk. Handle this while writing the code, not after lint fails.

## Step 3: Commit via git-mcp

- `git-mcp:git_commit` with absolute `path` and an explicit `filesToStage`
  list (never blanket staging — no stray artifacts in a public PR).
- Subject follows the REPO convention, not Conventional Commits:
  `[#NNNN] <Component>: <Title>` (components: DocDB, YSQL, YCQL, YBA, CDC,
  xCluster, yugabyted, Docs, Build). This repo squash-merges, so the PR
  title/commit subject is what lands on master.
- The GLOBAL commitlint hook rejects that format (`type is empty`), so the
  commit needs `noVerify: true`. That is a hook bypass: **ask the user via
  the question tool first** (bypass-autonomy rule; precedent: authorized for
  the #31078 commit).
- Agent-authored commits append the signature block to the body
  (`---` / `_automated · <agent>_`), never to the subject.
- A git-mcp commit can time out while hooks still run: check `git_status` +
  `git_log` before retrying so you don't create a duplicate commit.

## Step 4: Rebase and lint (manual replacement for git-push.sh)

`git-push.sh` refuses this remote layout, so run its steps yourself:

1. `git-mcp:git_fetch` remote `origin`.
2. `git-mcp:git_rebase` `mode: start`, `upstream: "origin/master"`.
3. `bash: ./build-support/lint.sh --rev origin/master` (from the repo root).

Lint failures are fixed as a NEW commit — never amend a pushed commit
(squash-merge repo; per-commit history is a review aid). If the rebase moved
the branch onto meaningfully newer master, rerun the focused test from the
analysis before pushing.

## Step 5: Push

- First push: `git-mcp:git_push` with `remote: "origin"`,
  `setUpstream: true` — plain push, no force flags.
- Any re-push after a rebase rewrites SHAs and needs `forceWithLease: true`:
  **ask the user first**, every time.
- Verify the remote ref landed:

  ```bash
  gh api 'repos/yugabyte/yugabyte-db/git/matching-refs/heads/feature-stack/<prefix>' \
    --jq '.[] | "\(.ref) \(.object.sha)"'
  ```

## Step 6: Create the PR

Metadata per the in-repo skill: title `[#NNNN] <Component>: <Title>`
(backticks in the title are fine); body sections `## Summary` (include
`Fixes #NNNN` so the merge closes the issue; mention the Jira `DB-NNNNN` if
the issue carries one), `## Upgrade/Rollback safety` (required for `.proto`,
gflag-default, catalog-schema, on-disk-format, RPC-versioning, or migration
changes), `## Test plan` (checkboxes of commands actually run). Body to a
file under `/tmp/claude/`. Final confidentiality scrub, then:

```bash
gh pr create --repo yugabyte/yugabyte-db --base master \
  --head 'feature-stack/<issue>-<slug>' \
  --title '[#NNNN] <Component>: <Title>' \
  --body-file /tmp/claude/pr-body-<NNNN>.md
```

(`--draft` only when the user asked for a draft.)

### Known failure modes at this step

- **Intermittent opaque HTTP 500s from PR creation.** Observed on
  `POST /repos/yugabyte/yugabyte-db/pulls` AND GraphQL `createPullRequest`
  while githubstatus.com showed all green. The 500 has an EMPTY body, so a
  `--jq` filter reports the misleading `unexpected end of JSON input` —
  rerun with `gh api -i` to see the real status line before misdiagnosing.
- **Duplicate-check before EVERY retry** (a 500 does not prove the PR wasn't
  created):

  ```bash
  gh api 'repos/yugabyte/yugabyte-db/pulls?state=all&head=yugabyte:feature-stack/<branch>' --jq length
  ```

  Use the list endpoint, not `search_pull_requests` — the search index lags.
- **If 500s persist**: wait and retry later, or hand the user the compare URL
  for one-click web-UI creation — this is how PR #32862 (#31078) ultimately
  landed after a session of API 500s:

  ```
  https://github.com/yugabyte/yugabyte-db/compare/master...feature-stack/<branch>?expand=1
  ```

- **GraphQL fallback**: use the current repo node ID `R_kgDOBlCVUQ` — the
  legacy `MDEwOlJlcG9zaXRvcnkxMDU5NDQ0MDE=` is deprecated.
- **`gh pr edit` is broken on this repo** (Projects-classic GraphQL
  deprecation). Post-creation edits go through REST per the in-repo skill's
  Notes: `PATCH /repos/yugabyte/yugabyte-db/pulls/<num>` for title/body,
  `POST .../requested_reviewers` for reviewers.

After creation, verify title, body, base/head refs and SHA, changed files,
and draft state via `gh pr view <num> --json ...`; report the URL, and ask
draft-vs-ready if it was created as a draft.

## Step 7: Review-feedback loop

- Address feedback as follow-up commits (never amend), rebase+lint+push per
  Steps 4-5 (force-with-lease needs authorization each time).
- Resolve threads via the GraphQL `resolveReviewThread` mutation; don't post
  trivial "Done" replies; do reply when declining or diverging from a
  suggestion (`src/AGENTS.md` § Replying to PR review comments).
- Update the PR body only when scope/approach/test-plan changed.
- The consumer Gemini Code Assist reviewer is shut down — do not wait for
  `/gemini review` output; still re-fetch review threads after every push.

## Step 8: Memory

Update `memories/2026-07-10-yugabyte-create-pr-workflow-gotchas.md` (or the
feature-stack workflow memory) with anything new this run taught — new
failure modes, ruleset changes, PR numbers validating the workflow — and add
the session to its `sessions:` list.
