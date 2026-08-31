---
description: Drive a Shopify GitHub-native PR Stack to actionable green
agent: stack-captain
subtask: true
---

# Make Stack Green

Drive the current Shopify GitHub-native PR Stack to actionable green by spawning
`stack-captain` as the task agent.

Use the full `stack-captain` workflow: map the stack, fan out read-only helper
subagents, diagnose CI and review-thread failures, apply targeted mutation
waves bottom-up, pause for exact user-owned `gh stack` rebase/push handoffs,
block on required Binks output in the final gate, and report final actionable
status only after Binks passes or is explicitly overridden.

User arguments: $ARGUMENTS
