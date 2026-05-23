# Requirements Document

## Introduction

`rtk-install` adds RTK as a bounded OpenCode cost-reduction intervention for
the Bash-tool subset on both nix-darwin hosts. It is measured by the existing
`opencode-cost-diagnosis` workflow and does not replace native tool-output
compression work.

## Boundary Context

- **In scope**:
  - RTK availability for both Shopify and personal OpenCode configurations.
  - Declarative install and OpenCode integration with no imperative bootstrap.
  - Bash/shell tool-call routing through RTK when the feature is enabled.
  - Explicit telemetry posture, opt-out, rollback, and before/after
    measurement expectations.
- **Out of scope**:
  - Compression for native OpenCode Read, Grep, Glob, WebFetch, Task, or LSP
    tool output.
  - Changing agent instructions to favor Bash usage.
  - Prompt caching, session compaction, subagent prompt budgeting, MCP
    migration, hosted dashboards, or remote analytics.
- **Adjacent expectations**:
  - `opencode-cost-diagnosis` remains the before/after measurement tool.
  - A future `tool-output-compressor` may address native tool output and may
    supersede RTK if Bash-only savings are insufficient.
  - OpenCode must be restarted after configuration or plugin changes before the
    operator expects RTK behavior to change.

## Requirements

### Requirement 1: Host availability and declarative activation

**Objective:** As the operator, I want RTK installed and activated through the
same declarative host workflow as the rest of OpenCode, so that both target
hosts behave consistently without manual bootstrap steps.

#### Acceptance Criteria

1. The RTK OpenCode Integration shall install RTK and its OpenCode integration
   for both the Shopify and personal nix-darwin hosts through the repository's
   declarative configuration.
2. When the operator applies the standard host rebuild on either target host,
   the RTK OpenCode Integration shall make RTK available to OpenCode without a
   separate bootstrap command.
3. If the RTK OpenCode Integration is enabled while OpenCode is not enabled,
   the RTK OpenCode Integration shall fail configuration evaluation with an
   actionable message that names the missing dependency.
4. The RTK OpenCode Integration shall not require runtime network access to
   install, update, or activate RTK after the host configuration has been
   built.
5. The RTK OpenCode Integration shall expose the same operator-facing
   enablement behavior on both target hosts.

### Requirement 2: Bash-tool routing scope

**Objective:** As the operator, I want RTK to affect only OpenCode Bash/shell
tool calls, so that the feature's behavior matches RTK's actual integration
surface and does not obscure unrelated tool output.

#### Acceptance Criteria

1. While RTK is enabled for OpenCode, when OpenCode executes a Bash or shell
   tool call, the RTK OpenCode Integration shall route that tool call through
   RTK before returning the tool result to OpenCode.
2. When a routed Bash or shell command completes, the RTK OpenCode Integration
   shall return a result that preserves whether the underlying command
   succeeded or failed.
3. If RTK cannot process a Bash or shell tool call, the RTK OpenCode
   Integration shall surface that RTK did not process the call instead of
   silently reporting RTK processing as active.
4. When OpenCode uses native Read, Grep, Glob, WebFetch, Task, or LSP tools,
   the RTK OpenCode Integration shall leave those tool results outside RTK
   processing.
5. The RTK OpenCode Integration shall not change project agent instructions to
   increase Bash usage for the purpose of increasing RTK coverage.

### Requirement 3: Operator control and rollback

**Objective:** As the operator, I want a visible enablement state and a clear
disable path, so that I can compare RTK behavior, roll it back, or leave it off
on one host without disrupting OpenCode.

#### Acceptance Criteria

1. The RTK OpenCode Integration shall provide an operator-visible state that
   distinguishes enabled and disabled modes.
2. When the RTK OpenCode Integration is disabled, OpenCode shall run without RTK
   Bash-tool routing.
3. When the operator changes the RTK enablement state and restarts OpenCode
   after applying host configuration, OpenCode shall reflect the new RTK state.
4. Where host-specific overrides are configured, the RTK OpenCode Integration
   shall allow one target host to disable RTK without requiring the other target
   host to disable RTK.
5. Where a per-session override is configured for an OpenCode launch, the RTK
   OpenCode Integration shall honor that override without requiring a host
   rebuild.
