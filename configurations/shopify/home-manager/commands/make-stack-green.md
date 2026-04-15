---
description: Autonomously fix CI failures and address bot review comments across a Graphite PR stack
---

# Make Stack Green

Autonomously process a Graphite PR stack from bottom to top, fixing CI failures and addressing bot review comments on each PR until the entire stack is green.

## Usage

```
/make-stack-green
```

No arguments. Operates on the current Graphite PR stack in the working directory.

## Prerequisites

- A Graphite PR stack must exist (use `gt state` to verify)
- GitHub MCP must be available (PR status, review comments, thread resolution, Copilot review)
- Buildkite MCP must be available (CI job log analysis)
- GT MCP must be available (stack management, `gt modify`, `gt submit`)

## Instructions

### Step 0: Identify the stack and request Copilot reviews

1. Use `hub_gt_mcp__run_gt_cmd` to run `gt state` and identify the full PR stack (bottom to top).

2. For each PR in the stack, determine the PR number and owner/repo from the branch context.

3. For each PR, use `hub_github__request_copilot_review` to request a Copilot review. This is fire-and-forget — Copilot reviews asynchronously while we work on CI fixes.

4. Present the stack overview to the user: PR numbers, titles, branches, current CI status.

### Step 1: Process each PR (bottom to top)

Process PRs sequentially from the bottom of the stack upward. Fixes on lower PRs propagate to upper ones via `gt modify`'s automatic restack.

For each PR:

#### Step 1a: Fix CI failures

1. Use `hub_github__pull_request_read` with `method: "get_status"` to get the CI status of the PR's head commit.

2. If all checks pass: skip to Step 1b.

3. If any checks fail:

**Analyze the failure:**
- Identify the failing check(s) from the commit status.
- Use `hub_github__get_job_logs` with `failed_only: true` and the workflow `run_id` to get detailed failure logs.
- Read the logs to identify the root cause.

**Assess the fix size:**
- Determine whether the fix is **small and targeted** (syntax error, missing import, test assertion update, formatting issue, linting violation) or **large and design-level** (architectural change, significant refactor, new feature requirement, fundamental approach change).
- **If small**: proceed to fix autonomously.
- **If large**: present the findings to the user:
  - The failure root cause
  - 2-3 possible implementation approaches
  - Estimated scope of changes for each approach
  - Ask for confirmation before proceeding.

**Fix the code:**
1. Make the targeted fix.

2. **Peer review**: Before committing, engage a second perspective:
   - **Agent 1 (implementer)**: made the fix and explains the rationale.
   - **Agent 2 (reviewer)**: reviews the fix for:
     - Correctness: does it actually fix the issue?
     - Side effects: could it break anything else?
     - Scope: is the change minimal and targeted? Does it touch files outside this PR's scope?
     - Test coverage: does the fix need an accompanying test?
   - If the reviewer raises concerns: iterate on the fix before committing.

3. Checkout the correct branch for this PR. Use `hub_gt_mcp__run_gt_cmd` to run `gt modify --message "<description of fix>"` to amend the commit and automatically restack.

4. Use `hub_gt_mcp__run_gt_cmd` to run `gt submit --no-interactive --stack` to push all branches.

5. Wait for CI to re-run on this PR. Poll using `hub_github__pull_request_read` with `method: "get_status"`.

6. If CI still fails: repeat from the analysis step. Maximum 3 attempts per PR — if still failing after 3 attempts, present the situation to the user and ask how to proceed.

#### Step 1b: Wait for binks review

1. Use `hub_github__pull_request_read` with `method: "get_status"` and look for the "PR Review Bot Comments Addressed" check from `binks.shopify.io`.

2. Check the status of this check:
   - **pending / in_progress**: Binks is still reviewing. Wait 30 seconds and poll again. New comments may appear while binks is working.
   - **success**: All bot comments are already addressed. Skip to Step 1d.
   - **failure**: Bot comments need to be addressed. Proceed to Step 1c.
   - **Not found**: Binks may not be configured for this repo. Skip to Step 1d.

3. Maximum wait time: 5 minutes. If binks is still reviewing after 5 minutes, proceed to Step 1c with whatever comments exist. New comments from binks will be caught in the next iteration.

#### Step 1c: Address bot review comments

1. Use `hub_github__pull_request_read` with `method: "get_review_comments"` to get all review comments.

2. Filter to unresolved comments from bot authors (identified by `[bot]` suffix in username, e.g., `binks-code-reviewer[bot]`, `copilot[bot]`).

3. For each unresolved bot comment:

**Analyze the comment:**
- Read the comment body and the code it references.
- Read the surrounding context in the file.
- If the comment references functionality that might exist in another PR in the stack, check those PRs.

**Categorize the comment:**

