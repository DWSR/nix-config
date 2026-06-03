# Brief: opencode-nono-audit

## Problem
Before tightening the nono sandbox profiles rendered by `opencode-nono-sandbox`,
the operator needs evidence: what tools, commands, paths, network endpoints,
sockets, ports, and environment variables historical OpenCode sessions actually
used; whether the proposed profiles would block any of that; and which common
direct tool uses (e.g. Git) could move to MCP servers to shrink the sandbox
surface. None of this exists yet.

## Current State
- `opencode-nono-sandbox` renders the managed nono profiles
  (`opencode-managed`, `opencode-audit`, `opencode-review`) and the launch
  contract; this spec consumes those profiles (read-only) to assess them.
- `scripts/opencode-cost-report.js` exposes a read-only `SqliteReader`
  (`{readonly:true,fileMustExist:true}`, schema-drift gated) over the OpenCode
  session DB; reusable via `require()`.
- cavemem stores observations in `${dataDir}/data.db` (compressed content).
- nono exposes `nono profile show <name> --json` for resolved grants.

## Desired Outcome
A read-only `opencode-nono-audit` CLI that produces:
1. a usage inventory of observed OpenCode tool activity,
2. a compatibility report comparing observed usage against each managed profile,
3. a ranked common-tool-use list with advisory MCP-replacement decisions
   recorded in an operator-maintained ledger.
Output is human-readable and machine-readable, redacted by default, and never
mutates any source or changes OpenCode permissions/MCP registrations. The
compatibility report also serves as the freshness marker the
`opencode-nono-sandbox` strict-enforcement check reads.

## Approach
A single read-only Node CLI (`opencode-nono-audit`) reusing `SqliteReader` from
`opencode-cost-report.js` via an env-injected lib path, plus the
`opencode-cost-diagnosis-deps` NODE_PATH tree. It adopts nono's own resolver
(`nono profile show --json`) for profile grants rather than reimplementing group
composition. cavemem `data.db` is an optional, version-guarded, best-effort
secondary source. A new redaction module strips secrets before serialization.
Decisions live in an operator-maintained ledger; the CLI is advisory only.

Considered alternatives:
- **Fold into `opencode-nono-sandbox`**: rejected — the audit has no runtime
  dependency on the launcher and bloats one spec/PR.
- **Reimplement nono group composition**: rejected in favor of `profile show
  --json`.
- **Use the cavemem MCP surface**: rejected — the CLI is not an agent; it reads
  `data.db` directly, read-only.

## Scope
- **In**: read-only usage audit over OpenCode SQLite (+ optional cavemem),
  observed-capability model, compatibility assessment against managed profiles,
  ranked tool-use replacement review + decisions ledger, redaction, JSON+Markdown
  reports, report freshness marker, flake app/check wiring, tests.
- **Out**: launching/sandboxing OpenCode, rendering profiles, rollout state
  (owned by `opencode-nono-sandbox`); acting on replacement decisions; modifying
  nono; changing OpenCode permissions or MCP registrations.

## Boundary Candidates
- **Usage audit**: source opening, capability extraction, partial/fail handling.
- **Compatibility assessment**: profile-grant ingestion via `profile show
  --json`, classification taxonomy.
- **Replacement review**: ranking, candidate map, decisions ledger.
- **Reporting**: deterministic JSON+MD, redaction, freshness marker.

## Out of Boundary
- nono upstream work; OpenCode permission/MCP authorization changes; live
  enforcement decisions.

## Upstream / Downstream
- **Upstream**: `opencode-nono-sandbox` (profiles + metadata + profile-version
  marker), `opencode-cost-diagnosis` (`SqliteReader`, deps tree), cavemem
  `data.db`.
- **Downstream**: post-rollout profile tuning in `opencode-nono-sandbox`
  (operator reads this report before flipping `defaultState`).

## Constraints
- macOS/nix-darwin first; declarative install via Nix/Home Manager.
- Read-only against all sources; schema-defensive (OpenCode DB drift, cavemem
  version coupling).
- Redact secrets by default; never serialize raw secret-bearing payloads.
- Advisory only: no OpenCode permission or MCP registration changes.
