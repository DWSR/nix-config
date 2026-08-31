---
description: Prepare a GitHub-native Stack rebase, conflict-resolution, and push handoff
---

# Rebase Native Stack

Prepare the current GitHub-native PR Stack for a cascade rebase and push.

Load `github-native-stacks` first. Map the remote Stack with GitHub MCP and use
Git-MCP only for safe local inspection or explicit conflict-file staging. Never
execute `gh stack`, loop ordinary Git rebases or pushes, or mutate PR bases to
imitate a Stack operation.

## Instructions

1. Resolve owner, repo, and the current PR with Git-MCP and GitHub MCP reads.
2. Use `pull_request_stack_read` with `method: "list"` and `pullNumber`, then
   `method: "get"`, to show the Stack number and bottom-to-top member order.
3. Inspect local status and worktrees through Git-MCP with the explicit
   absolute repository path.
4. If local Stack tracking or member branches are missing, provide and stop at:

   ```bash
   gh stack checkout <stack-number>
   ```

5. Otherwise provide the rebase command matching the requested scope:

   ```bash
   gh stack rebase --remote <remote>
   gh stack rebase --upstack --remote <remote>
   gh stack rebase --downstack --remote <remote>
   ```

6. Explain that the user must run the command. Do not select `--upstack` or
   `--downstack` without a current member and explicit scope.
7. If the user returns with conflicts, inspect and resolve the named files,
   stage only those paths through Git-MCP, then provide one command:

   ```bash
   gh stack rebase --continue
   gh stack rebase --abort
   ```

8. After the user confirms a successful rebase, re-read local and remote state,
   then provide:

   ```bash
   gh stack push --remote <remote>
   ```

9. Explain that push uses per-branch force-with-lease and is not atomic. After
   the user confirms completion, re-read the remote Stack and every member PR
   before reporting success.
