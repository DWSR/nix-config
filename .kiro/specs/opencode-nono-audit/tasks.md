# Implementation Plan

> Read-only audit CLI for the nono sandbox rollout. Phase 0 (1.1) is a shared
> on-host verification gate with `opencode-nono-sandbox`. `(P)` marks
> parallel-capable tasks. The live `metadata.json` consumed by 5.2 is produced
> by `opencode-nono-sandbox` (out of boundary here).

- [ ] 1. Foundation: verification spike, packaging, and test fixtures
- [x] 1.1 Verify nono 0.5.0 behavior and capture baseline fixtures (Phase 0 gate)
  - Run `nono profile show opencode --json` on-host and save the output as the assessor test fixture
  - Inspect a real OpenCode session DB to confirm which tool-arg fields (commands/paths/URLs) are derivable and at what confidence; decide the minimum-fidelity bar and which capability classes to treat as unobservable
  - Confirm the cavemem `data.db` schema/version and how lossy the compressed observation content is for capability extraction
  - Observable completion: captured `profile show --json` fixture committed plus a short recorded decision on the minimum-fidelity bar and unobservable classes
  - Note: host/operator verification; if nono or a real session DB is unavailable, record the assumption and the unobservable-class fallback before proceeding
  - _Requirements: 1.2, 2.1_

- [x] 1.2 Scaffold the audit CLI package, runtime wrapper, and module wiring
  - Add the `.nix` wrapper that runs the CLI on the existing vendored deps tree (NODE_PATH) and injects the cost-report library path env var
  - Add the thin Home Manager module (package option, install, peer assertion on the OpenCode program) and import/enable it on both hosts
  - Add a stub CLI entrypoint with `--help`/`--version` and a script-vs-module guard, plus the node test dispatcher
  - Register the `nix run` app for the audit CLI
  - Observable completion: `nix run .#opencode-nono-audit -- --help` prints usage and exits 0 on a clean checkout
  - _Requirements: 1.1_
  - _Boundary: Packaging_

- [x] 1.3 Build read-only test fixtures
  - Create a synthetic OpenCode session DB fixture with tool parts for bash, git, read, and webfetch (representative args)
  - Create a schema-drift session DB fixture (migration set outside the supported window)
  - Create a cavemem `data.db` fixture and a sandbox `metadata.json` fixture carrying a `profileVersion`
  - Observable completion: the fixtures load via the test dispatcher and are consumed by later tests
  - _Requirements: 1.1, 1.3, 1.4, 2.1_
  - _Depends: 1.1_

- [ ] 2. Core: read-only usage audit and redaction
- [x] 2.1 Open data sources read-only and track source status
  - Reuse the cost-report SQLite reader via the injected library path to open the OpenCode session DB read-only
  - Optionally open the cavemem `data.db` read-only as a secondary source, version-guarded
  - Map a reader open-failure or schema-drift error to an `incompatible` source and mark the report partial; never crash on drift
  - Exit nonzero with no assessment when no source is readable
  - Observable completion: running over the fixtures yields a source-status list; the drift fixture produces `incompatible` + partial, the empty case exits nonzero, and source mtimes/sizes are unchanged
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_
  - _Boundary: Usage Audit CLI_

- [x] 2.2 Build the observed-capability model
  - Derive per-tool name, count, and output reliably; derive command/path/URL best-effort with confidence + source tags; treat sockets/ports/env as inference-only
  - Populate the unobservable-capability-class list when a class cannot be derived from the available sources
  - Observable completion: capability records over the fixture carry confidence/source tags, and a fixture lacking derivable args populates the unobservable-class list instead of empty coverage
  - _Requirements: 1.2, 1.3_
  - _Boundary: Usage Audit CLI_
  - _Depends: 2.1_

- [x] 2.3 (P) Implement the secret redactor
  - Mask tokens, API keys, `KEY=VALUE` env values, and credentials embedded in URLs
  - Apply redaction to every command/path/endpoint/env string before serialization; on by default
  - Observable completion: a unit test feeds secret-bearing strings and asserts all are masked
  - _Requirements: 1.7_
  - _Boundary: Redactor_

- [ ] 3. Core: profile compatibility assessment
- [x] 3.1 (P) Ingest resolved profile grants
  - Shell `nono profile show <name> --json` read-only and defensively parse the resolved grants
  - When nono is unavailable, emit an explicit "assessment skipped (nono unavailable)" status while the usage audit and review still produce output (distinct from the no-source hard failure)
  - Observable completion: grants parse from the profile-show fixture; with nono absent, the run still produces audit + review output plus a skipped-assessment status
  - _Requirements: 2.1_
  - _Boundary: Compatibility Assessor_
  - _Depends: 2.2_

- [ ] 3.2 Classify observed usage against grants
  - Classify each observed capability as compatible, warning, blocker, or unknown; unmappable observations are unknown, never compatible
  - For blockers/warnings, record profile, observed usage, affected session context, and missing capability when available
  - Observable completion: classification over the fixtures includes at least one unknown and one blocker carrying a missing-capability value
  - _Requirements: 2.2, 2.3, 2.4_
  - _Boundary: Compatibility Assessor_
  - _Depends: 3.1_

