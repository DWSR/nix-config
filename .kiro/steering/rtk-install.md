# rtk-install operator guide

Operator-facing steering for the `programs.opencode-rtk` home-manager
feature. The feature packages RTK from `rtk-ai/rtk`, installs a
repo-owned OpenCode plugin that rewrites Bash and shell tool
commands through `rtk rewrite`, and exports a wrapper-resolved
effective-state contract that both the plugin and the Shopify
provider header consume.

Cross-references in this doc point at
`.kiro/specs/rtk-install/requirements.md` (requirements 1–7) and
`.kiro/specs/rtk-install/design.md` (Components / State Resolver,
RTK Plugin, Shopify Integration; System Flows; Testing Strategy).

## Boundary

RTK only touches OpenCode Bash and shell tool calls. Native Read,
Grep, Glob, WebFetch, Task, and LSP tool output is not affected and
is not in scope for this feature. A future
`tool-output-compressor` spec owns native-tool output compression.

The plugin never executes the underlying command — it mutates only
`output.args.command` before OpenCode's Bash tool runs it, so exit
status and output stay owned by OpenCode (requirement 2.2,
design RTK Plugin contract).

## Restart behavior

OpenCode reads the wrapper environment once at process start. After
any host rebuild, plugin change, or change to
`programs.opencode-rtk.*`, restart OpenCode before expecting the
new behavior to take effect (requirement 3.3, design Migration
Strategy). Existing OpenCode processes keep the environment they
started with; no hot-reload path exists.

## Host default and per-launch override

The host default is the static state baked into the wrapper at
build time. It's controlled by:

```nix
programs.opencode-rtk.defaultEnabled = true;  # or false
```

For one launch without rebuilding, set `OPENCODE_RTK` before
invoking OpenCode:

| Value                                    | Effect                  |
|------------------------------------------|-------------------------|
| `1`, `true`, `enabled`                   | Force enabled this launch |
| `0`, `false`, `disabled`                 | Force disabled this launch |
| unset                                    | Inherit `defaultEnabled` |
| anything else                            | Wrapper aborts with stderr error before OpenCode starts |

The wrapper resolves both inputs into three exported envs that
flow to every downstream consumer:

| Env var                       | Value                          |
|-------------------------------|--------------------------------|
| `OPENCODE_RTK_EFFECTIVE`      | `enabled` or `disabled`        |
| `OPENCODE_RTK_USAGE_TAG`      | `rtk:enabled` or `rtk:disabled` |
| `OPENCODE_RTK_DISABLE_REASON` | one of the 5 reasons below, or empty |
| `RTK_TELEMETRY_DISABLED`      | always `1`                     |

The plugin reads `OPENCODE_RTK_EFFECTIVE`. The Shopify provider
header substitutes `{env:OPENCODE_RTK_USAGE_TAG}` into the
`Shopify-Usage-Tag` JSON array (design State Resolver, Shopify
Integration).

## Disable reasons

When `OPENCODE_RTK_EFFECTIVE=disabled`, `OPENCODE_RTK_DISABLE_REASON`
records why. Grep against these strings when triaging:

| Reason              | Source                                                        |
|---------------------|---------------------------------------------------------------|
| `host-default`      | `defaultEnabled = false` and no override.                     |
| `override`          | `OPENCODE_RTK=0` (or `false` / `disabled`) for this launch.   |
| `missing-binary`    | RTK requested but `rtk` is not on PATH at wrapper start.      |
| `invalid-override`  | `OPENCODE_RTK` is set to a non-matching value; wrapper exits non-zero before OpenCode starts. |
| `telemetry-unsafe`  | Reserved in the State Resolver contract for cases where `RTK_TELEMETRY_DISABLED=1` cannot be forced. Not produced by the current wrapper path; the plugin self-check enforces the same posture at startup. |

`missing-binary` is the common one to hit during a rollback in
progress: the module was disabled (or the rebuild hasn't switched
yet), so the `rtk` binary isn't on the wrapper PATH, but a stale
`OPENCODE_RTK=1` is still in the operator's shell env.

## How to inspect a session's effective state

Three sources, ordered from cheapest to most rigorous:

1. Read the wrapper-exported envs inside an OpenCode-spawned shell:
   `env | grep OPENCODE_RTK_` and `env | grep RTK_TELEMETRY_`.
2. Inspect plugin logs through OpenCode's app-log surface; the
   plugin uses `service = "rtk-opencode"` and emits a startup record
   naming the effective state and disable reason (design RTK Plugin
   event contract). Resolved log path:
   `~/.local/share/opencode/log/` (singular `log/`, same convention
   as session-compaction).
3. On Shopify hosts, look at the Shopify provider request headers
   for the active session: the `Shopify-Usage-Tag` JSON array
   contains `rtk:enabled` or `rtk:disabled` matching the wrapper
   export.

