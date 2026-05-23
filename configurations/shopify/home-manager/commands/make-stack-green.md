---
description: Autonomously fix CI failures and address bot review comments across a Graphite PR stack
---

# Make Stack Green

Autonomously process a Graphite PR stack from bottom to top, fixing CI failures and addressing bot review comments on each PR until every actionable check is green.

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

## Tool invocation idiom

All MCP work goes through mcpproxy's four-tool agent surface
(`retrieve_tools` + `call_tool_*`). For each upstream tool referenced
below, discover its canonical name with
`retrieve_tools(query: "<server> <operation>")` — the result's `name`
field is in `server:tool` form and the `call_with` field recommends
the verb. Invoke through the verb that matches the operation's
side-effect class:

- `call_tool_read` — read-only operations: `github:pull_request_read`,
  `github:get_job_logs`.
- `call_tool_write` — state-mutating operations: `gt-mcp:run_gt_cmd`
  (every `gt` subcommand changes VCS state),
  `github:request_copilot_review`, `github:add_issue_comment`,
  `github:pull_request_review_write` (only for `method: "create"`,
  `"submit_pending"`, `"delete_pending"`).
- `call_tool_destructive` — not used by this command.

**Known gap**: `github:pull_request_review_write` does NOT have a
`resolve_thread` method, despite what older runbooks claim. To resolve
a review thread, fall back to `gh api graphql` with the
`resolveReviewThread` mutation — see the `graphite-pitfalls` skill C6
for the canonical incantation. The bash invocation is the documented
recovery; no other MCP tool exposes thread resolution.

Every `call_tool_*` invocation takes:
- `name`: the upstream tool name in `server:tool` form, exactly as
  returned by `retrieve_tools` (do NOT guess or invent it).
- `args`: a JSON object holding the upstream tool's parameters
  (NOT the legacy `arguments` field name).

When the workflow text below references a tool by its short name (e.g.
"invoke `github:pull_request_read` with `method: get_status`"), apply
the two-step idiom: discover via `retrieve_tools`, then invoke through
the appropriate `call_tool_*` verb listed above, passing the upstream
tool's parameters in `args`.

## Instructions

### Step 0: Identify the stack and request Copilot reviews

1. Invoke `gt-mcp:run_gt_cmd` (via `call_tool_write`) with `args: { command: "gt state" }` to identify the full PR stack (bottom to top).

2. For each PR in the stack, determine the PR number and owner/repo from the branch context.

3. For each PR, invoke `github:request_copilot_review` (via `call_tool_write`) to request a Copilot review. This is fire-and-forget — Copilot reviews asynchronously while we work on CI fixes.

4. Present the stack overview to the user: PR numbers, titles, branches, current CI status.

### Step 1: Process each PR (bottom to top)

Process PRs sequentially from the bottom of the stack upward. Fixes on lower PRs propagate to upper ones via `gt modify`'s automatic restack.

For each PR:

#### Step 1a: Fix CI failures

1. Invoke `github:pull_request_read` (via `call_tool_read`) with `args: { method: "get_status", ... }` to get the CI status of the PR's head commit.

2. If all actionable checks pass: skip to Step 1b. Ignore the `Graphite Mergeability Check`; it is expected to stay pending or red until all other checks pass and all CODEOWNERS approvals are present.

3. If any actionable checks fail:

**Analyze the failure:**
- Identify the failing actionable check(s) from the commit status.
- Invoke `github:get_job_logs` (via `call_tool_read`) with `args: { failed_only: true, run_id: <id>, ... }` to get detailed failure logs.
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

3. Checkout the correct branch for this PR. Invoke `gt-mcp:run_gt_cmd` (via `call_tool_write`) with `args: { command: "gt modify --message \"<description of fix>\"" }` to amend the commit and automatically restack.

4. Invoke `gt-mcp:run_gt_cmd` (via `call_tool_write`) with `args: { command: "gt submit --no-interactive --stack" }` to push all branches.

5. Wait for CI to re-run on this PR. Poll using `github:pull_request_read` (via `call_tool_read`) with `args: { method: "get_status", ... }`.

6. If CI still fails: repeat from the analysis step. Maximum 3 attempts per PR — if still failing after 3 attempts, present the situation to the user and ask how to proceed.

#### Step 1b: Wait for binks review

1. Invoke `github:pull_request_read` (via `call_tool_read`) with `args: { method: "get_status", ... }` and look for the "PR Review Bot Comments Addressed" check from `binks.shopify.io`.

2. Check the status of this check:
   - **pending / in_progress**: Binks is still reviewing. Wait 30 seconds and poll again. New comments may appear while binks is working.
   - **success**: All bot comments are already addressed. Skip to Step 1d.
   - **failure**: Bot comments need to be addressed. Proceed to Step 1c.
   - **Not found**: Binks may not be configured for this repo. Skip to Step 1d.

3. Maximum wait time: 5 minutes. If binks is still reviewing after 5 minutes, proceed to Step 1c with whatever comments exist. New comments from binks will be caught in the next iteration.

#### Step 1c: Address bot review comments

1. Invoke `github:pull_request_read` (via `call_tool_read`) with `args: { method: "get_review_comments", ... }` to get all review comments.

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
- Reply to the comment thread explaining the fix by invoking `github:add_issue_comment` (via `call_tool_write`) on the PR.
- Resolve the thread via `gh api graphql` with the `resolveReviewThread` mutation (see `graphite-pitfalls` C6 for the canonical incantation). Look up the `threadId` (PRRT_…) by matching the comment's `databaseId` against `reviewThreads` returned from a GraphQL query against `repository.pullRequest.reviewThreads`.

