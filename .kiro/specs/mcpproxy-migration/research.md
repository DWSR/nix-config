# Gap Analysis: mcpproxy-migration

Synthesis of two parallel investigations: codebase inventory (all files
the spec mutates) and mcpproxy-go internals (config schema, HTTP API,
keyring semantics, build characteristics). Detailed file-level findings
live in the sub-agent reports; this document captures the decisions
that need to be made before design and the risks each carries.

## 1. Current State Investigation

### Secret bridge (R5, R6, R12)

- `scripts/mcp-secrets-activate.nix` (249 lines): args
  `<username> <manifest-path>`; writes via
  `security add-generic-password -U -s "$service" -a mcp-hub -w "$value"`
  (account hardcoded at L156); registry-driven stale cleanup at
  `/var/lib/mcp-keychain-sync/installed-services` using `comm -23`;
  exit codes 0/1/2/3/4. Registry mechanism is sound and stays; only
  the `(-s, -a)` axes change.
- `scripts/mcp-verify-secrets.nix` (176 lines): per-host arg
  (`shopify | personal`); same `-a mcp-hub` shape; output
  `MATCH|MISMATCH|MISSING`.
- 15 call sites of `config.home.mcp.readKeychainSecret` across
  `configurations/{shopify,personal}/home-manager/default.nix`
  (7 + 8) consume the `${cmd: ... -a mcp-hub -w}` expansion in MCP
  server env vars, headers, and args.

### Sqlite-backup keychain coupling (R12)

`mcp-hub` account name leaks into three files unrelated to MCP:

- `scripts/sqlite-backup-cli.nix:L79` —
  `readonly KEYCHAIN_ACCOUNT=mcp-hub` (hardcoded constant).
- `home-manager/common/sqlite-backup.nix:L350` —
  `keychainAccount = "mcp-hub"` (manifest renderer).
- `configurations/common-darwin/sqlite-backup-verify.nix:L105` —
  reads `keychainAccount` from manifest dynamically via `jq`.

Subtle: cli hardcodes; verify reads dynamically. Rename target must
stay in `[a-z0-9-]+` (cli intentionally unquotes the value).

### nvim integration surface (R11)

- `home-manager/nixvim/plugins/mcphub.nix` (85 lines): entire file
  removed.
- `home-manager/nixvim/plugins/codecompanion.nix` (105 lines): MCP
  wiring lives in exactly two blocks — L15-25 (`before.__raw` lz.n
  hook) and L43-58 (`extensions.mcphub`). Everything else stays.
- `home-manager/nixvim/plugins/lualine.nix`: L8 (let-binding) +
  L34 (use-site).
- `home-manager/nixvim/default.nix:L40`: imports entry.
- `flake.nix:L73-79`: `mcphub-nvim` + `mcphub` inputs.

The `mcphub` flake input is doubly consumed (nvim plugin AND overlay
alias `pkgs.mcp-hub` at `overlays/mcp-servers.nix:L36`). Removing the
input requires R1 to land first.

### Existing Go MCP packaging template (R1)

`overlays/mcp-servers.nix:L521-555` has `buildkite-mcp-server` and
`slack-mcp-server` buildGoModule derivations. Both: `fetchFromGitHub`
with `tag = "v<X.Y.Z>"`, `vendorHash`, `meta.mainProgram`. mcpproxy-go
is a `cmd/mcpproxy`-style Go binary; template applies directly.

### Cavemem split-brain surface (R7)

`home-manager/common/cavemem.nix`:

- L491-501: `programs.opencode.settings.mcp.cavemem` (opencode shape
  `{type, command-as-array, environment, enabled}`). **R7 removes.**
- L431-437: `home.mcp.extraServers.cavemem` (mcphub shape
  `{command, args, env}`). **Stays in spirit; outer module rewrites
  to mcpproxy's array shape.**
- L549-557: wrapper probe hitting `POST /api/servers/info` on
  `:37373`. **R7 rewrites against mcpproxy's status API.**

### Agent contract rewrite surface (R4, R13)

| File | `hub_*` refs |
|---|---|
| `home-manager/common/agents.md` | 24 |
| `home-manager/common/agents/vault-curator.md` | 14 |
| `home-manager/common/agents/vault-synthesizer.md` | 51 |
| `home-manager/common/agents/security-auditor.md` | 2 |
| `configurations/shopify/home-manager/agents/stack-captain.md` | 13 |
| `configurations/shopify/home-manager/agents-graphite.md` | 3 |
| `configurations/shopify/home-manager/skills/graphite-pitfalls/SKILL.md` | 2 |

109 refs total; `vault-synthesizer.md` dominates. Already at 0:
`agents-cc-sdd.md`, `agents/nix-pkg.md`, `agents/nvim-tailor.md`,
`agents/yb-sleuth.md`.

## 2. mcpproxy-go shape that drives requirements feasibility

### Config schema (R1, R2, R5)

`mcp_config.json` top-level fields used here:

- `listen` (string `host:port`, default `127.0.0.1:8080`)
- `data_dir` (string, default `~/.mcpproxy`)
- `mcpServers` — **array** (not attrset)
- `tools_limit` (default 15; **leave at default** to keep
  retrieve_tools mode active)
- `routing_mode` (default `retrieve_tools`)
- `quarantine_enabled` (`*bool`, default `true` when nil)
- `api_key` (auto-generated and **persisted back to config** if empty
  — this is the wrinkle)
- `require_mcp_auth` (default `false`; `/mcp` is unauthenticated)

Per-server `ServerConfig`:

- `name` (required, unique)
- `protocol` (`stdio | http | sse | streamable-http | auto`)
- `command`, `args`, `env`, `working_dir`
- `enabled` (bool, **not omitempty** — emit `true` explicitly)
- `quarantined` (bool, **not omitempty** — emit `false` explicitly,
  or set global `quarantine_enabled: false`)
