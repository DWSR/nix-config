---
description: Validate the YugabyteDB backlog and upload referenced evidence before review
agent: yb-backlog-validator
subtask: true
---

# Validate YugabyteDB Backlog

Run the `yb-backlog-validator` workflow against the
`yugabyte-gh-issue-backlog-review` Quick site.

With no arguments, continue in waves of four until the active unreviewed queue
is empty or only issues blocked during this invocation remain. Completed Quick
reviews are the durable checkpoint, so re-running this command resumes where
the prior run stopped.

A review is complete only after its analysis artifact and every local evidence
file referenced by the persisted review fields have been uploaded to that
issue and verified in Quick. The controller performs those uploads before it
marks the issue reviewed.

When issue numbers or URLs are supplied, validate only those issues, still in
waves of at most four. This targeted mode is intended for retrying blocked
items.

The normal permissive nono audit profile is supported after a Podman preflight.
If the controller reports an enforced or incompatible sandbox, relaunch with
`OPENCODE_NONO=disabled opencode` and invoke the command again.

User arguments: $ARGUMENTS
