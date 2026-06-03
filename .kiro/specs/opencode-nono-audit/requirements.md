# Requirements Document

## Introduction
`opencode-nono-audit` is the read-only evidence layer for the nono sandbox
rollout. It audits historical OpenCode tool usage, assesses that usage against
the managed nono profiles rendered by `opencode-nono-sandbox`, and produces a
ranked common-tool-use list with advisory MCP-replacement decisions. See
`brief.md` for problem, approach, and scope.

## Boundary Context
- **In scope**: read-only historical OpenCode usage audit, optional cavemem
  evidence, compatibility assessment against managed profiles, common tool-use
  replacement review + decisions ledger, secret redaction, human/machine
  readable reports, and the report freshness marker.
- **Out of scope**: launching/sandboxing OpenCode, profile rendering, rollout
  state, per-launch overrides (owned by `opencode-nono-sandbox`); acting on
  replacement decisions; nono upstream changes; OpenCode permission or MCP
  registration changes.
- **Adjacent expectations**: consumes the managed profiles and profile-version
  metadata from `opencode-nono-sandbox` (read-only) and reuses `SqliteReader`
  from `opencode-cost-diagnosis`. The compatibility report it writes is the
  freshness marker the `opencode-nono-sandbox` strict-enforcement check reads.

## Requirements

### Requirement 1: Historical OpenCode usage audit
**Objective:** As an operator, I want prior OpenCode sessions audited before enforcement, so that profile decisions are based on observed tool usage.

#### Acceptance Criteria
1. When the usage audit runs, the OpenCode nono audit shall inspect historical OpenCode sessions from configured local data sources.
2. When tool activity is available, the usage audit shall summarize observed OpenCode tools, command invocations, accessed paths, network-relevant endpoints, sockets, ports, and environment-variable dependencies when those fields can be derived.
3. Where cavemem observations are available, the usage audit shall use them as an additional source for tool inputs and responses.
4. If a configured data source is missing, unreadable, or incompatible, then the usage audit shall report the affected source and mark the report as partial.
5. If no configured data source can be read, then the usage audit shall fail without producing a compatibility assessment.
6. The usage audit shall not modify OpenCode session data, cavemem data, nono audit logs, or generated profiles.
7. When the usage audit serializes findings, the usage audit shall redact credential values, API keys, tokens, and raw secret-bearing payloads by default.

### Requirement 2: Profile compatibility assessment
**Objective:** As an operator, I want observed usage compared against proposed profiles, so that sandbox incompatibilities are visible before rollout.

#### Acceptance Criteria
1. When the compatibility assessment runs, the OpenCode nono audit shall compare observed historical usage against each managed profile selected for assessment.
2. The compatibility assessment shall classify each finding as compatible, warning, blocker, or unknown.
3. If observed usage requires access not granted by a profile, then the compatibility assessment shall identify the profile, observed usage, affected session context, and missing capability when available.
4. If observed usage cannot be mapped to a sandbox capability, then the compatibility assessment shall classify it as unknown rather than compatible.
5. The compatibility assessment shall produce human-readable and machine-readable output.

### Requirement 3: Common tool-use replacement review
**Objective:** As an operator, I want common direct tool uses reviewed for MCP-mediated alternatives, so that sandbox rollout distinguishes necessary direct access from replaceable access patterns.

#### Acceptance Criteria
1. When the usage audit completes, the OpenCode nono audit shall produce a ranked list of common OpenCode tool-use patterns by frequency and risk-relevant capability.
2. Where Git command patterns are observed, the common tool-use review shall evaluate whether a Git MCP server can replace any direct Git command category.
3. When a common tool-use pattern invokes external commands or broad local resources, the common tool-use review shall identify whether a candidate MCP-mediated alternative exists when known.
4. When a candidate replacement is identified, the common tool-use review shall record a decision to keep direct OpenCode tool use, replace it with an MCP server, defer the decision, or mark no viable replacement.
5. If a decision recommends MCP replacement, then the common tool-use review shall document the expected sandbox-permission reduction and any operator-visible workflow change.
6. If a decision keeps direct OpenCode tool use, then the common tool-use review shall document the reason and the sandbox capability that must remain available.
7. The OpenCode nono audit shall not change OpenCode tool permissions or MCP server registrations solely from the common tool-use review output.