- `skip_quarantine`, `isolation`, `reconnect_on_use`,
  `launcher_wait_timeout`, `enabled_tools`, `disabled_tools`,
  `oauth`, `headers`

### Keyring semantics (R5, R6)

- Placeholder syntax: `${keyring:<name>}`. Single form. Resolver
  walks the config struct reflectively (every string field
  eligible); README's "env+args only" is documentation intent.
- Keychain coordinates (`internal/secret/keyring_provider.go`):
  - service = `"mcpproxy"` (hardcoded constant)
  - account = the `<name>` after the colon
  - kind = generic password
  - Read: `security find-generic-password -s mcpproxy -a <name> -w`
  - Write: `security add-generic-password -s mcpproxy -a <name> -w '<value>' -U`
- Missing entry → mcpproxy logs error and **refuses to start** —
  good for R8 (wrapper preflight catches it).
- `mcpproxy secrets set` is hard-disabled on macOS by default; the
  SOPS bridge writes via `security` CLI which is unaffected.

### HTTP API (R8, R9)

- Localhost-only `127.0.0.1:8080`.
- Liveness (no auth): `GET /healthz`, `GET /readyz`.
- Status (auth required): `GET /api/v1/status` → `{running, edition,
  listen_addr, upstream_stats, status, routing_mode, timestamp}`.
- Per-server: `GET /api/v1/servers` or
  `GET /api/v1/servers/{id}`.
- MCP transport: `GET/POST /mcp` (routing from config) or
  `/mcp/call` (always retrieve_tools).
- Auth: `X-API-Key` / `Authorization: Bearer` / `?apikey=`.

### Tool-name shape (R4) — corrects prior viability finding

In `retrieve_tools` mode, results carry the upstream tool's **original
unprefixed name** (e.g. `list-notes`) plus a `call_with` field
selecting the `call_tool_*` primitive. No colon-separator, no
`server__tool` prefix. Direct mode (not used) uses
`serverName__toolName`.

R4's rewrite pattern:

```
# Before (mcphub direct):
hub_obsidian__list-notes(directory: "memories", limit: 1)

# After (mcpproxy retrieve_tools):
1. retrieve_tools(query: "list obsidian notes")
   → [{ name: "list-notes", call_with: "call_tool_read", ... }]
2. call_tool_read(name: "list-notes",
                  arguments: { directory: "memories", limit: 1 })
```

### Build characteristics + pin (R1)

- `github.com/smart-mcp-proxy/mcpproxy-go`; `go 1.24.2`. nixpkgs
  `go_1_24` satisfies. No `replace` directives.
- `//go:embed` for frontend (fallback stub means
  `go build ./cmd/mcpproxy` works standalone).
- Build: `CGO_ENABLED=0 go build -ldflags "-X main.version=v0.33.1 -X main.Edition=community -s -w" -o mcpproxy ./cmd/mcpproxy`.
  No special build tags. Tray is a separate `cmd/mcpproxy-tray`
  binary (not built).
- Pin: **`v0.33.1`** (tag, commit `1356c60`, 2026-05-20). Bug-fix
  release; no schema breakage in trailing 7 days.

## 3. Requirement-to-Asset Map

