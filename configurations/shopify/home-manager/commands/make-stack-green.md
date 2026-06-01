---
description: Drive a Shopify Graphite PR stack to actionable green
agent: stack-captain
subtask: true
---

# Make Stack Green

Drive the current Shopify Graphite PR stack to actionable green by spawning
`stack-captain` as the task agent.

Use the full `stack-captain` workflow: map the stack, fan out read-only helper
subagents, diagnose CI and review-thread failures, apply targeted mutation
waves bottom-up, submit through Graphite, block on required Binks output in the
final gate, and report final actionable status only after Binks passes or is
explicitly overridden.

User arguments: $ARGUMENTS
