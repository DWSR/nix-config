# Research & Design Decisions — opencode-nono-audit

## Summary
- **Feature**: `opencode-nono-audit`
- **Discovery Scope**: Complex Integration (read-only analysis layer; split out
  of `opencode-nono-sandbox` on 2026-06-03 by operator decision).
- **Key Findings**:
  - `SqliteReader` from `scripts/opencode-cost-report.js` is cleanly reusable
    read-only (`require.main===module` guard; `{readonly,fileMustExist}`;
    `SUPPORTED_MIGRATION_SET` drift gate).
  - Tool name (`data.tool`||`data.name`) and output (`data.state.output`) are
    reliably derivable; tool-arg sub-shape (paths/commands/URLs) is unpinned;
    sockets/ports/env are inference-only.
  - cavemem `${dataDir}/data.db` `observations` is readable read-only but
    lossily compressed; the CLI cannot use the cavemem MCP (not an agent).
  - Adopt `nono profile show --json` for resolved grants instead of
    reimplementing group composition.

> Heavy nono 0.5.0 facts (profile schema, env filtering, `profile show`,
> Seatbelt) are recorded in `../opencode-nono-sandbox/research.md` Design Phase
> section; not duplicated here.

## Design Decisions

### Decision: Split audit/assess/review out of opencode-nono-sandbox
- **Context**: design-validation Issue 2 (spec breadth); the audit pipeline has
  no runtime dependency on the launcher.
- **Selected**: Move R3 (usage audit), R4 (compatibility), R9 (replacement
  review) from the sandbox spec into this sibling spec, renumbered 1–3. The
  sandbox spec keeps launch/profiles/rollout/creds/coexistence/validation.
- **Rationale**: independent deliverables, independent review, smaller PRs.
- **Trade-offs**: a cross-spec contract (the freshness marker) and a read-only
  dependency on the sandbox's rendered profiles.

### Decision: Reuse SqliteReader via env-injected lib path
- **Selected**: `.nix` wrapper sets `OPENCODE_NONO_COST_REPORT_LIB` to the store
  path of `opencode-cost-report.js`; the CLI `require()`s it for `SqliteReader`,
  on the `opencode-cost-diagnosis-deps` NODE_PATH (ships `better-sqlite3`).
- **Rationale**: avoids duplicating the reader and cross-store sibling requires;
  mirrors `OPENCODE_COST_PRICING_PATH`.

### Decision: Adopt `nono profile show --json` for grants
- **Selected**: the Assessor consumes nono's resolved-grant JSON rather than
  recomputing the 32-group composition + `extends` + deny precedence.
- **Trade-offs**: requires `nono` present for assessment; JSON shape unverified
  upstream → defensive parse, unmappable → `unknown`.

### Decision: Advisory replacement review with operator ledger
- **Selected**: rank tool-use, seed git→Git-MCP candidates, reconcile a
  `review-decisions.json` ledger the operator edits. The CLI never changes
  OpenCode permissions or MCP registrations (R3.7).

## Risks & Mitigations
- **Unverified `profile show --json` shape** — defensive parser; unmappable →
  `unknown`; verified by the Phase 0 spike.
- **Partial/inference evidence** (R1.2) — confidence + source tags; sockets/
  ports/env inference-only.
- **cavemem lossy/version-coupled** — best-effort secondary; schema-version
  guard; partial-report marking (R1.4).
- **Secret leakage** — redaction on by default; reports 0600; read-only.
- **Cross-spec drift** — the freshness-marker schema is a revalidation trigger
  shared with `opencode-nono-sandbox`.

## References
- `../opencode-nono-sandbox/research.md` (nono 0.5.0 facts, prior gap analysis)
- https://nono.sh/docs/cli/features/profile-introspection.md
- `scripts/opencode-cost-report.js` (`SqliteReader`, `FileWriter`)
- `scripts/subagent-context-budget.js` (deterministic report shape)
- `home-manager/common/cavemem.nix`, `scripts/cavemem-import-vault.js` (cavemem `data.db`)

---

# Verified nono `profile show --json` shape — 2026-06-05 (from sandbox Phase 0)

The original Assessor (tasks 3.1/3.2) parsed an UNVERIFIED synthetic shape
`{ grants: { <class>: { mode, allow, deny } } }`. Phase 0 of `opencode-nono-sandbox`
verified the REAL shape on nono **0.61.1** (also confirmed on 0.43.1):

- Top-level keys: `name, description, extends, security, filesystem, groups,
  network, workdir, rollback`. **No `grants` key.**
- `filesystem{ allow[], read[], write[], allow_file[], read_file[], write_file[],
  deny[], bypass_protection[], ... }` — PATH prefixes.
- `network{ block, network_profile, allow_domain[], open_port[], listen_port[],
  credentials[], ... }` — domains/ports/block.
- `groups{ include[], exclude[] }` — named policy groups; **`show` does NOT
  expand groups into concrete paths** (only names appear). Group-derived path
  grants are therefore unknowable from `show` alone.
- `security{ signal_mode, capability_elevation, ... }`; `workdir{ access }`.

Consequences (drive tasks 3.3/3.4):
- The shipped `parseGrants` reads `parsed.grants` → `null` against real output →
  `assess` returns `skipped (nono unparseable grants)`. Safe (never fabricates
  compatible) but INCOMPLETE.
- Re-target parsing to the real shape; classify observed PATHS against explicit
  `filesystem.allow/read/write/deny` (group-only paths → `unknown`), ENDPOINTS
  against `network.block`/`allow_domain`, and COMMANDS/ports/env → `unknown`.
  False-compatible AND false-blocker avoidance are both mandatory.
- Real-capture fixture committed: `tests/opencode-nono-audit/fixtures/
  nono-profile-show-node-dev-0.61.1.json` (built-in `node-dev`, shape-faithful;
  the managed-profile capture replaces it at sandbox-integration time).
- `--silent` is required for clean stdout and is already passed (commit dd6e241).
- nono 0.61.1 removed the built-in `opencode`/`codex`/`claude-code` profiles;
  the Assessor targets the RENDERED managed profiles, not a built-in `opencode`.