6. When a per-session override disables RTK, OpenCode shall run without RTK
   Bash-tool routing for that launch.
7. When a per-session override enables RTK on a host where the feature is
   available, OpenCode shall run with RTK Bash-tool routing for that launch.
8. The RTK OpenCode Integration shall document the operator action required for
   RTK configuration changes to take effect in OpenCode sessions.

### Requirement 4: RTK source provenance

**Objective:** As the operator, I want the installed RTK binary to come from the
intended upstream project, so that the integration does not accidentally install
an unrelated package with the same name.

#### Acceptance Criteria

1. The RTK OpenCode Integration shall source RTK from the `rtk-ai/rtk` upstream
   project rather than a package name that resolves to a different project.
2. The RTK OpenCode Integration shall record a reproducible RTK source identity
   and integrity check in repository-managed configuration.
3. If the configured RTK source cannot be fetched or verified, the RTK OpenCode
   Integration shall fail before producing an enabled OpenCode integration.
4. The RTK OpenCode Integration shall expose the installed RTK version or source
   identity to the operator.

### Requirement 5: Telemetry and local data posture

**Objective:** As the operator, I want RTK to run with an explicit local-first
data posture, so that command contents, command output, session metadata, and
cost data are not sent to external services unexpectedly.

#### Acceptance Criteria

1. The RTK OpenCode Integration shall default to a telemetry posture that does
   not send command contents, command output, session metadata, or cost data to
   RTK-controlled remote services.
2. Where RTK provides telemetry controls, the RTK OpenCode Integration shall set
   those controls explicitly rather than relying on upstream defaults.
3. If the RTK telemetry posture cannot be made explicit, the RTK OpenCode
   Integration shall prevent RTK from being reported as enabled for OpenCode.
4. The RTK OpenCode Integration shall keep any feature-generated logs or state
   local to the host unless the operator configures external sync outside this
   feature.

### Requirement 6: Measurement and attribution

**Objective:** As the operator, I want RTK-enabled sessions to remain measurable
with the existing diagnostic workflow, so that I can decide whether Bash-only
savings justify keeping RTK enabled.

#### Acceptance Criteria

1. The RTK OpenCode Integration shall preserve compatibility with the existing
   OpenCode cost diagnostic on both target hosts.
2. When RTK is enabled, the RTK OpenCode Integration shall make the RTK state of
   new OpenCode sessions distinguishable from the disabled state.
3. Where provider usage tags are configured for OpenCode sessions, the RTK
   OpenCode Integration shall report an RTK state that matches the active
   feature state.
4. Where the Shopify OpenCode configuration is active and RTK is enabled for a
   session, the RTK OpenCode Integration shall include the `rtk:enabled` usage
   tag for that session.
5. Where the Shopify OpenCode configuration is active and RTK is disabled for a
   session, the RTK OpenCode Integration shall include the `rtk:disabled` usage
   tag for that session.
6. When a per-session RTK override changes the active RTK state for a Shopify
   OpenCode launch, the RTK OpenCode Integration shall make the Shopify usage
   tag match the override-selected state.
7. The RTK OpenCode Integration shall not mutate historical OpenCode session
   data when it is enabled, disabled, or removed.
8. When a session contains no Bash or shell tool calls, the RTK OpenCode
   Integration shall not report that RTK processed that session's tool output.

### Requirement 7: Compatibility and failure visibility

**Objective:** As the operator, I want RTK failures and incompatibilities to be
visible, so that OpenCode does not silently run in an unexpected compression
state.

#### Acceptance Criteria

1. If RTK is configured as enabled but is unavailable to OpenCode, the RTK
   OpenCode Integration shall surface an actionable failure that names RTK.
2. If the OpenCode integration surface required by RTK is unavailable, the RTK
   OpenCode Integration shall surface an actionable failure instead of silently
   disabling RTK.
3. When an RTK-routed command fails, the RTK OpenCode Integration shall preserve
   enough failure information for the operator to identify that the underlying
   command failed.
4. The RTK OpenCode Integration shall not disable or replace existing OpenCode
   cost-diagnosis, session-compaction, subagent-context-budget, or mcpproxy
   behavior.
5. When RTK is removed or disabled, the RTK OpenCode Integration shall leave
   OpenCode usable without requiring cleanup outside repository-managed
   configuration.
