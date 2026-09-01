---
description: Drive a standalone Shopify PR or GitHub-native PR Stack to actionable green
agent: stack-captain
subtask: true
---

# Make Stack Green

Drive the current standalone Shopify PR or GitHub-native PR Stack to actionable
green by spawning `stack-captain` as the task agent. Treat a PR without native
Stack membership as a one-PR Stack and run the same gates.

Use the full `stack-captain` workflow: map the target, fan out read-only helper
subagents, diagnose CI and review-thread failures, apply targeted mutation
waves bottom-up, publish through the path appropriate to a native or singleton
Stack, block on required Binks output in the final gate, and report final
actionable status only after Binks passes or is explicitly overridden.

User arguments: $ARGUMENTS
