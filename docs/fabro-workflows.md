# Fabro workflows

The Fabro workflow packages that used to live in `DWSR/fabro` are maintained
here alongside the Nix configuration that builds the Fabro host. The Fabro CLI
itself is pinned by `overlays/fabro.nix`.

## Layout

- `.fabro/workflows/<name>/workflow.fabro` — the workflow graph.
- `.fabro/workflows/<name>/workflow.toml` — run inputs, agent settings,
  integrations, and branch/PR behavior.
- `.fabro/workflows/<name>/prompts/*.md` — node prompts.
- `scripts/pin-workflow-versions.sh` — registers content-addressed workflow
  versions in the Fabro server and pins their ids as server variables.

The packages are `dependabot`, `dispatch`, `failure-triage`, `kiro-feedback`,
`kiro-impl`, `kiro-spec`, `kiro-task`, `oneshot`, and `security-remediation`.

A repeated `kiro-impl` invocation resumes an existing spec stack. After it
publishes the stack, it dispatches one `kiro-feedback` child per layer from the
bottom of the stack to the top. Each child rebases its layer onto the branch
below it, fixes unresolved review threads and failing checks, force-pushes the
layer, and only finishes after that layer's CI is green. CI-driven fix rounds
are bounded, so a layer that cannot go green fails the run instead of looping.

## Local checks

```sh
nix develop
for workflow in .fabro/workflows/*/workflow.fabro; do
  fabro validate "$workflow"
done
```

`fabro validate` parses the graph and TOML offline. The pinned Fabro CLI emits
the following informational warnings for the packages here, so seeing them is
expected and never means the graph is broken:

- `ignored.workflow_toml.run.integrations`,
  `ignored.workflow_toml.run.run_branch`, and
  `ignored.workflow_toml.run.pull_request`: those settings only take effect
  when the package runs on the Fabro server.
- `attractor.goal_gate_without_target`: these packages declare goal gates
  without a retry target on purpose, so a failing gate ends the run as failed
  instead of retrying.
- `attractor.unbound_input`: `{{ vars.* }}` reads server-owned variables, and
  offline validation cannot reach the server's variable store.
- `info.budget.default`: the looping packages have nodes without `max_visits`;
  those loops are bounded by per-stage `max_visits` and graph conditions
  instead.

A package is clean when `fabro validate` reports no errors and prints
`Validation: OK`; that is the bar the loop above and `nix flake check` apply.
Which of these warnings a package emits depends only on the graph and TOML
features it uses, not on a particular revision, so do not add no-op attributes
to silence them. `fabro validate --json` lists the diagnostics with their rule
names.

`nix flake check` also runs `fabro-workflows-validate` on `aarch64-darwin` and
`aarch64-linux` — the systems with a pinned upstream Fabro release artifact in
`overlays/fabro.nix`. The check is absent on `x86_64-darwin` because upstream
ships no artifact for it. On the `aarch64-linux` fabro VM guest, `nix develop`
supplies both `prek` and the pinned `fabro` CLI.

## Pinning workflow versions

The dispatcher reads immutable workflow version ids from server-owned
variables instead of re-emitting package contents through an agent.

After changing `kiro-spec`, `kiro-impl`, `kiro-task`, `kiro-feedback`, `oneshot`,
`dependabot`, or `security-remediation`, run:

```sh
scripts/pin-workflow-versions.sh
```

The script requires `fabro` and `jq` on `PATH`. Registration is
content-addressed, so unchanged packages keep the same id. Changes to the
dispatcher packages themselves take effect when the automation next loads them
from `DWSR/nix-config@main`.

The pinned variables `kiro_spec_workflow_version`,
`kiro_task_workflow_version`, `kiro_feedback_workflow_version`,
`oneshot_workflow_version`, `dependabot_workflow_version`, and
`security_remediation_workflow_version` are allowlisted for the API bridge in
`configurations/fabro-vm/default.nix`. Add any new dispatch target there before
deploying the guest, or the bridge rejects child creation with HTTP 403.

## Automations

Automations are stored in the Fabro server database and managed through
`GET`/`POST /api/v1/automations`; there is no CLI subcommand. The scheduled
workflows load their package from `DWSR/nix-config@main`, so a workflow change
must be pushed to `main` before the next trigger uses it.

When changing repository topology, retarget the automation's `workflow_source`
and `target.repo` before removing the old repository. A manual dispatch run
uses the current directory as its default target and refuses to create children
whose target repository does not match the caller.
