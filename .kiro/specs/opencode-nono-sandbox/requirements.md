# Requirements Document

## Introduction
`opencode-nono-sandbox` adds a declarative nono safety layer around OpenCode:
it launches OpenCode under a repo-managed nono profile, controls rollout state,
and keeps credential/network posture explicit. The historical usage audit,
compatibility assessment, and tool-use replacement review moved to the sibling
spec `opencode-nono-audit`. See `brief.md` for problem, approach, and scope.

## Boundary Context
- **In scope**: OpenCode launch sandboxing under nono, repo-managed nono
  profiles, profile validation, rollout state controls + per-launch overrides,
  declarative credential/environment/network posture, coexistence with existing
  OpenCode integrations, personal/Shopify host defaults, and nono package
  provisioning (latest upstream-published version with a repository-overlay
  fallback).
- **Out of scope**: historical OpenCode usage audit, profile compatibility
  assessment, and common tool-use MCP-replacement review (owned by
  `opencode-nono-audit`); nono upstream changes; OpenCode permission redesign;
  MCP quarantine redesign; provider routing changes; cavemem capture changes;
  non-OpenCode sandboxing.
- **Adjacent expectations**: `opencode-nono-audit` consumes the profiles and
  metadata this spec renders and produces the compatibility report referenced
  by the strict-enforcement freshness check. Existing OpenCode wrapper commands,
  preflight, plugins, mcpproxy routing, RTK behavior, and provider
  authentication remain usable unless a selected sandbox profile intentionally
  blocks the underlying access.

## Requirements

### Requirement 1: Declarative OpenCode sandbox enablement
**Objective:** As an operator, I want OpenCode launches to be sandboxed through declarative host configuration, so that safety behavior is reproducible across rebuilds.

#### Acceptance Criteria
1. When the feature is enabled for a host, the OpenCode nono integration shall make `nono` available to managed OpenCode launches.
2. When the operator starts OpenCode through the managed command, the OpenCode nono integration shall launch OpenCode under the selected nono profile.
3. While the feature is disabled, the OpenCode nono integration shall leave managed OpenCode launch behavior unchanged.
4. If nono is requested but unavailable, then the OpenCode nono integration shall stop before launching OpenCode unsandboxed and print an actionable error.
5. The OpenCode nono integration shall expose the effective sandbox state to the operator for each launch.

### Requirement 2: Repo-managed profile catalog
**Objective:** As an operator, I want a small set of named sandbox profiles, so that each OpenCode session can use an auditable risk posture.

#### Acceptance Criteria
1. The OpenCode nono integration shall render a documented profile catalog for normal coding, compatibility auditing, and read-only review workflows.
2. When a profile is rendered, the profile shall include a name, version, description, and intended use.
3. Where a host-specific profile grants host-specific access, the profile shall label that access as host-specific.
4. When profile validation runs, the OpenCode nono integration shall report invalid profile syntax, missing inheritance targets, and unknown groups as failures.
5. The OpenCode nono integration shall not write provider credentials, MCP API keys, or other secret values into generated profiles.

### Requirement 3: Rollout controls and overrides
**Objective:** As an operator, I want staged rollout controls, so that sandboxing can be enabled without losing the ability to recover from incompatibilities.

#### Acceptance Criteria
1. The OpenCode nono integration shall support host defaults for disabled, compatibility-audit, and enforced sandbox states.
2. When the operator provides a per-launch override, the OpenCode nono integration shall apply the override without requiring a host rebuild.
3. If an override value is invalid, then the OpenCode nono integration shall stop before launching OpenCode and print the accepted values.
4. While the host default is enforced, the OpenCode nono integration shall still allow an explicit documented rollback path to start OpenCode without enforcement.
5. When strict enforcement is requested without a current compatibility report for the active generated profile version, the OpenCode nono integration shall warn the operator before strict enforcement proceeds.

### Requirement 4: Credentials, environment, and network posture
**Objective:** As an operator, I want sandbox profiles to make credential and network exposure explicit, so that OpenCode receives only the access it needs.

#### Acceptance Criteria
1. The OpenCode nono integration shall document which environment variables each managed profile passes through or injects.
2. Where inherited environment variables are restricted, the OpenCode nono integration shall still support the credentials explicitly required by the selected host configuration.
3. The OpenCode nono integration shall document network posture for provider access, mcpproxy access, localhost services, and blocked network modes.
4. If required provider or MCP access is blocked by a selected profile, then the OpenCode nono integration shall stop with an actionable error rather than launch OpenCode in a broken state.
5. The OpenCode nono integration shall keep credential material out of generated documentation and profile files.

### Requirement 5: Coexistence with existing OpenCode integrations
**Objective:** As an operator, I want nono to compose with current OpenCode integrations, so that safety rollout does not regress existing workflows unexpectedly.

#### Acceptance Criteria
1. When OpenCode starts under nono, the OpenCode nono integration shall preserve existing mcpproxy preflight behavior unless the selected profile blocks required access.
2. When OpenCode starts under nono, the OpenCode nono integration shall preserve existing host provider setup unless the selected profile blocks required access.
3. Where existing OpenCode plugins are installed, the OpenCode nono integration shall not silently disable them; a sandbox-induced failure shall surface as an error rather than a silent no-op.
4. Where RTK is enabled, the OpenCode nono integration shall make the effective RTK and nono states visible together to the operator.
5. The OpenCode nono integration shall not weaken existing OpenCode permission settings, MCP server quarantine behavior, or tool approval behavior.

### Requirement 6: Validation, smoke test, and operator guidance
**Objective:** As an operator, I want clear validation and guidance, so that I can understand, verify, and troubleshoot the sandbox rollout.

#### Acceptance Criteria
1. When repository checks run, the OpenCode nono integration shall validate generated profile files and the managed OpenCode launch contract.
2. When validation fails, the OpenCode nono integration shall name the failed check and the expected corrective action.
3. The OpenCode nono integration shall provide an operator guide covering profile selection, noninteractive launch behavior, runtime overrides, and rollback.
4. The OpenCode nono integration shall provide a smoke-test path that confirms OpenCode can start under the default managed profile.
5. The OpenCode nono integration shall record enough local metadata to identify the active profile version, host default state, and effective launch state.

### Requirement 7: nono package provisioning and version currency
**Objective:** As an operator, I want the integration to track the latest upstream-published nono release, so that sandbox behavior and profile schema match current nono instead of a stale pinned version.

#### Acceptance Criteria
1. The OpenCode nono integration shall provision nono at the latest version published upstream by the nono project.
2. If the configured nixpkgs does not provide that version, then the OpenCode nono integration shall supply nono through a repository overlay pinned to the latest upstream-published version.
3. The OpenCode nono integration shall allow an operator to pin or override the provisioned nono version through declarative configuration.
4. The OpenCode nono integration shall record the resolved nono version in the local metadata exposed to operators and checks.
5. When the provisioned nono version changes, the OpenCode nono integration shall validate the generated profiles against that version's profile schema.