## Measurement workflow

Use `nix run .#rtk-opencode-validate -- <subcommand>` as the
canonical operator entry point. The script discovers the rendered
metadata + plugin under `XDG_CONFIG_HOME`, drives the smoke
verifier with the wrapper env contract, and brackets a Bash-heavy
OpenCode session with `opencode-cost-report` snapshots:

| Subcommand | Purpose |
|------------|---------|
| `smoke`    | Verify RTK binary, plugin file, metadata, telemetry env, and effective-state contract are live. Fails with named labels if the host isn't switched. |
| `baseline` | Run `opencode-cost-report --format json`, persist the report path + session-DB mtime/size under `$XDG_STATE_HOME/rtk-opencode-validate/`. |
| `compare`  | Re-run the cost report. Diff `.globalTotals.cost.toolOutputsByTool.bash` (cached + uncached) against the baseline. Re-snapshot the session DB and surface mtime/size drift. |

The full operator runbook for a fresh measurement cycle:

```
darwin-rebuild switch --flake .#<host>
# restart OpenCode
nix run .#rtk-opencode-validate -- smoke
nix run .#rtk-opencode-validate -- baseline
# run a Bash-heavy OpenCode session with RTK enabled (default)
nix run .#rtk-opencode-validate -- compare
```

Optional contrast pass: relaunch OpenCode with `OPENCODE_RTK=0`,
re-run the Bash-heavy session, and repeat `compare`. The delta
between the enabled and disabled runs is the operator-visible
Bash-only savings (requirement 6.8, design Testing Strategy).

### What the cost-report fields mean

Per-tool dollar attribution lives at
`.globalTotals.cost.toolOutputsByTool` and
`.byProject[*].cost.toolOutputsByTool` in the
`opencode-cost-report --format json` output. The validator reads
`globalTotals` so the diff aggregates across projects.

The per-session field
`.sessions[].cost.toolOutputsByTool` is a JS `Map` that
serializes empty (`scripts/opencode-cost-report.js:2581`); do
not key off it. Tool name keys are lowercase (`bash`, `edit`,
`read`, etc.).

## Rollback

Three rollback shapes, smallest first:

| Scope                        | Action |
|------------------------------|--------|
| One launch                   | `OPENCODE_RTK=0 opencode …` |
| Host default                 | Set `programs.opencode-rtk.defaultEnabled = false` and rebuild. |
| Full removal                 | Set `programs.opencode-rtk.enable = false` and rebuild. |

After any rebuild scope change, restart OpenCode. No external
cleanup is required; the module manages all installed files
through `xdg.configFile` and removes them when disabled
(requirement 7.5).

## Telemetry posture

RTK runs with `RTK_TELEMETRY_DISABLED=1` on every launch. The
package is built from `rtk-ai/rtk` source via `buildRustPackage`
rather than upstream release assets, so the compile-time telemetry
URL is never injected (design Security Considerations). The plugin
never writes the OpenCode session SQLite database, and feature
logs stay under `~/.local/share/opencode/log/` unless the operator
configures external sync outside this feature.

## Shopify usage tag

The Shopify provider header includes `rtk:enabled` or
`rtk:disabled` matching `OPENCODE_RTK_EFFECTIVE`. The static
`rtk:disabled` literal previously hard-coded in
`configurations/shopify/home-manager/opencode.nix` was replaced by
`config.programs.opencode-rtk.usageTag`, which renders as
`{env:OPENCODE_RTK_USAGE_TAG}` and resolves at provider request
time. A per-launch override flips the usage tag together with the
plugin behavior, so attribution and routing never disagree
(requirement 6.6, design State Resolver).

## See also

- `.kiro/specs/rtk-install/requirements.md` — full requirements,
  especially 1.1–1.5 (declarative install), 2.1–2.5 (Bash-only
  scope), 3.1–3.8 (operator control), 5.1–5.4 (telemetry posture),
  6.1–6.8 (measurement and attribution), 7.1–7.5 (failure
  visibility and removal).
- `.kiro/specs/rtk-install/design.md` — Components and Interfaces
  (State Resolver, RTK Plugin, Shopify Integration), System Flows,
  Testing Strategy, Security Considerations.
- `home-manager/common/opencode-rtk.nix` — module options, wrapper
  resolver, plugin install, metadata render, peer assertion.
- `home-manager/common/opencode-plugins/rtk.ts` — plugin entry,
  self-check, Bash/shell rewrite path, structured logs.
- `scripts/rtk-opencode-smoke-test.nix` — runtime verifier the
  validator script invokes for the smoke subcommand.
- `scripts/rtk-opencode-validate.nix` — `nix run .#rtk-opencode-validate`
  entry point for the Phase B measurement cycle.
- `opencode-cost-report` — diagnostic CLI for per-tool dollar
  attribution; from the prior `opencode-cost-diagnosis` spec.
