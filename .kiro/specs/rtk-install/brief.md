# Brief: rtk-install

## Problem

The operator wants to reduce OpenCode cost from Bash-heavy tool output without
waiting for a broader native-tool compressor. The existing diagnostic shows Bash
as a high emitter, but prior discovery deferred RTK because it only intercepts
OpenCode's Bash tool and does not touch native Read, Grep, Glob, WebFetch, Task,
or LSP output.

## Current State

The repo has an evidence-first cost roadmap anchored by
`opencode-cost-diagnosis`. RTK is listed as a marginal deferred item, and the
Shopify OpenCode provider usage tag currently records `rtk:disabled`.

OpenCode configuration is managed declaratively through Home Manager modules.
The common OpenCode module owns package wrapping, shared settings, plugins, and
subagent wiring; host modules add Shopify and personal settings. There is no
RTK package, Home Manager option, or declarative OpenCode plugin in the repo.

## Desired Outcome

Both nix-darwin hosts install RTK and wire its OpenCode integration through the
repo's declarative Nix configuration. OpenCode Bash tool calls are routed
through RTK when the integration is enabled, with an explicit opt-out path and a
before/after diagnostic measurement path.

## Approach

Use a declarative integration rather than running `rtk init -g --opencode`.
Package RTK from the `rtk-ai/rtk` upstream tag or revision, install it through
Home Manager, and manage the OpenCode plugin/config as repo-owned files. Ensure
the OpenCode runtime can find the RTK binary, disable or explicitly control RTK
telemetry, and update usage tagging from `rtk:disabled` only when the plugin is
actually enabled.

## Scope

- **In**:
  - Nix package or overlay for RTK from `rtk-ai/rtk`, not the crates.io `rtk`
    name collision.
  - Home Manager wiring that enables RTK for both Shopify and personal hosts.
  - Declarative OpenCode plugin/config install for RTK's Bash-tool interception.
  - Runtime PATH/env wiring required for the plugin to invoke RTK.
  - Telemetry-off or telemetry-explicit posture suitable for both hosts.
  - Reversible enable/disable path and before/after validation with the
    existing OpenCode cost diagnostic.
- **Out**:
  - Compression for native OpenCode tools such as Read, Grep, Glob, WebFetch,
    Task, and LSP output.
  - Replacing the planned `tool-output-compressor` workstream.
  - Changing AGENTS.md tool-use policy to favor Bash just so RTK sees more
    traffic.
  - Imperative global config mutation via `rtk init -g --opencode`.
  - Hosted dashboards, remote analytics, or nonlocal cost attribution.

## Boundary Candidates

- **RTK package boundary**: build and expose the correct upstream RTK binary in
  Nix without relying on crates.io name resolution.
- **OpenCode integration boundary**: install the plugin/config declaratively and
  keep it scoped to Bash-tool interception.
- **Measurement and rollback boundary**: compare diagnostic reports before and
  after enabling RTK, and preserve a clear disable path.

## Out of Boundary

- Native-tool output compression belongs to a future `tool-output-compressor`
  spec.
- Prompt caching, session compaction, subagent prompt slimming, and MCP
  schema-surface reduction remain separate roadmap items.
- This spec does not assert RTK is the primary cost-reduction strategy; it is a
  bounded Bash-subset intervention.

## Upstream / Downstream

- **Upstream**: `opencode-cost-diagnosis` provides baseline and success
  measurement; `home-manager/common/opencode.nix` provides the shared OpenCode
  wrapper/settings pattern; host OpenCode modules define Shopify and personal
  overrides.
- **Downstream**: `tool-output-compressor` can absorb or supersede this work if
  native-tool output remains the dominant cost source after RTK is measured.

## Existing Spec Touchpoints

- **Extends**: The deferred `rtk-install` item in `.kiro/steering/roadmap.md` is
  promoted into an active spec candidate.
- **Adjacent**: `opencode-cost-diagnosis` remains read-only and is not reopened;
  `session-compaction`, `subagent-context-budget`, and `tool-output-compressor`
  remain separate cost-reduction boundaries.

## Constraints

- RTK only intercepts Bash/shell tool calls in OpenCode.
- The integration must work on both nix-darwin hosts without an imperative
  post-install step or runtime network fetch.
- The package source must be pinned by tag or revision and hash.
- OpenCode config and plugin changes require restarting OpenCode to take effect.
- Any telemetry behavior must be explicit and safe for Shopify use.
