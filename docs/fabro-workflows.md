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

The packages are `dependabot`, `dispatch`, `failure-triage`, `kiro-impl`,
`kiro-spec`, `kiro-task`, and `oneshot`.

## Local checks

```sh
nix develop
for workflow in .fabro/workflows/*/workflow.fabro; do
  fabro validate "$workflow"
done
```

`fabro validate` parses the graph and TOML offline. Warnings about
`[run.integrations]`, `[run.run_branch]`, and `[run.pull_request]` being
ignored are expected: those settings only take effect when the package runs on
the Fabro server.

`nix flake check` also runs `fabro-workflows-validate` on `aarch64-darwin` and
`aarch64-linux` — the systems with a pinned upstream Fabro release artifact in
`overlays/fabro.nix`. The check is absent on `x86_64-darwin` because upstream
ships no artifact for it. On the `aarch64-linux` fabro VM guest, `nix develop`
supplies both `prek` and the pinned `fabro` CLI.

## Pinning workflow versions

The dispatcher reads immutable workflow version ids from server-owned
variables instead of re-emitting package contents through an agent.

After changing `kiro-spec`, `kiro-impl`, `kiro-task`, `oneshot`, or
`dependabot`, run:

```sh
scripts/pin-workflow-versions.sh
```

The script requires `fabro` and `jq` on `PATH`. Registration is
content-addressed, so unchanged packages keep the same id. Changes to the
dispatcher packages themselves take effect when the automation next loads them
from `DWSR/nix-config@main`.

The pinned variables are allowlisted for the API bridge in
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
