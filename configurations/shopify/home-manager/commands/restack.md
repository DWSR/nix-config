---
description: Restack Graphite PR stack and resolve conflicts
---

Restack the current Graphite PR stack, automatically resolving any merge conflicts, then submit.

## Instructions

### Step 1: Restack the stack

Use the `hub_gt_mcp__run_gt_cmd` tool to run `gt restack`.

### Step 2: Handle merge conflicts

If the restack indicates merge conflicts:

1. Identify conflicting files by running `git diff --name-only --diff-filter=U`.
2. For each conflicting file:
   - Read the file to see the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
   - Resolve the conflict by editing the file, choosing the correct resolution based on the intent of both changes
   - Stage the resolved file with `git add <file>`
3. Use the `hub_gt_mcp__run_gt_cmd` tool to run `gt continue` to resume the restack.
4. Repeat steps 1-3 if further conflicts arise on subsequent branches in the stack.

### Step 3: Submit the stack

Once the restack completes successfully, use the `hub_gt_mcp__run_gt_cmd` tool to run `gt submit --no-interactive` to push all branches and update PRs.
