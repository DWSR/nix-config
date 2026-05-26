---
description: Restack Graphite PR stack and resolve conflicts
---

Restack the current Graphite PR stack, automatically resolving any merge conflicts, then submit.

## Tool invocation idiom

All `gt` operations go through mcpproxy's four-tool agent surface
(`retrieve_tools` + `call_tool_*`). Discover the gt run-command tool
once with `retrieve_tools(query: "gt run gt command")` — the result's
`name` will be `gt-mcp:run_gt_cmd` and its `call_with` will be
`call_tool_write` (every `gt` subcommand mutates VCS state). Invoke
with upstream args shaped like
`{ args: ["<subcommand>", "<flag>"], cwd: "/abs/repo", why: "reason" }`.
Pass parameters in the `args` field (a JSON object), not the legacy
`arguments` field.

## Instructions

### Step 1: Restack the stack

Invoke the `gt-mcp:run_gt_cmd` tool (via `call_tool_write`) with the
upstream args `{ args: ["restack"], cwd: "/abs/repo", why: "restack the current Graphite stack" }`.

### Step 2: Handle merge conflicts

If the restack indicates merge conflicts:

1. Identify conflicting files by running `git diff --name-only --diff-filter=U`.
2. For each conflicting file:
   - Read the file to see the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
   - Resolve the conflict by editing the file, choosing the correct resolution based on the intent of both changes
   - Stage the resolved file with `git add <file>`
3. Invoke the `gt-mcp:run_gt_cmd` tool (via `call_tool_write`) with the
   upstream args `{ args: ["continue"], cwd: "/abs/repo", why: "continue the Graphite restack after conflict resolution" }` to resume the restack.
4. Repeat steps 1-3 if further conflicts arise on subsequent branches in the stack.

### Step 3: Submit the stack

Once the restack completes successfully, invoke the `gt-mcp:run_gt_cmd`
tool (via `call_tool_write`) with upstream args `{ args: ["submit", "--no-interactive"], cwd: "/abs/repo", why: "submit the restacked PRs" }`
to push all branches and update PRs.
