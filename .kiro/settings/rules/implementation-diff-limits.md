# Implementation Diff Limits

## Scope

- Apply these rules when implementing or reviewing a Kiro task.
- Count textual additions plus deletions against the pre-task worktree
  baseline.

## Limits

- Prefer a diff of at most 500 changed lines.
- A diff must not exceed 1000 changed lines without a manual human exception.

## Complexity reduction

- When a diff exceeds 1000 changed lines, reject the current implementation
  and have the implementer redo it with a simpler approach.
- Preserve all acceptance criteria, required tests, and required generated
  artifacts while simplifying. Do not meet the limit by dropping required
  work.
- Recount the diff after the simplified implementation.
- If the diff still cannot be reduced to 1000 changed lines or fewer, stop and
  prompt the human to approve an explicit exception. Do not proceed to review,
  approval, or commit without that decision.