**Category A — Actionable fix**: The comment identifies a real issue that should be fixed.
- Assess fix size (same guardrail as CI fixes):
  - **Small**: fix autonomously with peer review.
  - **Large**: present to user with implementation options.
- Fix the code.
- Peer review the fix (Agent 2 reviews).
- Reply to the comment thread explaining the fix using `hub_github__add_issue_comment` on the PR.
- Resolve the thread using `hub_github__pull_request_review_write` with `method: "resolve_thread"` and the comment's `threadId`.

**Category B — Stacked PR false positive**: The comment flags missing functionality that exists in another PR in the stack.
- Reply to the comment explaining the stacked PR context: "This is by design for a stacked PR — this PR adds [X], and PR #[YYYY] in the stack adds [Y]."
- Resolve the thread using `hub_github__pull_request_review_write` with `method: "resolve_thread"`.

**Category C — Not applicable / incorrect**: The comment doesn't make sense for this code or is factually wrong.
- React to the comment with 👎 using bash: `gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content="-1"`
- Reply explaining why the comment is not applicable.
- Resolve the thread using `hub_github__pull_request_review_write` with `method: "resolve_thread"`.

4. After addressing all comments on this PR:
   - If any code changes were made: use `hub_gt_mcp__run_gt_cmd` to run `gt modify` with a descriptive message, then `gt submit --no-interactive --stack`.
   - Wait for CI to re-run.

#### Step 1d: Verify this PR is green

1. Check CI status — all checks must pass.
2. Check "PR Review Bot Comments Addressed" — must be success or not present.
3. Check review threads — zero unresolved bot comment threads.
4. If CI broke from bot-comment code fixes: loop back to Step 1a.
5. If new bot comments appeared (from code pushes): loop back to Step 1b.
6. If everything is green: move to the next PR up the stack.

### Step 2: Final verification

After all PRs have been processed:

1. Use `hub_gt_mcp__run_gt_cmd` to run `gt state` to confirm the stack is clean.
2. For each PR: verify CI green + zero unresolved bot threads.
3. If any PR still has issues: report which ones and what's remaining.

### Step 3: Report

Present a summary including:

- **Stack overview**: each PR with final CI status and unresolved thread count
- **Changes made**: per-PR list of fixes applied (CI fixes and bot comment resolutions)
- **Comments thumbs-downed**: any bot comments that were reacted to with 👎 as not applicable
- **Large changes deferred**: any findings that were presented to the user instead of fixed autonomously
- **Human reviewer comments**: flag any remaining unresolved comments from human reviewers (not bots) that need manual attention

## Tool Reference

| Capability | Tool | Method/Parameters |
|---|---|---|
| Get PR stack | `hub_gt_mcp__run_gt_cmd` | `gt state` |
| Modify PR commit | `hub_gt_mcp__run_gt_cmd` | `gt modify --message "..."` |
| Submit stack | `hub_gt_mcp__run_gt_cmd` | `gt submit --no-interactive --stack` |
| Get CI status | `hub_github__pull_request_read` | `method: "get_status"` |
| Get review comments | `hub_github__pull_request_read` | `method: "get_review_comments"` |
| Get failed CI logs | `hub_github__get_job_logs` | `failed_only: true` |
| Request Copilot review | `hub_github__request_copilot_review` | `owner, repo, pullNumber` |
| Reply to PR comment | `hub_github__add_issue_comment` | `owner, repo, issue_number, body` |
| Resolve review thread | `hub_github__pull_request_review_write` | `method: "resolve_thread"`, `threadId: "PRRT_..."` |
| React with 👎 | bash `gh api` | `repos/{o}/{r}/pulls/comments/{id}/reactions -f content="-1"` |

## Notes

- **Bottom-up processing is critical.** Fixes on lower PRs propagate to upper ones via `gt modify`'s automatic restack. Starting from the top would cause cascading conflicts.
- **`gt modify` automatically restacks.** Unlike `git commit --amend` which requires a separate `gt restack`, `gt modify` amends the commit AND restacks all upstack branches in one operation.
- **The "PR Review Bot Comments Addressed" check is the gate for binks.** Use this status to determine if binks is still reviewing (pending/in_progress) or has completed (success/failure). Don't process bot comments while binks is still reviewing — new comments may appear.
- **Copilot reviews are requested upfront** but processed like any other bot comment. Copilot's comments appear as review comments from `copilot[bot]` and follow the same address/resolve workflow.
- **The peer review pattern** (Agent 1 implements, Agent 2 reviews) applies to every code change, both CI fixes and bot comment fixes. This prevents scope creep and catches side effects.
- **Reactions (👎) require the `gh` CLI** because the GitHub MCP server does not expose a reactions tool. Use `gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content="-1"` via bash.
- **Human reviewer comments are NOT addressed** by this command. They are flagged in the final report for manual attention.