| Req | Existing assets | Gap | Tag |
|---|---|---|---|
| R1 deployment | `home-manager/mcp/default.nix` launchd block (template); existing `buildGoModule` MCP servers as packaging template | New overlay derivation for mcpproxy-go; rewrite of the launchd plist (label, args, PATH); `restart-mcp-hub` shim renamed | Missing |
| R2 server inventory | `home.mcp.extraServers` (attrsOf attrs); existing servers registered in `mcp/default.nix` | Schema translation `attrset → array`; `enabled`/`quarantined` explicit emission; possibly tighter type | Constraint |
| R3 four-tool surface | None (mcphub didn't have an analog) | Default-config retrieve_tools mode; verification that ~140 upstream tools collapse to 4 visible tools | Missing |
| R4 agent prompts | 109 `hub_*` refs across 7 files; current AGENTS.md startup gate | Rewrite to two-step retrieve_tools + call_tool_* pattern; replace direct tool calls; keep "refuse to proceed" semantics | Missing |
| R5 secret flow | `readKeychainSecret` HM option (15 call sites); mcp-secrets-activate writes `mcp-hub` account | Replace `${cmd:...}` with `${keyring:<name>}` placeholders; swap activation script's `-s`/`-a` axes | Constraint |
| R6 keychain migration | Activation script's registry-driven cleanup; verify script's per-secret check | Add legacy-entry deletion pass; verify script reads new layout; ensure idempotency | Missing |
| R7 cavemem split-brain | `home-manager/common/cavemem.nix` L491-501 (direct entry), L549-557 (probe) | Remove direct entry; rewrite probe against `/api/v1/status` (and/or `/healthz`); preserve `CAVEMEM_DATA_DIR` | Missing |
| R8 opencode preflight | `home-manager/common/opencode.nix` L85-92 (mcphub probe) | Rewrite probe targeting mcpproxy's status endpoint; add per-server probes; handle API key | Missing |
| R9 memory-sync | `scripts/memory-sync.nix` `MCPHUB_BASE` + per-server probes | Repoint base URL; rewrite per-server probes against mcpproxy API; preserve exit-code contract | Missing |
| R10 per-host opencode wiring | Shopify `opencode.nix:146-152` (`mcp.hub` entry); personal has none | Add mcpproxy entry on both hosts; remove Shopify `mcp.hub` legacy entry; remove direct cavemem entry | Missing |
| R11 nvim teardown | `mcphub.nix`, `codecompanion.nix` (selective), `lualine.nix` (selective), `nixvim/default.nix`, `flake.nix` inputs | Delete `mcphub.nix`; strip codecompanion's MCP blocks (L15-25, L43-58); strip lualine's `mcphub` symbol; remove imports + flake inputs | Missing |
| R12 sqlite-backup rename | 3 files reference `mcp-hub` keychain account | Pick neutral account name; rename in cli/module/verify; add one-shot migration in activation; update docs | Missing + Decision |
| R13 docs alignment | `agents.md`, `agents-cc-sdd.md` (already clean), `secrets/README.md`, `agents/nix-pkg.md`, `cavemem.nix` comments | Find/replace mcphub→mcpproxy in narrative; preserve historical context when explicitly framed | Missing |
| R14 acceptance evidence | Memory startup gate; memory-sync CLI; opencode wrapper preflight; `darwin-rebuild check` | Compose acceptance checklist; runbook for re-running on each host | Missing |

## 4. Implementation Approach Options

The 8 boundary seams in the brief don't really admit
"extend vs new vs hybrid" at the spec level — Approach 2 (Clean-cut)
is the user-confirmed strategy. What remains are choices within
that approach. The options below are the meaningful design decisions
the design phase will commit to.

### Decision 1: `home.mcp.extraServers` schema migration

- **A (recommend)**: Keep attrset shape; module renders to mcpproxy's
  array internally. Preserves all 13+ cross-host consumer call sites
  unchanged.
- **B**: Re-type to list of submodules with strict typing. Cleaner
  long-term but breaks every call site as part of this spec.

### Decision 2: `readKeychainSecret` lifecycle

- **A (recommend)**: Keep the HM option; replace its body to emit
  `"\${keyring:<name>}"`. All 15 call sites compile unchanged.
- **B**: Remove the helper; rewrite each call site to a string
  literal. Honest but 15 mechanical edits.

### Decision 3: mcpproxy API key handling

mcpproxy auto-generates a 256-bit API key and **persists it back to
config** — incompatible with our Nix-store-immutable config file.

- **A (recommend)**: Pre-populate as a SOPS-bridged secret
  (`mcpproxy-api-key` in SOPS → keychain → `${keyring:mcpproxy-api-key}`
  in the `api_key` field). Aligns with the existing bridge; key is
  Nix-deterministic.
- **B**: Render config to a writable location (`~/.mcpproxy/`) so
  mcpproxy's write succeeds. Introduces a mutable-config-file
  complication.
- **C**: Skip auth-required endpoints entirely; use only `/healthz`
  for probes. Simplest but loses per-server status visibility.

Recommend A; C is a viable fallback if SOPS surface complexity is
unwanted. Both can coexist (A for probes, no auth on `/mcp` traffic).

### Decision 4: Commit-vs-tag pinning

- **A (recommend)**: Tag `v0.33.1`. Matches repo convention
  (`buildkite-mcp-server`, `slack-mcp-server` both tag-pin). Tag is
  immutable; functionally equivalent to commit-pin.
- **B**: Bare commit `1356c60`. Literal brief compliance but
  diverges from repo convention.

### Decision 5: sqlite-backup neutral account name

`nix-config-secrets` (recommend, matches brief placeholder),
`dwsr-secrets`, or `darwin-secrets`. Settle in design.

### Decision 6: Quarantine handling

- **A (recommend)**: Global `quarantine_enabled: false`. Single-line
  config; lowest ceremony.
- **B**: Per-server `quarantined: false + skip_quarantine: true`.
  More explicit but verbose. Only useful if some future server should
  remain quarantined.

### Decision 7: Sqlite-backup keychain account source of truth

- **A (recommend)**: Unify on manifest-driven — replace cli's
  hardcoded constant with a `jq` manifest read; both files read the
  same source.
- **B**: Keep cli hardcoded; update verify alone. Two
  source-of-truth points.

## 5. Implementation Complexity & Risk

| Seam | Effort | Risk | One-line justification |
|---|---|---|---|
| Packaging (R1) | S | Low | buildGoModule template exists; no CGO; pin known |
| Orchestrator module rewrite (R1-R2-R3-R5) | M | Medium | New schema shape; new launchd label; API key wrinkle |
| Secret bridge axes swap (R5, R6) | M | Medium | Mechanical but irreversible per host; needs careful one-shot logic |
| Cavemem split-brain closure (R7) | S | Low | Two block removals + one probe rewrite |
| Opencode integration (R8, R10) | S | Low | Wrapper probe rewrite; URL flip; per-host new entry |
| Memory-sync CLI (R9) | S | Low | URL + endpoint shape change; preserve exit codes |
| Agent prompt rewrite (R4) | L | Medium | 109 refs across 7 files; new 2-step idiom; vault-synthesizer.md is dense |
| Nvim teardown (R11) | S | Low | Pure removal; codecompanion strip is targeted |
| Sqlite-backup rename (R12) | M | Medium | 3 files + keychain migration + manifest unification |
| Docs alignment (R13) | S | Low | Find/replace + historical-context preservation in cavemem.nix |
| Acceptance evidence (R14) | S | Low | Composition of existing checks into a runbook |

Aggregate: **Medium-Large** spec. The agent prompt rewrite (R4)
dominates the per-file work; the secret bridge (R5/R6) dominates
the risk because it's an irreversible per-host migration.

## 6. Research Items to Carry Into Design

Items needing concrete answers in design phase, not blockers for
this gap analysis:

1. **API key strategy** (Decision 3): commit to one of A/B/C. If A,
   add `mcpproxy-api-key` to the SOPS bridge as one of the
   operator-declared MCP secrets.
2. **`/mcp` endpoint trailing slash**: mcp-hub used
   `http://localhost:37373/mcp/`; mcpproxy responds at
   `http://127.0.0.1:8080/mcp` (no trailing slash). Verify opencode's
   remote-MCP client doesn't choke on the missing slash; flip to
   `127.0.0.1` (avoid `localhost` IPv6 lookup latency).
3. **`enabled_tools` / `disabled_tools` per-server filters**: mcpproxy
   supports per-server allow/deny lists for individual tools (e.g.
   block obsidian's `delete-note` from being callable via the proxy).
   Out of scope for this spec (deferred), but the schema field is
   available; design phase notes it as a future hook.
4. **launchd PATH for spawned upstreams**: the current mcp-hub
   launchd plist supplements PATH with `google-cloud-sdk` and
   `git-lfs`. mcpproxy's launchd plist must replicate this to keep
   gcloud-mcp and github-mcp-server functional. Confirm no other
   PATH entries are missing.
5. **Log duplication**: mcpproxy writes to
   `~/Library/Logs/mcpproxy/main.log` by default in addition to
   stdout. Decide whether to suppress file logging with
   `--log-to-file=false` (rely on launchd's `StandardOutPath`) or
   keep both. Recommend suppressing — single source of log truth.
6. **Verification scope for R14**: define what "clean activation"
   means concretely (`darwin-rebuild switch` on a fresh checkout?
   `darwin-rebuild check` on the post-migration commit? per-host
   runbook?). Surface the exact command sequence in design's
   acceptance section.
7. **`vault-synthesizer.md` rewrite shape** (R4): the 51-ref file has
   negative-list patterns ("no `hub_buildkite__*`, no
   `hub_observe_*`") that mapping to retrieve_tools mode breaks
   differently than the affirmative patterns. Design phase decides
   whether the synthesizer prompt continues to enumerate forbidden
   tool families (now described in retrieve_tools terms) or shifts
   to a different scoping mechanism.
8. **Personal-host new MCP surface**: per the requirements answer,
   personal-host opencode gains a mcpproxy entry. Personal has 8
   secret consumers in `home.mcp.extraServers`; design phase
   confirms all 8 servers are intentional inclusions in the personal
   mcpproxy inventory, not leftovers.

## 7. Preferred Direction (for Design Phase)

- **Single coordinated cutover** as committed in the brief.
- **Schema preservation** (Decision 1A): keep `home.mcp.extraServers`
  attrset-shaped; translate inside the orchestrator module's
  renderer.
- **Helper preservation** (Decision 2A): replace
  `readKeychainSecret`'s body with `${keyring:<name>}` emission;
  leave call sites untouched.
- **SOPS-managed API key** (Decision 3A): adopt
  `mcpproxy-api-key` as a new secret in the existing bridge.
- **Tag pinning at `v0.33.1`** (Decision 4A): follow repo convention.
- **`nix-config-secrets` neutral account name** (Decision 5A) for
  sqlite-backup.
- **Global quarantine disabled** (Decision 6A).
- **Manifest-driven sqlite-backup account** (Decision 7A).

Risk concentration: Decision 3 (API key) and the agent-prompt
rewrite (R4). The first is single-file but has a one-shot Keychain
migration cost; the second is wide and benefits from a deliberate
authoring pattern committed in design before any task starts work.

---

# Synthesis Appendix (Design Phase)

Synthesis outcomes recorded per `design-synthesis.md` before writing
`design.md`. The gap analysis above (Sections 1-7) is the discovery
input; this appendix captures the synthesis lenses (generalization,
build-vs-adopt, simplification) and formalizes the design decisions
that `design.md` commits to.

## Generalization Findings

- **Single mcpproxy health-probe pattern** consumed by FOUR sites:
  the opencode wrapper (R8), the cavemem wrapper (R7+R8), the
  memory-sync CLI (R9), and the `restart-mcpproxy` helper (R1.5
  indirectly via failure recovery). Rather than four divergent
  curl-and-grep snippets, the design commits to a single shared
  probe shape: `GET /healthz` for liveness (no auth) plus
  `GET /api/v1/servers/<name>` for per-upstream connection state
  (API-key-authenticated). The probe shape is encoded once in the
  module and consumers reuse it; if mcpproxy's API moves later, one
  place changes.

- **Single keychain account+migration pattern** consumed by TWO
  pathways: MCP secrets (R5+R6) and sqlite-backup secrets (R12).
  Both move to mcpproxy-era layouts in the same activation pass,
  and both delete legacy `-a mcp-hub` entries in the same cleanup.
  The activation script is generalized to handle both manifests
  rather than introducing a second activation script.

- **Single agent-prompt rewrite pattern**: every direct
  `hub_<server>__<tool>(...)` call becomes a 2-step
  `retrieve_tools` + `call_tool_*` pair. The pattern is documented
  once (in agents.md), referenced by all subagents, and applied
  identically to the 109 occurrences across 7 files. Subagent
  allowlists shift from "tool name prefix" to "upstream server name"
  (e.g. `vault-synthesizer.md`'s negative list of `hub_buildkite__*`
  becomes "tools from servers other than obsidian and cavemem").

## Build-vs-Adopt Decisions

| Concern | Decision | Rationale |
|---|---|---|
| MCP orchestrator binary | **Adopt** mcpproxy-go v0.33.1 | Vetted upstream; active maintenance; MIT license; no CGO required |
| Go packaging pattern | **Adopt** existing `buildGoModule` + `vendorHash` + `tag` from `buildkite-mcp-server`/`slack-mcp-server` | Repo convention; tag-pinned; reproducible |
| SOPS → Keychain bridge | **Adopt** existing `mcp-secrets-activate.nix` + `mcp-verify-secrets.nix` (modified) | Bridge mechanics are sound; only the keychain layout shape changes |
| Keychain placeholder mechanism | **Adopt** mcpproxy's native `${keyring:<name>}` syntax | Built-in; reflective expansion across all string fields; reads via OS-native `security` API |
| Quarantine workflow | **Adopt + disable globally** via `quarantine_enabled: false` | Single-operator setup; no need for per-server quarantine machinery; lowest config ceremony |
| Restart helper pattern | **Adopt** existing `pkgs.writeScriptBin` + `launchctl kickstart` shape | Identical to current `restart-mcp-hub`; only label and script name change |
| API key | **Adopt** SOPS-bridged secret (`mcpproxy-api-key`) referenced via `${keyring:mcpproxy-api-key}` | Keeps Nix-store immutability; aligns with existing 13-secret bridge pattern |
| Agent retrieve_tools idiom | **Adopt** mcpproxy's documented 2-step `retrieve_tools` + `call_tool_*` pattern | Native to mcpproxy; no custom adapter layer needed |

No build-from-scratch components in this spec.

## Simplification Decisions

- **No new HM module abstraction.** Rewrite `home-manager/mcp/default.nix`
  in place; do not introduce a wrapper layer (e.g. "mcpproxy-adapter")
  for a one-step migration.
- **No service-registry abstraction for keychain accounts.**
  Sqlite-backup's keychain account is already manifest-driven on the
  verify side; the cli side is the only inconsistency. Unify on
  manifest-driven (cli reads via `jq` from the manifest), no new
  registry needed.
- **No per-server quarantine state.** Global
  `quarantine_enabled: false` suffices; per-server `quarantined`
  / `skip_quarantine` fields are omitted from rendered config.
- **No custom logging pipeline.** mcpproxy's `--log-to-file=false`
  flag + launchd `StandardOutPath`/`StandardErrorPath` is the single
  log source.
- **No shared `wrapperProbe` HM helper.** The opencode and cavemem
  probes share a pattern but are emitted as separate snippets per
  their respective modules; introducing a new HM helper option to
  DRY them is premature abstraction for two call sites. The pattern
  is documented once in design.md and applied twice in code.
- **No new flake input for mcpproxy.** Package via
  `fetchFromGitHub` inside the overlay derivation (matches
  buildkite-mcp-server / slack-mcp-server pattern). Removes the
  need to add a fresh flake input alongside removing the two mcphub
  ones.
- **No standalone migration script.** Keychain layout migration is
  performed by the modified `mcp-secrets-activate.nix` (the same
  script that writes the new layout also deletes legacy entries).
  No new "one-shot migrator" derivation.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks | Notes |
|---|---|---|---|---|
| In-place rewrite of orchestrator module | Replace `home-manager/mcp/default.nix` body; keep option-surface API stable where possible | Smallest diff; preserves the 15 cross-host call sites; one cutover commit | Schema-shape change for `extraServers` requires internal translator; large single change to one critical module | Selected |
| Sidecar module (mcpproxy alongside mcphub) | Add new `home-manager/mcpproxy/default.nix`; deprecate mcp/ over time | Lower coupling; rollback-friendly | Contradicts user's confirmed Approach 2 (clean-cut); creates two MCP orchestrators temporarily; 18 GB/day log bloat keeps biting | Rejected: parallel-run option rejected at brief |
| Full module API redesign | Re-type `extraServers`, rename helpers, fresh option surface | Cleanest end-state | Breaks every consumer in this spec; out of scope per brief; deferred refactor | Rejected: out of scope |

Selected pattern: **in-place rewrite of the orchestrator module**,
with internal schema translation preserving the
`home.mcp.extraServers` attrset shape and the
`home.mcp.readKeychainSecret` helper interface (Decisions 1A and 2A
from the gap analysis).

## Design Decisions (formal record)

### Decision: Pin mcpproxy-go to tag v0.33.1
- **Context**: Brief said "pin commit not tag"; repo convention is
  tag-pinning (`buildkite-mcp-server`, `slack-mcp-server`).
- **Alternatives**: bare commit SHA `1356c60`; release tag
  `v0.33.1`; tracking `main`.
- **Selected**: tag `v0.33.1` (commit `1356c60`).
- **Rationale**: tag-pin matches repo convention; tag is immutable
  on GitHub; functionally equivalent to commit-pin for the
  schema-stability concern the brief flagged.
- **Trade-offs**: bare-commit would also work; tag is more
  human-readable.
- **Follow-up**: re-validate when v0.34.x appears (config schema
  may break additively).

### Decision: Preserve `home.mcp.extraServers` attrset shape
- **Context**: mcpproxy expects an array; current shape is
  `attrsOf attrs`.
- **Alternatives**: re-type to list of submodules; break call sites.
- **Selected**: keep attrset; module-internal translator converts
  to array at render time.
- **Rationale**: preserves all cross-host call sites (15 readers);
  one-line internal helper; minimal blast radius.
- **Trade-offs**: nominal divergence from mcpproxy's native schema;
  stricter Nix typing deferred to a later refactor.
- **Follow-up**: document the translator in the module's header
  comment so future readers know where the attrset→array conversion
  happens.

### Decision: Preserve `home.mcp.readKeychainSecret` helper
- **Context**: 15 call sites consume the helper; current body emits
  the mcphub-specific `${cmd:...}` shape.
- **Alternatives**: remove helper + rewrite each call site; rename
  helper to something more accurate.
- **Selected**: keep the helper option and its name; replace its
  body with `"\${keyring:" + name + "}"`.
- **Rationale**: zero call-site edits; rename can come in a future
  cleanup if desired.
- **Trade-offs**: the name `readKeychainSecret` now misleadingly
  implies it READS at module eval; in fact it emits a placeholder
  that mcpproxy resolves at server-spawn time. Acceptable; the
  helper's docstring will clarify.
- **Follow-up**: update docstring in `home-manager/mcp/default.nix`.

### Decision: SOPS-bridged API key (`mcpproxy-api-key`)
- **Context**: mcpproxy auto-generates and persists an API key back
  to the config file; Nix-store config is immutable.
- **Alternatives**: writable config layout under `~/.mcpproxy/`;
  disable auth-required endpoints entirely.
- **Selected**: add a new SOPS secret `mcpproxy-api-key` (random
  256-bit hex), surface to Keychain via the existing bridge,
  reference via `${keyring:mcpproxy-api-key}` in the `api_key`
  field of `mcp_config.json`.
- **Rationale**: keeps everything Nix-deterministic; reuses the
  bridge we're already touching; no mutable-config-file
  complication.
- **Trade-offs**: adds one row to the SOPS secret list and one
  manifest entry; operator must populate `mcpproxy-api-key` in
  SOPS before activation.
- **Follow-up**: document the key generation procedure
  (`openssl rand -hex 32` then `sops edit secrets/mcp.<host>.yaml`)
  in `secrets/README.md` (R13).

### Decision: Neutral keychain account name `nix-config-secrets`
- **Context**: sqlite-backup secrets currently piggyback on the
  `mcp-hub` keychain account.
- **Alternatives**: `dwsr-secrets`, `darwin-secrets`,
  `nix-config-secrets`.
- **Selected**: `nix-config-secrets` (matches the brief's
  placeholder).
- **Rationale**: descriptive; orthogonal to MCP storage backend
  choice; future-proof against further orchestrator changes.
- **Trade-offs**: none material.
- **Follow-up**: ensure activation cleans up legacy `-a mcp-hub`
  entries for sqlite-backup secrets in the same pass as MCP
  secrets.

### Decision: Global quarantine disabled
- **Context**: mcpproxy auto-quarantines new servers by default;
  requires manual approval otherwise.
- **Alternatives**: per-server `skip_quarantine: true`; global
  disable.
- **Selected**: global `quarantine_enabled: false`.
- **Rationale**: single-operator setup; all servers in the
  configuration are operator-trusted; no per-server quarantine
  state needed.
- **Trade-offs**: cannot selectively quarantine a future server
  without flipping the global flag. Acceptable.
- **Follow-up**: if a future server should be quarantined, flip
  to per-server scheme.

### Decision: Manifest-driven sqlite-backup keychain account
- **Context**: `scripts/sqlite-backup-cli.nix` hardcodes
  `KEYCHAIN_ACCOUNT=mcp-hub`; `sqlite-backup-verify.nix` reads from
  manifest. R12 forces alignment.
- **Alternatives**: keep cli hardcoded; unify on manifest-driven.
- **Selected**: cli reads the account name from the manifest at
  runtime via `jq` (matching the verify script).
- **Rationale**: single source of truth; future renames need no
  cli edits.
- **Trade-offs**: one more `jq` invocation per cli start
  (negligible).
- **Follow-up**: smoke-test sqlite-backup operations after the
  rename to confirm jq path resolution.

### Decision: Startup gate uses 4 calls (2 retrieve + 2 invoke)
- **Context**: Current AGENTS.md startup gate makes 2 direct
  `hub_*` calls. Migrating to retrieve_tools mode doubles the call
  count.
- **Alternatives**: collapse into one combined retrieve_tools query
  ("obsidian list-notes cavemem list_sessions"); skip retrieve_tools
  for the gate by hardcoding tool names.
- **Selected**: emit two `retrieve_tools` + two `call_tool_read`
  pairs (4 calls total).
- **Rationale**: matches the documented retrieve_tools idiom;
  confirms both server availability AND the agent's ability to
  invoke through the proxy.
- **Trade-offs**: 4 round-trips at session start instead of 2.
  Negligible.
- **Follow-up**: if startup latency becomes a concern, revisit.

### Decision: Single curated launchd PATH inherits gcloud-sdk + git-lfs
- **Context**: Current mcp-hub launchd plist supplements PATH with
  `google-cloud-sdk` and `git-lfs` (required by gcloud-mcp and
  github-mcp-server respectively).
- **Alternatives**: drop the supplementation (breaks downstream
  servers); add more entries (over-broad).
- **Selected**: replicate the exact PATH supplementation in
  mcpproxy's launchd plist.
- **Rationale**: behavior preservation; downstream servers MUST
  continue to find their tools.
- **Trade-offs**: cross-cuts spec ownership (PATH supplementation
  is for spawn-time servers, not mcpproxy itself); acceptable since
  mcpproxy is the spawn driver.
- **Follow-up**: if a new upstream server needs a new PATH entry,
  add it here (single source of truth).

## Risks & Mitigations (post-discovery refresh)

- **R: mcpproxy schema break in v0.34.x.** Mitigation: tag pin at
  v0.33.1; revalidate before bumping.
- **R: Agent prompt rewrite regression breaks startup gate.**
  Mitigation: include the gate as part of R14 acceptance evidence;
  do not declare done without an end-to-end fresh-session test on
  each host.
- **R: Keychain migration is one-shot; failure leaves a host in a
  hybrid state.** Mitigation: activation script writes new entries
  BEFORE deleting old ones (already the order in the existing
  script). If write fails, old entries are preserved; if delete
  fails after write, host has duplicate entries (mcpproxy reads
  from the new, sqlite-backup is unaffected; manual cleanup possible).
- **R: `mcpproxy-api-key` not populated in SOPS before activation.**
  Mitigation: activation defensive guard (already exists per
  `mcp-secrets-activate.nix` L121-137) catches missing
  `/run/secrets/mcpproxy-api-key` and aborts with named path.
- **R: `mcphub.nvim` removal breaks codecompanion.** Mitigation:
  codecompanion's MCP wiring lives in two delimited blocks (L15-25,
  L43-58); strip exactly those; full codecompanion test post-strip
  (open chat, send a non-MCP message) is part of R11.5 acceptance.
- **R: Personal-host's additional MCP servers (kagi, fastmail,
  beeper, hangops, etc.) lose secrets in the bridge rewrite.**
  Mitigation: the bridge is generic over secret names; all 8
  personal-host secret references go through the same axes swap.
  No per-secret special handling needed.

## References

- `brief.md` — discovery context, locked architectural choices.
- `requirements.md` — 14 EARS requirements + Boundary Context.
- Sections 1-7 of this file — gap analysis (sub-agent inventory +
  mcpproxy internals).

---

# Gap Analysis Addendum: Home Manager Config Ownership Protection

Date: 2026-05-22T17:39:16Z

Requirements approval warning: `spec.json` currently has
`approvals.requirements.approved = false`; this analysis proceeds because
gap validation can inform design and requirement revisions. Core steering
files `product.md`, `tech.md`, and `structure.md` are not present under
`.kiro/steering/`; roadmap context was used instead.

## 1. Current State Investigation

### Implemented migration surface

The working tree already contains most of the migration implementation:

- `pkgs.mcpproxy-go` exists as a `buildGoModule` package in
  `overlays/mcp-servers.nix`.
- `home-manager/mcp/default.nix` renders the mcpproxy config and owns the
  launchd agent. The Home Manager-owned config path is
  `xdg.configFile."mcpproxy/mcp_config.json"` (`home-manager/mcp/default.nix:407-410`).
- The launchd agent invokes `mcpproxy-launchd-wrapper serve` and passes
  `--config=${XDG_CONFIG_HOME}/mcpproxy/mcp_config.json` directly to
  mcpproxy (`home-manager/mcp/default.nix:419-447`).
- The wrapper reads Keychain and file-sourced secrets, exports them as env
  vars, and `exec`s mcpproxy (`home-manager/mcp/default.nix:177-225`).
- The secret bridge routes MCP secrets to service `mcpproxy` and
  sqlite-backup secrets to service `nix-config-secrets`, then deletes legacy
  `-a mcp-hub` entries after the write phase
  (`scripts/mcp-secrets-activate.nix:179-288`).
- Opencode, cavemem, and memory-sync probes use `GET /api/v1/servers` and
  filter the collection because mcpproxy v0.33.1 does not support read-side
  `GET /api/v1/servers/{id}` (`home-manager/common/opencode.nix:142-147`,
  `home-manager/common/cavemem.nix:509-514`, `scripts/memory-sync.nix:697-708`).
- Cavemem is registered via `home.mcp.extraServers.cavemem` and the direct
  opencode local-MCP route is documented as removed
  (`home-manager/common/cavemem.nix:380-447`).

### Newly identified gap

Requirement 15 is not satisfied by the current launchd configuration. The
daemon still receives the Home Manager-owned config path directly
(`home-manager/mcp/default.nix:433-435`). The current protection only passes
`--allow-server-add=false` and `--allow-server-remove=false`; the module
comment explicitly says other management features remain available
(`home-manager/mcp/default.nix:437-446`).

Runtime research found additional write paths:

- `mcpproxy serve --help` exposes `--read-only` and `--disable-management`,
  but the current service starts with both false.
- Startup cleanup always inspects the configured path for deprecated fields
  and can create `<config>.bak` before modifying it.
- `SaveConfig` uses temp-file + rename with mode `0600`, which can replace a
  Home Manager symlink with a regular file.
- The current local `.bak` contains the resolved top-level API key. Treat
  runtime config copies and backups as secret-bearing artifacts.

### Stale spec/design assumptions to correct in design

- Older design text still assumes mcpproxy can safely consume
  `${keyring:<name>}` placeholders for the top-level API key. Current code
  uses `${env:NAME}` placeholders plus a launchd wrapper because top-level
  `api_key` was loaded before mcpproxy's secret-resolution pipeline
  (`home-manager/mcp/default.nix:177-199`).
- Older design text assumes read-side `GET /api/v1/servers/{id}` exists;
  current code correctly uses `GET /api/v1/servers` collection filtering.
- `secrets/README.md` still says mcpproxy `${keyring:<account>}` placeholders
  resolve under the stable service name (`secrets/README.md:30-35`), which
  conflicts with the wrapper/env contract now used for the daemon.

## 2. Requirement-to-Asset Map

| Req | Current assets | Gap / status |
|---|---|---|
| 1 | mcpproxy package, launchd label, logs, restart helper in `home-manager/mcp/default.nix` | Mostly implemented; runtime loaded-service evidence still required. |
| 2 | Base servers, `extraServers`, env propagation, global quarantine off | Static assets present; connected-status evidence remains runtime-only. |
| 3 | `routing_mode = "retrieve_tools"`; no `tools_limit` override | Verify live MCP `tools/list` still exposes exactly four tools. |
| 4 | Agent prompts migrated; only explanatory `hub_` text remains in AGENTS.md | Verify rendered prompts and fresh startup gate. |
| 5 | Wrapper/env secret flow and SOPS bridge new layout | Implemented; README/design wording needs alignment. |
| 6 | Write-then-delete legacy cleanup in activation script | Implemented; one-shot host activation evidence still required. |
| 7 | Cavemem via `home.mcp.extraServers.cavemem`; direct route removed | Implemented; fresh-session evidence still required. |
| 8 | Opencode wrapper probes mcpproxy liveness + obsidian status | Implemented; keep collection endpoint pattern. |
| 9 | Memory-sync probes mcpproxy collection endpoint | Implemented; exit-code acceptance evidence remains. |
| 10 | Both host configs point opencode at local mcpproxy | Implemented; rendered config/e2e route evidence remains. |
| 11 | Nvim MCP teardown appears static-complete | Need nvim launch smoke evidence. |
| 12 | `nix-config-secrets` routing and sqlite manifest integration | Implemented; sqlite-backup command smoke evidence remains. |
| 13 | Most docs updated | `secrets/README.md` still has stale keyring-placeholder wording. |
| 14 | Probe pieces exist | Full clean activation/fresh opencode/memory-sync/darwin check evidence remains. |
| 15 | Only add/remove flags exist | Missing: isolate mcpproxy startup cleanup and runtime persistence from the HM-owned config path. |

## 3. Implementation Approach Options

### Option A: Extend the existing launchd wrapper with a runtime config copy

Before `exec`, copy the Home Manager-rendered config into a private
user-owned runtime path, validate the copy, then invoke mcpproxy with
`--config=<runtime-copy>`. Copy on every managed start so the latest Home
Manager generation remains the source for the effective runtime config.

- **Pros**: Minimal surface; preserves current secret wrapper; directly
  satisfies R15.1-R15.4; mcpproxy can still write its own effective runtime
  config without touching the HM symlink.
- **Cons**: Wrapper grows; the runtime copy and `.bak` must be treated as
  secret-bearing; runtime UI/API changes are either ephemeral or become an
  imperative shadow depending on chosen path lifecycle.
- **Complexity**: S-M. **Risk**: Medium.

### Option B: Add a dedicated runtime-config preparation helper

Factor config-copy, permissions, validation, and cleanup into a small helper
script or shell function invoked by the wrapper.

- **Pros**: Cleaner test boundary; reusable by manual diagnostics; easier to
  unit-test failure messages.
- **Cons**: Adds another derivation/interface; may be more structure than this
  one gap needs.
- **Complexity**: M. **Risk**: Medium.

### Option C: Rely on mcpproxy flags only

Add `--read-only` and/or `--disable-management` to the existing launchd args,
possibly alongside the existing add/remove flags.

- **Pros**: Smallest code change if upstream flags cover every write path.
- **Cons**: Local source research indicates management-tool gating and HTTP
  add/remove/patch persistence do not map cleanly; startup cleanup still
  touches the configured path. This is unlikely to satisfy R15 alone.
- **Complexity**: S. **Risk**: High if used as the only mitigation.

### Option D: Filesystem immutability or permissions

Protect `~/.config/mcpproxy/mcp_config.json` with macOS flags, root ownership,
or read-only permissions.

- **Pros**: Blocks writes bluntly in emergencies.
- **Cons**: Explicitly out of scope under R15.6; can break Home Manager
  activation and mcpproxy startup; not a declarative solution.
- **Complexity**: S. **Risk**: High. Not a design candidate except as manual
  recovery context.

## 4. Integration Challenges

- The runtime copy must be refreshed on each managed start to satisfy R15.3;
  a persistent copy that drifts from Home Manager would reintroduce imperative
  config ownership.
- The copy target must not be world-readable. Even though the rendered config
  uses env placeholders, mcpproxy backups can contain the resolved API key
  after startup cleanup or persistence.
- The wrapper must fail before `exec` when preparation fails, using the
  existing `mcpproxy-launchd-wrapper:` stderr style
  (`home-manager/mcp/default.nix:212-216`).
- Acceptance needs an explicit symlink-preservation check: after restart and
  after a mcpproxy operation that previously rewrote config, the HM path
  remains a symlink or HM-managed file and no `.bak` appears beside it.
- Updating design must reconcile previous post-activation fixes: env-wrapper
  secrets, collection endpoint probes, and add/remove flag limitations.

## 5. Research Needed for Design

1. Choose runtime-copy path and lifecycle. Candidate: a private path under
   `~/.mcpproxy/` or `XDG_RUNTIME_DIR` with mode `0600`. Avoid `/tmp`.
2. Decide whether to delete stale runtime-copy `.bak` files on each wrapper
   start, keep them for diagnostics, or rotate them. Security favors cleanup.
3. Decide whether to also pass `--read-only` or `--disable-management` as an
   additive hardening measure. This requires checking whether any retained
   mcpproxy functionality depends on management writes.
4. Update stale design/research sections before task generation so implementers
   do not follow obsolete `${keyring:...}` or per-server GET guidance.

## 6. Preferred Direction for Design Consideration

Option A is the strongest fit for R15 because it protects the declarative
source without requiring upstream patches or manual filesystem flags. Option B
is worth considering if design wants a separately testable helper. Options C
and D are insufficient as primary strategies.

## 7. Design Synthesis Addendum

### Generalization Findings

- The existing `mcpproxy-launchd-wrapper` is already the single runtime
  preparation boundary for Keychain secrets and file-sourced env vars. Config
  ownership protection is the same kind of pre-exec concern, so it should be
  added to that wrapper rather than creating a second launch path.
- The same prepared-runtime-config contract covers startup cleanup,
  save-configuration persistence, and backup-file generation. Design only needs
  one invariant: mcpproxy never receives the Home Manager-owned config path.

### Build vs. Adopt

- Adopt the platform's existing shell/runtime primitives (`install`, `mktemp`
  or equivalent, mode `0600`, fail-fast stderr) instead of adding a new tool or
  upstream patch.
- Keep upstream mcpproxy unpatched. The wrapper treats mcpproxy's config writes
  as expected runtime behavior and moves the mutable target away from the
  declarative source.

### Simplification

- Do not add a new helper derivation unless task implementation discovers that
  shell-level validation is too large for the existing wrapper. The current
  design keeps the change in `home-manager/mcp/default.nix`.
- Do not make `--read-only` / `--disable-management` the primary fix. They may
  be considered hardening later, but they do not address startup cleanup writes
  to the configured path.
- Do not use filesystem immutability. It conflicts with R15.6 and Home Manager
  activation semantics.

### Design Decision: Runtime config copy selected

- **Context**: mcpproxy writes and backs up the configured path during startup
  cleanup and runtime persistence; the current launchd service passes the
  Home Manager-owned config path directly.
- **Alternatives considered**: extend existing wrapper, add dedicated helper,
  rely on mcpproxy flags, filesystem immutability.
- **Selected approach**: extend the existing wrapper to copy the HM-rendered
  config to a private runtime path on every managed start, then pass that copy
  as `--config`.
- **Rationale**: satisfies R15 with the smallest boundary change and preserves
  the existing wrapper's secret-export flow.
- **Trade-offs**: the runtime copy and `.bak` files must be treated as
  secret-bearing because mcpproxy can persist the resolved API key.