**Category B — Stacked PR false positive**: The comment flags missing functionality that exists in another PR in the stack.
- Reply to the comment explaining the stacked PR context: "This is by design for a stacked PR — this PR adds [X], and PR #[YYYY] in the stack adds [Y]."
- Resolve the thread via `gh api graphql resolveReviewThread` as above.

**Category C — Not applicable / incorrect**: The comment doesn't make sense for this code or is factually wrong.
- React to the comment with 👎 using bash: `gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content="-1"`
- Reply explaining why the comment is not applicable.
- Resolve the thread via `gh api graphql resolveReviewThread` as above.

4. After addressing all comments on this PR:
   - If any code changes were made: invoke `gt-mcp:run_gt_cmd` (via `call_tool_write`) with `args: { command: "gt modify --message \"<message>\"" }`, then again with `args: { command: "gt submit --no-interactive --stack" }`.
   - Wait for CI to re-run.

#### Step 1d: Verify this PR is green

1. Check CI status — all actionable checks must pass. Ignore `Graphite Mergeability Check`; do not wait on it or treat it as a failure to fix.
2. Check "PR Review Bot Comments Addressed" — must be success or not present.
3. Check review threads — zero unresolved bot comment threads.
4. If CI broke from bot-comment code fixes: loop back to Step 1a.
5. If new bot comments appeared (from code pushes): loop back to Step 1b.
6. If every actionable gate is green: move to the next PR up the stack.

### Step 2: Final verification

After all PRs have been processed:

1. Invoke `gt-mcp:run_gt_cmd` (via `call_tool_write`) with `args: { command: "gt state" }` to confirm the stack is clean.
2. For each PR: verify actionable CI green + zero unresolved bot threads, excluding `Graphite Mergeability Check` from the green calculation.
3. If any PR still has issues: report which ones and what's remaining.

### Step 3: Report

Present a summary including:

- **Stack overview**: each PR with final actionable CI status and unresolved thread count; note `Graphite Mergeability Check` separately if it is the only remaining blocker
- **Changes made**: per-PR list of fixes applied (CI fixes and bot comment resolutions)
- **Comments thumbs-downed**: any bot comments that were reacted to with 👎 as not applicable
- **Large changes deferred**: any findings that were presented to the user instead of fixed autonomously
- **Human reviewer comments**: flag any remaining unresolved comments from human reviewers (not bots) that need manual attention

## Tool Reference

| Capability | Tool name (`server:tool`) | `call_tool_*` verb | Key `args` |
|---|---|---|---|
| Get PR stack | `gt-mcp:run_gt_cmd` | `call_tool_write` | `command: "gt state"` |
| Modify PR commit | `gt-mcp:run_gt_cmd` | `call_tool_write` | `command: "gt modify --message \"...\""` |
| Submit stack | `gt-mcp:run_gt_cmd` | `call_tool_write` | `command: "gt submit --no-interactive --stack"` |
| Get CI status | `github:pull_request_read` | `call_tool_read` | `method: "get_status"` |
| Get review comments | `github:pull_request_read` | `call_tool_read` | `method: "get_review_comments"` |
| Get failed CI logs | `github:get_job_logs` | `call_tool_read` | `failed_only: true` |
| Request Copilot review | `github:request_copilot_review` | `call_tool_write` | `owner, repo, pullNumber` |
| Reply to PR comment | `github:add_issue_comment` | `call_tool_write` | `owner, repo, issue_number, body` |
| Resolve review thread | bash `gh api graphql` | n/a (no MCP tool — `pull_request_review_write` does NOT support `resolve_thread`; see graphite-pitfalls C6) | `resolveReviewThread(input: {threadId: $threadId})` |
| React with 👎 | bash `gh api` | n/a (no MCP tool) | `repos/{o}/{r}/pulls/comments/{id}/reactions -f content="-1"` |

## Notes

- **Bottom-up processing is critical.** Fixes on lower PRs propagate to upper ones via `gt modify`'s automatic restack. Starting from the top would cause cascading conflicts.
- **`gt modify` automatically restacks.** Unlike `git commit --amend` which requires a separate `gt restack`, `gt modify` amends the commit AND restacks all upstack branches in one operation.
- **The "PR Review Bot Comments Addressed" check is the gate for binks.** Use this status to determine if binks is still reviewing (pending/in_progress) or has completed (success/failure). Don't process bot comments while binks is still reviewing — new comments may appear.
- **Ignore `Graphite Mergeability Check` while driving the stack green.** It depends on every other check being green plus all CODEOWNERS approvals, so it will not become green during the autonomous CI/bot-comment loop. Report it only if it remains the sole blocker after everything else is ready for human approval.
- **Copilot reviews are requested upfront** but processed like any other bot comment. Copilot's comments appear as review comments from `copilot[bot]` and follow the same address/resolve workflow.
- **The peer review pattern** (Agent 1 implements, Agent 2 reviews) applies to every code change, both CI fixes and bot comment fixes. This prevents scope creep and catches side effects.
- **Reactions (👎) require the `gh` CLI** because the GitHub MCP server does not expose a reactions tool. Use `gh api repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions -f content="-1"` via bash.
- **Human reviewer comments are NOT addressed** by this command. They are flagged in the final report for manual attention.
