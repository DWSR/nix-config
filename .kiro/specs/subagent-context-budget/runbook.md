# Subagent Context Budget Runbook

Use this workflow to capture the baseline, enable budgets, smoke-test the
budgeted agents, validate cost reduction, and roll back without opening
`design.md`.

## Inputs / paths

- Metadata path:
  `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/subagent-context-budget/metadata.json`
- Minimal baseline artifact:
  `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/subagent-context-budget/minimal-readonly-baseline.json`
- Smoke catalog: run `subagent-context-budget smoke-plan --metadata "$METADATA"`
  to render the operator-facing catalog from the installed metadata and
  bundled smoke definitions.
- Plugin self-check: the smoke wrapper reads
  `SUBAGENT_CONTEXT_BUDGET_SMOKE_PLUGIN_SELF_CHECK` when set. For live
  startup verification, inspect the opencode app logs for the plugin
  startup self-check result and apply/skip counters.

Set these variables before running the commands below:

```sh
HOST="${HOST:?set target nix-darwin host flake name}"
METADATA="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/subagent-context-budget/metadata.json"
BASELINE_REPORT="${PWD}/subagent-context-budget-baseline.json"
POST_REPORT="${PWD}/subagent-context-budget-post.json"
```

## Migration phases

1. Phase 1: render metadata and run audit without enforcing instruction filtering.
2. Phase 2: enforce permission budgets and run smoke tests.
3. Phase 3: enable runtime instruction filtering and confirm plugin self-check.
4. Phase 4: capture the post-change report and validate the reduction.

## Baseline capture

Capture the diagnostic before budget enforcement:

```sh
opencode-cost-report --format json > "$BASELINE_REPORT"
subagent-context-budget audit --metadata "$METADATA" --diagnostic "$BASELINE_REPORT"
```

Keep the baseline JSON with the change record. Validation depends on a
report captured before enforcement.

Confirm the audit output includes:

- every configured common and host-specific agent;
- first-turn and observed-tool data when the diagnostic provides it;
- the minimal read-only baseline path or delta information;
- any `unbudgeted` agents already using an escape hatch.

## Enable budgets

Set enforcement in the Home Manager or nix-darwin configuration:

```nix
programs.subagent-context-budget.enforce = true;
```

For one agent escape hatch, leave global enforcement on and disable that
agent only:

```nix
programs.subagent-context-budget.agents.general.disableBudget = true;
```

Apply the nix-darwin host configuration:

```sh
darwin-rebuild switch --flake ".#$HOST"
```

## Smoke preflight

Run the installed smoke wrapper and inspect the smoke plan:

```sh
subagent-context-budget-smoke-test
subagent-context-budget smoke-plan --metadata "$METADATA"
```

`skipped-unbudgeted` means the agent is intentionally excluded by the
operator escape hatch. Treat `fail` or a missing enforced agent as a
budgeting failure before moving to post-change capture.

Check runtime instruction filtering before validation:

- In wrapper-driven smoke, set or inspect
  `SUBAGENT_CONTEXT_BUDGET_SMOKE_PLUGIN_SELF_CHECK` when testing the
  plugin self-check JSON path.
- In normal opencode runs, inspect app logs for startup self-check status.
  A failed self-check blocks validation success.

## Post-change capture

Run a representative workload comparable to the baseline workload. Then
capture the post-change diagnostic:

```sh
opencode-cost-report --format json > "$POST_REPORT"
```

Do not compare unrelated workloads. If the workload changed, capture a new
baseline before claiming reduction.

## Validation

Compare baseline and post-change reports:

```sh
subagent-context-budget validate --metadata "$METADATA" --baseline "$BASELINE_REPORT" --post "$POST_REPORT"
```

Expected result: exit code `0` and at least 40% reduction in
`subagentDispatch` tokens per parent session. A non-zero exit is a
validation failure; inspect the machine-readable failures for missing
diagnostic fields, threshold failure, smoke failure, or plugin self-check
failure.

## Residual interpretation

Residual buckets are reported separately and are not credited to named-agent
reductions. Named-agent success only comes from agents present in the
per-agent diagnostic map.

Residual-heavy output means attribution is incomplete. Rerun the workload
with better diagnostics or a more representative capture before claiming
agent-level success.

## Rollback / escape hatch

Prefer the narrowest rollback that restores the blocked workflow.

Per-agent escape hatch:

```nix
programs.subagent-context-budget.agents.general.disableBudget = true;
```

Global rollback:

```nix
programs.subagent-context-budget.enforce = false;
```

If the module itself must be removed, disable it through the host's module
configuration after preserving the baseline and post-change reports.

Rollback command sequence:

```sh
darwin-rebuild switch --flake ".#$HOST"
subagent-context-budget-smoke-test
subagent-context-budget audit --metadata "$METADATA" --diagnostic "$BASELINE_REPORT"
subagent-context-budget smoke-plan --metadata "$METADATA"
subagent-context-budget validate --metadata "$METADATA" --baseline "$BASELINE_REPORT" --post "$POST_REPORT"
```

After per-agent rollback, audit and smoke-plan should show that agent as
`unbudgeted` / `skipped-unbudgeted`. After global rollback, enforcement
should be off and validation should no longer be used as the success claim
for the budgeted rollout.

## Operator checklist

- Baseline report captured before enforcement.
- Audit output reviewed for all host agents and minimal baseline data.
- `programs.subagent-context-budget.enforce = true` applied, except any
  explicit `disableBudget = true` escape hatches.
- `darwin-rebuild switch --flake ".#$HOST"` applied on the target host.
- `subagent-context-budget-smoke-test` passes for enforced agents.
- `subagent-context-budget smoke-plan --metadata "$METADATA"` explains
  any `skipped-unbudgeted` agents.
- Plugin startup self-check is present and passing in the selected source.
- Post-change report captured from a comparable workload.
- `subagent-context-budget validate` exits `0` with at least 40% reduction.
- Residual-heavy output is treated as incomplete attribution, not
  named-agent proof.