- [ ] 4. Core: common tool-use replacement review
- [ ] 4.1 (P) Rank tool-use and seed replacement candidates
  - Rank by `count × capabilityRisk` using a static capability-risk map with a deterministic tie-break
  - Seed MCP-replacement candidates (git → Git MCP) and mark "no viable replacement" when none is known
  - Observable completion: a deterministic ranked list over the fixture surfaces the git → Git MCP candidate
  - _Requirements: 3.1, 3.2, 3.3_
  - _Boundary: Tool-Use Replacement Review_
  - _Depends: 2.2_

- [ ] 4.2 Reconcile the decisions ledger
  - Read the operator-maintained decisions ledger and reconcile candidates as keep/replace/defer/none
  - Validate that replace entries document permission reduction + workflow change and keep entries document reason + required capability; echo undecided candidates
  - Never change OpenCode permissions or MCP registrations from this output
  - Observable completion: a ledger missing required fields yields a validation error naming the tool and field; undecided candidates are echoed
  - _Requirements: 3.4, 3.5, 3.6, 3.7_
  - _Boundary: Tool-Use Replacement Review_
  - _Depends: 4.1_

- [ ] 5. Integration: reporting, freshness marker, and CLI wiring
- [ ] 5.1 Emit deterministic redacted reports
  - Serialize one stably-key-ordered report object to JSON and Markdown, all strings redaction-passed
  - Write reports 0600 under the XDG state directory with last-N retention; include schema version, host, profile version, and timestamp in the header
  - Observable completion: a run writes byte-stable JSON and Markdown at mode 0600 under the XDG state directory
  - _Requirements: 2.5, 1.7, 1.4_
  - _Boundary: Reporter_
  - _Depends: 2.2, 2.3, 3.2, 4.2_

- [ ] 5.2 Write the cross-spec freshness marker
  - Read the active `profileVersion` from the sandbox-rendered `metadata.json`
  - Write the versioned `last-report.json` marker `{ markerSchemaVersion, profileVersion, generatedAt, host }`
  - Observable completion: the marker is written with the version read from the metadata fixture, and a mismatched version is reported stale
  - Note: the live `metadata.json` is produced by `opencode-nono-sandbox`; this task uses the fixture and consumes the real file at integration time
  - _Requirements: 2.1_
  - _Boundary: Reporter_
  - _Depends: 5.1_

- [ ] 5.3 Wire CLI subcommands end-to-end
  - Replace the stub with `audit`, `assess`, `review`, and `all` subcommands, flag parsing, and exit codes
  - Observable completion: `nix run .#opencode-nono-audit -- all` runs over the fixtures and produces a report plus a freshness marker
  - _Requirements: 1.1, 2.5, 3.1_
  - _Boundary: Usage Audit CLI_
  - _Depends: 5.1, 5.2_

- [ ] 6. Validation: tests and flake checks
- [ ] 6.1 Unit tests for redactor, capability model, ledger, and determinism
  - Cover redaction masking, capability-model confidence/source + unobservable-class population, ledger required-field validation, and report determinism
  - Observable completion: `node --test` passes for these unit suites
  - _Requirements: 1.2, 1.7, 3.4, 3.5, 3.6_
  - _Depends: 2.2, 2.3, 4.2_

- [ ] 6.2 Integration tests over fixtures
  - Audit: partial on a missing source, nonzero on no source, read-only guarantee, and schema-drift degradation
  - Assess: classification including unknown, and the nono-absent skip path
  - Review: deterministic ranking and the git candidate
  - Freshness marker: the written marker matches the versioned schema and its `profileVersion` equals the metadata fixture (stale on mismatch)
  - Observable completion: `node --test` passes for the integration suite over the fixtures
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2_
  - _Depends: 5.3_

- [ ] 6.3 Register flake checks for tests and CLI validation
  - Add a check that runs the node test suite in a sandbox build and a check that builds the CLI and runs `--help`/`--version`
  - Observable completion: `nix flake check` executes the audit test suite and the validate-check passes
  - _Requirements: 2.5_
  - _Depends: 1.2, 6.2_

## Implementation Notes

- 1.1: `nono` is unavailable on this host; the Phase 0 fixture records the skip path, OpenCode structured `part.data.state.input` is authoritative for command/path/URL extraction, and cavemem is low-confidence secondary context only.
- 2.2: `CapabilityRecord` typed contract has no `output` field (design prose mentions output, but the type is authoritative); capabilities are sorted by tool name for determinism; the structurally-unobservable classes are `["device","env-var","ipc","port","process-signal","unix-socket"]`.
- 2.3: `redact()` masks ONLY the four design classes (URL creds, KEY=VALUE env, known token shapes, secret query params). A generic high-entropy-blob rule was rejected because it mangles legitimate paths/URLs/git-SHAs/nix-store-paths — do NOT reintroduce one when wiring redaction into serialization (5.1). A bare context-free opaque blob is intentionally NOT masked.
