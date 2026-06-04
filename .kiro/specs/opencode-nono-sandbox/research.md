# Implementation Gap Analysis — 2026-06-02

## Status

Requirements are generated but not approved. This analysis proceeds so design can
revise requirements or choose an implementation strategy with current codebase
evidence.

Core steering files `product.md`, `tech.md`, and `structure.md` are absent.
Relevant steering loaded: `.kiro/steering/roadmap.md`,
`.kiro/steering/rtk-install.md`, and `.kiro/steering/session-compaction.md`.

## Current State Investigation

### OpenCode launch and configuration

- `home-manager/common/opencode.nix` owns the shared OpenCode package wrapper:
  `home.opencode.package` defaults to `pkgs.opencode-pinned`,
  `home.opencode.wrapperCommands` composes shell snippets, and
  `programs.opencode.package` is a `symlinkJoin` + `wrapProgram` wrapper.
- The wrapper currently runs mcpproxy/obsidian preflight, exports LSP-related
  variables, and suffixes configured LSP packages onto `PATH`.
- The login prewarm agent invokes the unwrapped `${config.home.opencode.package}`
  binary for `opencode --version`; sandbox requirements should explicitly decide
  whether this stays outside nono.
- Personal host config adds caveman style and remote mcpproxy MCP routing.
- Shopify host config adds provider proxy setup through `devx llm-gateway`,
  `OPENCODE_SESSION_ID`, broad OpenCode permissions, Shopify usage tags, and
  mcpproxy routing.

### Existing rollout patterns

- `home-manager/common/opencode-rtk.nix` is the closest module pattern:
  feature-specific enable option, package option, metadata render, operator
  guide, smoke-test package, wrapper env resolver, runtime override, usage tag,
  and peer assertion requiring `programs.opencode.enable`.
- `tests/rtk-opencode/hm-render.test.js` evaluates both hosts, asserts rendered
  metadata/guide/package/smoke wiring, exercises wrapper resolver logic, and
  guards against session-history writes.
- `scripts/rtk-opencode-smoke-test.nix` and
  `scripts/rtk-opencode-validate.nix` provide the failure-label pattern:
  `[smoke-test-failure: <label>]` and `[validate-failure: <label>]`.
- `flake.nix` already has app/check wiring for `rtk-opencode-validate`,
  RTK tests, OpenCode package checks, and host evaluation checks.

### Existing audit/data sources

- `scripts/opencode-cost-report.js` exports `SqliteReader` and related helpers.
  `SqliteReader.open()` uses read-only `better-sqlite3` with `fileMustExist` and
  fails loudly on migration-set drift.
- `SqliteReader` already iterates root sessions, descendant sessions, session
  messages, and session parts. `partsOfSession()` synthesizes `part.type` from
  the JSON payload because the live OpenCode schema stores type inside `data`.
- The tokenizer code already extracts tool output from `data.state.output` and
  tool names from `data.name` or `data.tool`, which is useful evidence for a
  first-pass observed-tool inventory.
- `home-manager/common/opencode-plugins/cavemem.js` captures
  `tool.execute.before` arguments and `tool.execute.after` outputs as
  `post-tool-use` events with `tool_name`, `tool_input`, and `tool_response`.
- `home-manager/common/cavemem.nix` pins `home.cavemem.dataDir`, registers the
  cavemem upstream through mcpproxy, and appends a cavemem mcpproxy preflight to
  `home.opencode.wrapperCommands`.
- `scripts/subagent-context-budget.js` has a deterministic JSON/Markdown audit
  report pattern: stable key ordering, validated metadata input, and explicit
  “absent” rather than inferred observed data.

### External nono facts relevant to design

- nono documents `nono run --profile opencode -- opencode` as the OpenCode
  launcher.
- The built-in `opencode` profile grants working-directory read/write,
  OpenCode config/cache/data paths, OpenTUI data, `/tmp`, and network.
- Profiles are JSON/JSONC. `nono profile schema`, `profile validate`,
  `profile show`, `profile diff`, and `run --dry-run` are the relevant validation
  and introspection commands.
- `groups.include` is canonical. Legacy `policy`/`security` placements and
  `commands.deny` are compatibility/deprecated surfaces and should not be the
  design baseline.
- Environment filtering is default-allow unless `environment.allow_vars` or
  `deny_vars` is set. `env_credentials` bypass filtering by design.
- Audit recording is on by default; rollback and filesystem-state hashing are
  opt-in.
- macOS uses Seatbelt; domain filtering and credential proxying rely on nono's
  supervised proxy. Unix socket connects can require explicit socket grants under
  restricted network modes.
- The current flake input reports `pkgs.nono` as `missing` on this aarch64-darwin
  host via `nix eval`; packaging availability is not guaranteed by current repo
  inputs even though docs say nixpkgs has `nono`.

Sources:
- https://nono.sh/docs/cli/clients/opencode.md
- https://nono.sh/docs/cli/features/profiles-groups.md
- https://nono.sh/docs/cli/features/profile-authoring.md
- https://nono.sh/docs/cli/features/profile-introspection.md
- https://nono.sh/docs/cli/features/environment.md
- https://nono.sh/docs/cli/features/credential-injection.md
- https://nono.sh/docs/cli/features/audit.md
- https://nono.sh/docs/cli/internals/seatbelt.md
- https://nono.sh/docs/cli/getting_started/installation.md

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap classification |
|-------------|-----------------|--------------------|
| R1 Declarative enablement | `opencode.nix` wrapper, RTK module pattern, common module imports | **Missing**: nono module/package/outer launcher; **Constraint**: avoid self-referential wrapper loops |
| R2 Profile catalog | nono built-in profile docs; HM `xdg.configFile` patterns; RTK metadata render | **Missing**: repo-managed profiles, metadata schema, validation checks |
| R3 Historical usage audit | `SqliteReader`, cost fixtures/tests, cavemem plugin data | **Missing**: observed-capability model; **Unknown**: exact cavemem DB schema/query path for local audit |
| R4 Compatibility assessment | deterministic audit pattern in `subagent-context-budget.js` | **Missing**: profile-grant parser, capability comparator, warning/blocker taxonomy |
| R5 Rollout controls | RTK `OPENCODE_RTK` resolver and validate script | **Missing**: nono state resolver, per-launch override, strict-mode report freshness check |
| R6 Credentials/network | Shopify provider wrapper, mcpproxy/cavemem preflight, nono env/network docs | **Constraint**: do not serialize secrets; **Unknown**: whether provider routes can use proxy credential injection |
| R7 Coexistence | RTK, cavemem, session-compaction, subagent-context-budget plugins and wrapper env | **Constraint**: wrapper ordering and sandbox grants must preserve existing preflight/plugin behavior |
| R8 Validation/guidance | RTK smoke/validate pattern, flake check structure, operator steering docs | **Missing**: nono smoke test, profile validation derivation, operator guide, flake checks/apps |

## Integration Challenges

- **Outer wrapper seam**: current `home.opencode.wrapperCommands` runs inside the
  OpenCode wrapper. nono needs to wrap the final managed OpenCode launch while
  preserving those commands inside the sandboxed process. Design likely needs a
  small explicit inner/outer wrapper seam in `opencode.nix`.
- **Package availability**: current inputs do not expose `pkgs.nono`; design must
  decide whether to update nixpkgs, add an overlay package, or use a temporary
  non-Nix escape hatch. A Homebrew dependency would violate the declarative
  source-of-truth constraint unless treated as explicitly out-of-band.
- **Host-specific behavior**: Shopify provider setup uses `devx`, Keychain/API
  token retrieval, localhost/mcpproxy, provider proxy base URLs, and usage-tag
  env substitution. Profiles may need host-specific grants and labels.
- **Audit fidelity**: OpenCode SQLite has structured session/part data but not a
  guaranteed path/socket/network/env model. Cavemem has richer tool inputs but
  can be unavailable, compressed, or schema-different.
- **Secret redaction**: tool inputs/responses can contain credentials, headers,
  URLs, or environment values. Audit reports must redact by default and avoid
  storing raw secret-bearing payloads in generated files.
- **False compatibility**: absence of historical evidence is not proof that a
  profile is safe. Unknown findings must remain unknown.
- **macOS sandbox behavior**: network filtering, localhost ports, Unix sockets,
  TCC, Keychain, and Go CLI proxy trust require validation on the target hosts.

## Implementation Approach Options

### Option A: Extend existing OpenCode module directly

Add nono package/profile/wrapper/audit options directly to
`home-manager/common/opencode.nix`.

Pros:
- Minimal module indirection.
- Direct access to the existing wrapper construction.
- Fastest initial wiring.

Cons:
- Bloats the central OpenCode module.
- Harder to disable/remove independently.
- Couples sandbox profile/audit concerns to base OpenCode config.

Effort: M. Risk: Medium due wrapper self-reference and file-size growth.

### Option B: New `programs.opencode-nono` module

Create `home-manager/common/opencode-nono.nix` for package install, profile
rendering, metadata, operator guide, smoke/validate packages, host defaults, and
audit CLI. Integrate through existing module imports and host options.

Pros:
- Clear responsibility boundary.
- Mirrors RTK rollout/testing pattern.
- Easier to test metadata/profile/audit surfaces independently.

Cons:
- Still needs a small change in `opencode.nix` to expose a safe outer launcher
  seam.
- More files and interfaces to define.

Effort: L. Risk: Medium because nono profile semantics and package availability
remain external dependencies.

### Option C: Hybrid module plus narrow OpenCode wrapper seam

Add only the minimum needed wrapper-extension seam to `opencode.nix`; keep all
nono-specific state in a new module and new audit CLI.

Pros:
- Preserves base OpenCode module simplicity.
- Avoids self-reference by making inner/outer package roles explicit.
- Fits existing RTK, cost-diagnosis, and subagent-context-budget patterns.
- Supports phased rollout: disabled → compatibility-audit → enforced.

Cons:
- Requires careful design of the new seam before implementation.
- More up-front design work than direct extension.

Effort: L. Risk: Medium. This is the strongest candidate for design, but the
design phase should still validate the package and wrapper mechanics.

## Likely File Touches

- `home-manager/common/opencode.nix` — add explicit inner/outer wrapper seam or
  launcher hook.
- `home-manager/common/opencode-nono.nix` — new module for nono options,
  profiles, metadata, guide, packages, assertions, and wrapper resolver.
- `home-manager/common/default.nix` — import and enable the new module.
- `configurations/personal/home-manager/opencode.nix` — host default/profile
  selection.
- `configurations/shopify/home-manager/opencode.nix` — host default/profile
  selection and usage-tag/provider interaction.
- `overlays/misc.nix` or another overlay file — package nono if current inputs
  still lack it.
- `scripts/opencode-nono-audit.js` and `.nix` wrapper — new compatibility audit.
- `scripts/opencode-nono-smoke-test.nix` and/or
  `scripts/opencode-nono-validate.nix` — operator validation.
- `tests/opencode-nono/` — HM render tests, wrapper resolver tests, profile
  validation tests, audit fixtures, smoke/validate tests.
- `flake.nix` — app and check wiring.

## Design-Phase Research Items

1. Verify the exact `nono` version and profile schema available from the chosen
   package source on both target hosts.
2. Run `nono profile show opencode --json` on the packaged version and record
   its actual grants, including `$TMPDIR`, `~/.local/state/opencode`, network,
   and OpenTUI paths.
3. Decide whether managed profiles extend the built-in `opencode` profile or are
   rendered from `default` with explicit groups/grants.
4. Determine whether strict profiles should use unrestricted network,
   `network_profile`, explicit domains, localhost ports, or proxy credentials.
5. Determine which credentials can move to nono proxy injection and which must
   remain host-wrapper/env based. Gemini may require env credential injection.
6. Inspect cavemem's current SQLite schema or MCP export path for local
   read-only audit access.
7. Define the observed-capability model: tool name, command, path, URL/domain,
   localhost port, Unix socket, environment variable, confidence, and source.
8. Define redaction rules for audit reports before raw tool inputs/responses are
   serialized.
9. Validate macOS Seatbelt behavior for localhost TCP, Unix sockets, Keychain
   access, TCC-protected directories, and Go CLI proxy trust.
10. Decide whether rollback and filesystem audit integrity are default, opt-in,
    or profile-specific because of runtime/storage overhead.

## Recommendation for Design Phase

Carry Option C forward as the primary design candidate. It matches the repo's
existing pattern: small base-module seam, feature-specific Home Manager module,
metadata and operator guide under XDG config, deterministic Node audit CLI,
shell smoke/validate wrappers with named failure labels, and flake checks.

Do not decide strict profile grants until the design phase verifies the packaged
nono profile schema and produces an observed-capability model from OpenCode and
cavemem data.

---

# Design Phase Research — 2026-06-03

## Summary update

- **Discovery scope**: Complex Integration (extension of the existing OpenCode
  Home Manager stack).
- **Package decision flipped**: `nono` IS in nixpkgs unstable at `0.5.0`
  (Apache-2.0, `always-further/nono`, "kernel-enforced sandbox for AI agents").
  The earlier `pkgs.nono = missing` finding was the stable channel; the repo
  already consumes `unstable.*`. Design adopts `pkgs.unstable.nono` rather than
  packaging from source.
- **Profile schema verified current** against nono.sh docs (post-#594 canonical
  schema, post-v0.33.0 command-gating deprecation).

## Research Log

### nono packaging source
- **Context**: R1.1 needs `nono` available; gap analysis flagged it missing.
- **Sources**: `mcp-nixos nixos_info name=nono channel=unstable`; `overlays/default.nix` (`unstable` overlay), `overlays/misc.nix` (`opencode-pinned` built from `final.unstable.opencode`).
- **Findings**: `unstable.nono` = 0.5.0 is available on this host's overlay set. NixHub version-history lookup failed (network), so a hard version pin is deferred.
- **Implications**: `programs.opencode-nono.package` defaults to `pkgs.unstable.nono`; a future overlay pin is a one-line `package` override. No source build, no `vendorHash` dance.

### nono profile + launch contract (v0.5.0)
- **Sources**: nono.sh `/cli/clients/opencode`, `/cli/features/profiles-groups`, `/cli/features/environment`.
- **Findings**:
  - Launch: `nono run --profile <name> -- opencode`. CLI flags override profile (`--allow`, `--read`, `--block-net`, `--allow-domain`, `--open-port`, `--listen-port`, `--env-credential <key>`, `--bypass-protection`, `--allow-cwd`, `--dry-run`).
  - User profiles load from `~/.config/nono/profiles/*.json|*.jsonc` and override pack/preset profiles of the same name.
  - Schema sections: `meta{name,version,description}`, `extends`, `workdir.access` (none/read/write/readwrite), `groups{include,exclude}`, `filesystem{allow,read,write,deny,bypass_protection,unix_socket*,...}`, `network{block,network_profile,allow_domain,open_port,listen_port,credentials,upstream_proxy,...}`, `environment{allow_vars,deny_vars}`, `env_credentials{key:ENV}`, `session_hooks{before,after}`, `rollback`, `skipdirs`. `commands{allow,deny}` deprecated since v0.33.0 (not enforced on children) — not a design baseline.
  - Built-in `opencode` profile groups: `user_caches_*`, `node_runtime`, `opencode_linux`, `git_config`, `unlink_protection` + `default` groups; rw to `~/.config|.cache|.local/share/opencode`, `~/.local/share/opentui`, `/tmp`; network allowed; CWD rw.
  - `default` groups include `deny_credentials`, `deny_keychains_macos`, `deny_shell_configs`, `dangerous_commands*` (block `npm`/`git`-adjacent destructive cmds at startup only).
  - Env filtering precedence: built-in blocklist (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`…) > `deny_vars` > `allow_vars`. `env_credentials` bypass both. Default-allow when `environment` omitted.
  - Validation/introspection: `nono profile validate <path>`, `nono profile schema`, `nono profile show <name> --json` (resolved grants), `nono profile diff`, `nono profile init`, `nono run --dry-run`.
  - `session_hooks.before` runs OUTSIDE the sandbox with host privileges and can write `KEY=VALUE` to `$NONO_ENV_FILE` to inject env into the child — clean seam for host secret acquisition without putting secrets in profiles.
  - Gemini: proxy credential injection does NOT work; only `--env-credential`/`env_credentials` works.
- **Implications**: Managed profiles are rendered Nix attrsets → JSON under `~/.config/nono/profiles/`. Compatibility assessment should consume `nono profile show --json` rather than reimplementing nono's group composition.

### Keychain / localhost / devx conflict (audit-first driver)
- **Context**: The inner OpenCode wrapper preflight calls `/usr/bin/security find-generic-password -s mcpproxy` (macOS Keychain) and `curl http://127.0.0.1:8080`; Shopify host runs `devx llm-gateway` (Keychain/token + network) inside the wrapper.
- **Findings**: nono `default` groups include `deny_keychains_macos` and `deny_credentials` (some required, not excludable — only `filesystem.bypass_protection` per path). A restrictive enforced profile would block the Keychain read and possibly localhost IPC (`open_port` needed under restricted network modes).
- **Implications**: An enforced profile is NOT safe to default until the audit shows the exact Keychain paths, localhost ports, sockets, and env vars used. Confirms host `defaultState = disabled` for v1, with `bypass_protection`/`open_port`/`session_hooks`/`env_credentials` as the post-audit grant seams. This is the concrete justification for the audit-first rollout.

### Audit data sources (R3/R4/R9)
- **Sources**: `scripts/opencode-cost-report.js` exports (`SqliteReader`, `SchemaDriftError`, `SUPPORTED_MIGRATION_SET`); `home-manager/common/cavemem.nix`; `scripts/cavemem-import-vault.js`; `scripts/subagent-context-budget.js`.
- **Findings**:
  - `SqliteReader` is reusable read-only (`{readonly:true,fileMustExist:true}`, schema-drift gate). DB path: `OPENCODE_DB_PATH` else `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode-stable.db`. `require.main===module` guards CLI side effects, so `require()` is clean.
  - Tool evidence: tool NAME (`data.tool`||`data.name`) and tool OUTPUT (`data.state.output`) are reliably present in `part.data`. Tool ARGS (file paths, commands, URLs) live in `part.data` for tool-call parts but the arg sub-shape is NOT pinned anywhere — best-effort parse, mark confidence. Sockets/ports/env are pure text-inference (no structured field).
  - cavemem: local `${dataDir}/data.db` (v0.2.1 `data.db`), `observations(kind,content,ts,metadata,compressed)`; content is lossily compressed (~60% loss). The plugin captures richer `tool_input` in-flight but does not losslessly persist it. The audit is a standalone CLI (not an agent), so it CANNOT use the cavemem MCP surface; cavemem evidence = read-only `data.db`, version-guarded, best-effort.
  - Report pattern: `subagent-context-budget.js` gives stable-key-ordering + explicit `{kind:'observed'|'absent'}` + Result envelopes; `opencode-cost-report.js` `FileWriter` gives 0600 perms (`_withUmask(0o077)`), XDG-state placement, last-N retention.
  - No reusable JS redactor exists — build one in the audit.
- **Implications**: Audit CLI reuses `SqliteReader` via an env-injected lib path (`OPENCODE_NONO_COST_REPORT_LIB`, mirroring `OPENCODE_COST_PRICING_PATH`) and the `opencode-cost-diagnosis-deps` NODE_PATH tree (already ships `better-sqlite3`). Redaction is a new module, on by default (R3.7).

## Design Decisions

### Decision: Adopt `unstable.nono`, do not build from source
- **Alternatives**: (A) `buildGoModule` from `always-further/nono` source (mirror `rtk`); (B) consume `unstable.nono`.
- **Selected**: B, exposed via `programs.opencode-nono.package = pkgs.unstable.nono`.
- **Rationale**: Available, Apache-2.0, maintained; avoids `vendorHash` maintenance. The `package` option keeps a source-build/pin escape hatch.
- **Trade-offs**: unstable drifts; mitigate with the version-pin option + `nono profile schema` validation in checks.

### Decision: Outer launcher seam in `opencode.nix` (Option C hybrid)
- **Context**: nono must wrap the OUTERMOST launch so existing wrapper preflight/plugins run INSIDE the sandbox (brief approach).
- **Selected**: Refactor `opencode.nix` to expose `home.opencode.wrappedPackage` (current inner symlinkJoin, read-only/internal) and add `home.opencode.outerLauncher` (`functionTo package`, default identity). `programs.opencode.package = outerLauncher wrappedPackage`. `opencode-nono` sets `outerLauncher` to a launcher that resolves state and `exec`s `nono run --profile <eff> -- <inner>/bin/opencode "$@"`.
- **Rationale**: One new option + one changed line in `opencode.nix`; no circular reference (wrappedPackage←base+wrapperCommands; outerLauncher←wrappedPackage+nono). The login prewarm agent keeps invoking the UNWRAPPED `home.opencode.package`, so warmup stays outside nono (R8 noninteractive behavior).
- **Trade-offs**: The nono resolver lives in the outer launcher script (not `wrapperCommands`, which run inside the sandbox).

### Decision: Three-state model mapped to managed profiles
- **States** (host `defaultState`, per-launch `OPENCODE_NONO` override): `disabled` → exec inner directly (no nono); `audit` → `nono run --profile opencode-audit` (permissive, recording on); `enforced` → `nono run --profile opencode-managed` (restrictive). `OPENCODE_NONO_PROFILE` selects an explicit profile (e.g. `opencode-review` read-only). Invalid override → exit 1 listing accepted values (R5.3).
- **v1 host default**: `disabled` on both hosts (audit-first). R5.5 freshness warning fires if `enforced` is requested without a current compatibility report.

### Decision: Compatibility assessment consumes `nono profile show --json`
- **Rationale**: Adopt nono's own resolver for effective grants instead of reimplementing 32-group composition + `extends` + deny precedence. Build-vs-adopt → adopt.
- **Trade-offs**: Requires `nono` present for R4; the JSON shape is unverified upstream → defensive parser + implementation-time verification.

### Decision: Replacement review is advisory + operator ledger (R9)
- **Selected**: Audit ranks tool-use patterns and emits MCP-replacement
  candidates (seeded with git→Git-MCP), reading/writing a
  `opencode-nono-review-decisions.json` ledger the operator edits. The
  integration never changes OpenCode permissions or MCP registrations from this
  output (R9.7).
- **Rationale**: Keeps the decision human-owned; keeps the spec out of
  MCP-authorization scope.

### Decision: nono-native credential delivery, bridge-declarative provisioning
- **Context**: R6.2/R6.5 + the brief's "declarative, no imperative setup"
  constraint. The repo already standardizes secrets on a SOPS→1Password→macOS
  Keychain bridge: `mcp-sops-bridge.nix` + `scripts/mcp-secrets-activate.nix`
  provision Keychain entries at activation; `home.mcp.readKeychainSecret`
  renders `${env:NAME}` placeholders; consumers read at runtime via Apple's
  `/usr/bin/security find-generic-password` (e.g. `opencode.nix:129`,
  `home-manager/mcp/default.nix:224`). Secrets never enter the nix store.
- **Alternatives**: (A) reuse the bridge and drop nono-native paths; (B) keep
  nono-native delivery but provision its keystore accounts through the bridge;
  (C) leave nono-native provisioning imperative.
- **Selected**: B (operator choice). Keep nono-native delivery
  (`env_credentials`/`--env-credential`, optional `session_hooks.before` →
  `$NONO_ENV_FILE`), but extend the SOPS bridge to also write the Keychain
  accounts nono reads (nono keystore service axis), surfaced via
  `home.mcp.keychainSecrets` (or a sibling map). For the mcpproxy api key the
  inner preflight keeps its `-s mcpproxy` read; the sandbox gets a
  `bypass_protection` Keychain grant rather than re-injecting it.
- **Rationale**: Preserves both the repo's secret invariant (no secret in the
  nix store) AND its declarative provisioning; rejects C's imperative
  `security add-generic-password -s nono` step.
- **Trade-offs**: The bridge must learn nono's keystore service axis; the
  provisioning list and profile `env_credentials` must stay in lock-step
  (added as a revalidation trigger). Provisioning is now spread across the
  bridge module and the opencode-nono profiles — acceptable because the bridge
  already supports non-`mcpproxy` service axes (e.g. sqlite-backup).

## Risks & Mitigations
- **unstable.nono drift** — `package` pin option + `nono profile validate`/`schema` in `nix flake check`.
- **`nono profile show --json` shape unverified** — defensive parser; mark unmappable grants `unknown` (R4.4); implementation verifies on host.
- **Tool-arg/path/socket/env evidence is partial** — R3.2 hedged "when those fields can be derived"; confidence + source tags; sockets/ports/env are inference-only.
- **Keychain/localhost/devx blocked by enforced profile** — host default `disabled`; audit surfaces exact needs; `bypass_protection`/`open_port`/`session_hooks`/`env_credentials` seams documented.
- **cavemem content lossy/compressed, version-coupled** — best-effort secondary source, schema-version guard, partial-report marking (R3.4).
- **Secret leakage in audit output** — redaction on by default; profiles secret-free by construction (env_credentials account names only).

## References
- https://nono.sh/docs/cli/clients/opencode.md
- https://nono.sh/docs/cli/features/profiles-groups.md
- https://nono.sh/docs/cli/features/environment.md
- https://nono.sh/docs/cli/features/credential-injection.md
- https://nono.sh/docs/cli/features/profile-introspection.md
- https://nono.sh/docs/cli/features/audit.md
- https://nono.sh/docs/cli/internals/seatbelt.md
- nixpkgs unstable `nono` 0.5.0 (`mcp-nixos nixos_info`)

---

# Design Rework — 2026-06-03 (topology inversion + spec split)

Triggered by `/kiro-validate-design` (GO with 3 issues) and operator decisions.

## Decision: Invert topology to preflight launcher → nono → opencode (A1+D1)
- **Context**: Issue 1 — the inner mcpproxy/obsidian preflight is fail-closed
  and reads the Keychain (`/usr/bin/security -s mcpproxy`) + curls
  `127.0.0.1:8080`. With nono outermost, every profile (even `opencode-audit`)
  would have to punch Keychain/`security`/`curl` holes or all launches break.
- **Selected (operator)**: run the existing preflight/credential/env setup in an
  OUTER launcher, host-privileged, OUTSIDE nono; export results as env; then
  `exec nono run --profile <eff> -- bare-opencode`. nono passes env through.
- **Evidence**: opencode's `mcp.mcpproxy` entry carries no auth header on either
  host (`configurations/*/home-manager/opencode.nix`), so opencode-inside needs
  only loopback `127.0.0.1:8080`, provider network, `/nix/store` read+exec, and
  inherited env — not Keychain/`security`/`curl`.
- **Consequence**: dissolves the prior "extend SOPS bridge for nono keystore"
  decision. Under D1 (env pass-through) no nono `env_credentials` and no
  bridge change are needed for v1; the launcher reuses the EXISTING secret path
  outside the sandbox. D2 (nono proxy credential injection) deferred (Gemini +
  Shopify `devx` gateway unsupported).
- **Seam change**: `opencode.nix` now exposes `basePackage`, `preflightScript`,
  `lspPath`, and a `finalPackage` option (default = today's preflight-inside
  wrapper). opencode-nono overrides `finalPackage` with the inverted launcher.
- **Alternatives**: A2 (nono `session_hooks.before` keeps nono outermost) and
  A3 (decouple probe from launch — rejected, weakens fail-fast).

## Decision: Split audit/assess/review into sibling spec `opencode-nono-audit`
- **Context**: Issue 2 — the audit pipeline has no runtime dependency on the
  launcher.
- **Selected (operator)**: move R3/R4/R9 + the Audit-domain design into
  `.kiro/specs/opencode-nono-audit/` (renumbered 1–3). This spec renumbered to
  R1 enablement, R2 profiles, R3 rollout, R4 creds/network, R5 coexistence,
  R6 validation. Cross-spec contract: the audit writes a freshness marker
  (`$XDG_STATE_HOME/opencode-nono/last-report.json`) that this spec's R3.5
  strict-enforcement check reads.

## Decision: Phase 0 nono-verification spike (Issue 3)
- An early on-host task (shared with the audit spec) verifies nono 0.5.0:
  `/nix/store` exec under Seatbelt, env pass-through vs `allow_vars`, loopback
  `open_port 8080`, and `profile show --json` shape — before profile authoring
  and before the Assessor parser is built.

## Risks & Mitigations (rework)
- Preflight now host-privileged (not sandboxed) — acceptable: repo-owned,
  static, health-check + token mint; the trade is a much smaller sandbox surface.
- `/nix/store` exec grant under Seatbelt unverified — Phase 0 spike.
- Env pass-through semantics unverified — Phase 0 spike; `allow_vars` fallback.

---

# Implementation Gap Re-Validation — 2026-06-04 (post-audit-implementation, R1–R6)

## Why re-run
Three deltas since the sections above:
1. Requirements were renumbered to R1–R6 after the audit/assess/review split; the
   original Requirement-to-Asset map (R1–R8) is stale.
2. The sibling `opencode-nono-audit` is now fully implemented and validation-GO
   (15 tasks). Its cross-spec contracts are concrete, not hypothetical, and its
   packaging patterns are proven in-repo.
3. Current-state re-check of `opencode.nix` and `nono` availability.

## Verified current state (2026-06-04)
- `nono` 0.5.0 is in nixpkgs unstable (Apache-2.0, always-further/nono), confirmed
  via mcp-nixos. R1.1 package gap is resolved by adopting `pkgs.unstable.nono`
  with a `package` pin option; no source build.
- `opencode.nix` still has only the OLD seam: `home.opencode.{package,
  wrapperCommands, lspPackages}` and `programs.opencode.package = symlinkJoin +
  wrapProgram --suffix PATH --run <joined wrapperCommands>`. Preflight (Keychain
  `/usr/bin/security -s mcpproxy`, curl `127.0.0.1:8080`, cavemem probe) runs
  INSIDE that wrapped binary today. `launchd.agents.opencode-prewarm` already uses
  the UNWRAPPED `home.opencode.package`. The design's launcher seam does not exist
  yet.
- The audit module `home-manager/common/opencode-nono-audit.nix` (thin:
  mkEnableOption + read-only `package` + `home.packages` + peer assertion on
  `programs.opencode.enable`), `scripts/opencode-nono-audit.{js,nix}`, and
  `flake.nix` `checks.opencode-nono-audit-{tests,validate-check}` are the proven
  templates this spec mirrors.

## Requirement-to-Asset Map (current R1–R6)
| Req | Existing assets (reusable) | Gap |
|-----|----------------------------|-----|
| R1 Declarative enablement | `opencode.nix` base+wrapper; `unstable.nono` 0.5.0; RTK/audit module templates | Missing: new module + `opencode.nix` launcher-seam refactor (preflight→nono→opencode inversion); effective-state export (mirror RTK env exports) |
| R2 Profile catalog | nono `extends`/groups schema (design-phase §); `xdg.configFile` render; RTK metadata render | Missing: rendered `~/.config/nono/profiles/{opencode-managed,opencode-audit,opencode-review}.json`, host-specific labels, secret-free construction; profile-validation check |
| R3 Rollout controls + overrides | RTK `OPENCODE_RTK` resolver; audit freshness marker + `evaluateMarkerStaleness` (now implemented) | Missing: `defaultState` (disabled/audit/enforced) + `OPENCODE_NONO`/`OPENCODE_NONO_PROFILE` resolver in the outer launcher; R3.5 freshness check reading the audit `last-report.json` |
| R4 Creds/env/network posture | inverted-topology decision (preflight outside nono → env pass-through, D1); mcpproxy-no-auth-header evidence | Missing: per-profile env/network docs + actionable-error stop path when a profile blocks required access; Constraint: secret-free profiles |
| R5 Coexistence | existing `wrapperCommands` (mcpproxy/cavemem/LSP); RTK state visibility; plugins | Constraint: preflight must move to the OUTER launcher without regressing mcpproxy/cavemem/LSP/plugins; surface RTK+nono states together; never weaken permissions/quarantine |
| R6 Validation/smoke/guidance/metadata | RTK + audit smoke/validate/flake-check patterns; `nono profile validate/schema` | Missing: `opencode-nono-validate` + `opencode-nono-smoke-test` derivations, operator guide, and `metadata.json` render with canonical `profileVersion` |

## Cross-spec contract the sandbox MUST satisfy (audit side already shipped)
- Render `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-nono/metadata.json`
  carrying a canonical `profileVersion` (active managed profile's version). The
  audit's `readProfileVersion` reads exactly this path/field.
- R3.5 strict-enforcement check reads
  `${XDG_STATE_HOME:-~/.local/state}/opencode-nono/last-report.json` =
  `{markerSchemaVersion:1, profileVersion, generatedAt, host}` and warns (never
  blocks) when absent / unreadable / unknown `markerSchemaVersion` /
  `profileVersion ≠ metadata`. `markerSchemaVersion` + the metadata path are
  revalidation triggers on both specs. The audit already exports
  `evaluateMarkerStaleness(marker, liveVersion)` — R3.5 can reuse that semantic
  rather than re-deriving it.
- The `opencode-nono/` XDG namespace is now shared (audit writes reports+marker
  under XDG_STATE; sandbox writes metadata under XDG_CONFIG). Keep ownership
  explicit.

## Design reconciliation needed before tasks (design.md is unapproved)
The committed `design.md` predates two operator decisions recorded in the rework
section + memory; reconcile before `/kiro-spec-tasks`:
1. Topology INVERSION (preflight launcher → nono → opencode) supersedes any
   `wrappedPackage`/`outerLauncher` (preflight-inside) seam naming. The seam is
   `basePackage` + `preflightScript` + `lspPath` + `finalPackage`, with
   `finalPackage` default = today's preflight-inside wrapper and `opencode-nono`
   overriding it with the inverted launcher.
2. Credentials D1 (env pass-through) supersedes the "extend SOPS bridge for nono
   keystore" decision; no `env_credentials`/bridge change for v1.

## Open HARD GATE: Phase 0 not actually executed for the sandbox
The shared Phase 0 spike ran on this host with `nono` ABSENT (audit task 1.1
recorded exit 127 / skip). The sandbox-critical verifications were therefore NOT
performed and remain unknown:
- `/nix/store` read+exec under macOS Seatbelt (does bare opencode run sandboxed?).
- env pass-through vs `allow_vars` precedence for the launcher-exported env.
- loopback `open_port 8080` to reach mcpproxy from inside the sandbox.
- `nono profile show <name> --json` resolved-grant shape (also gates the audit's
  live assessor).
Install `unstable.nono` and run these before profile authoring; they can block or
reshape R2/R4.

## Options (re-affirm C)
- A — extend `opencode.nix` directly: fastest, but bloats the central module and
  couples sandbox to base launch. Risk Medium.
- B — standalone `home-manager/common/opencode-nono.nix` only: clean, but still
  needs an `opencode.nix` seam for the launcher. Risk Medium.
- C (recommended) — hybrid: minimal `opencode.nix` seam refactor
  (base/preflight/lsp/final) + a new `opencode-nono.nix` module (profiles, state
  resolver, metadata, guide, smoke/validate, host defaults). Mirrors the proven
  audit + RTK modules; supports phased disabled→audit→enforced. Risk Medium
  (gated by Phase 0).

## Effort / Risk
- R1+R5 launcher-seam refactor + inversion: M, Risk High (touches the live launch
  path; prewarm + plugins must not regress; Phase 0-dependent).
- R2 profile rendering + validation: M, Risk Medium (schema known; on-host
  `profile show --json` unverified).
- R3 state resolver + freshness check: S–M, Risk Low (RTK resolver + audit marker
  both exist).
- R4 creds/network posture docs + stop paths: S, Risk Low under D1.
- R6 smoke/validate/metadata/guide: M, Risk Low (audit + RTK templates).

## Research items carried to design/tasks
1. Execute Phase 0 on-host with `unstable.nono` installed (the four checks above)
   — hard gate.
2. Reconcile design.md with the topology inversion + D1 credentials before tasks.
3. Confirm the inner-preflight set that must move to the outer launcher (mcpproxy
   Keychain read, curl healthz, cavemem probe, Shopify `devx` mint, LSP PATH) and
   the env each must export into the sandbox.
4. Decide per-profile network posture (unrestricted vs `network_profile`/
   `allow_domain`/`open_port`) once Phase 0 confirms loopback + provider reach.
5. Confirm the shared `opencode-nono/` XDG namespace ownership + the exact
   `profileVersion` string source.

## Recommendation
Proceed with Option C. Package and cross-spec contracts are now de-risked (nono
available; audit shipped with concrete marker/metadata contract + reusable
module/check/test templates). Remaining blockers: the on-host Phase 0
verification (still open because nono was absent during the shared spike) and
reconciling the unapproved design.md with the post-design topology-inversion and
credential decisions. Do not author enforced-profile grants until Phase 0
confirms Seatbelt `/nix/store` exec, env pass-through, and loopback behavior.

---

# Phase 0 On-Host Verification — 2026-06-04 (EXECUTED)

The shared Phase 0 spike previously ran with `nono` absent (audit task 1.1, exit
127). It was executed here against a real `nono` built from the flake's pinned
`nixpkgs-unstable` (`nix build --inputs-from . nixpkgs-unstable#nono`). All
commands ran read-only/non-destructive (introspection + trivial sandboxed
`printenv`/`echo`/`curl healthz`). No host config was switched.

## Headline finding: version reality (THREE numbers)
- design.md/research/memory assume **0.5.0**.
- The flake's pinned `nixpkgs-unstable` actually ships **0.43.1** (this is what
  `pkgs.unstable.nono` resolves to today).
- `nono` itself reports **0.61.1** as the latest upstream (update banner).
The "0.5.0" assumption is wrong (0.43.1 > 0.33 > 0.5.0). All schema facts below
are from **0.43.1**. Action: pin the version explicitly and re-verify the schema
on whatever version is chosen; the nono.sh-docs schema in the sections above
tracks latest, not 0.43.1.

## Check 1 — `/nix/store` read+exec under Seatbelt: PASS
- `nono run --silent --allow-cwd -- <nix-store-binary>` executed both `nono`
  itself and a `coreutils` `echo` from `/nix/store` (rc=0, expected output).
- The inverted topology (nono wraps the bare `/nix/store` opencode binary) is
  viable on macOS; `/nix/store` read+exec is allowed by the default profile.
- **New launch-contract requirement**: in NON-INTERACTIVE mode `nono run`
  refuses CWD access unless `--allow-cwd` is passed — even with the `opencode`
  profile's `workdir.access: ReadWrite`. The launcher must pass `--allow-cwd`
  (else it fails closed with "CWD access requires --allow-cwd in non-interactive
  mode"). Launch shape: `nono run --profile <eff> --allow-cwd -- opencode "$@"`.

## Check 2 — env pass-through: PASS (for the D1 use case)
- Default profile and `opencode` profile both pass benign custom vars through
  (default-allow): `FOO`, and a provider-style `ANTHROPIC_BASE_URL` arrived
  intact in the child. D1 (launcher exports env → nono passes it in) is viable.
- **Anomaly / security follow-up**: `DYLD_INSERT_LIBRARIES=evil` was NOT silently
  stripped — it reached the sandboxed exec and aborted the child via dyld
  (rc=134). This deviates from the docs' "builtin blocklist strips
  LD_PRELOAD/DYLD_*" claim on 0.43.1 (or is a SIP/hardened-runtime artifact).
  Non-blocking for D1 (the launcher never exports `DYLD_*`/`LD_*`), but confirm
  the env blocklist behavior on the pinned version before relying on it.

## Check 3 — loopback `open_port 8080` to mcpproxy: PASS
- mcpproxy is up (host `GET /healthz` = 200).
- network OPEN (`opencode` profile, `block:false`) → loopback reached (200).
- network BLOCKED (`--block-net`) + `--open-port 8080` → loopback reached (200).
- network BLOCKED, no open-port → 000 (control: block genuinely blocks).
- Enforced-profile seam confirmed: `network.block:true` + `open_port:[8080]`
  grants mcpproxy loopback while denying other egress. Provider network still
  needs `block:false` or `allow_domain` (separate R4 decision).

## Check 4 — `nono profile show --json`: PASS (real shape captured)
- 12 built-in profiles exist incl. `opencode` (`extends default`), `codex`,
  `claude-code`, and a `claude-no-kc` ("without macOS keychain access") variant.
- `profile show <name> --json` works. The "update available" banner / summary /
  status print to **stderr**; stdout is clean JSON (verified: stdout-only first
  line is `{`). Pair `--json` with `--silent` for machine output that stays clean
  across nono versions.
- **Audit-side note (corrected)**: the shipped audit parses `result.stdout` only,
  so the stderr banner does NOT break its `JSON.parse` — there is NO parse bug
  (an earlier `2>&1`-merged reading suggested one; that was wrong). `--silent` was
  nonetheless added to the audit's `profile show` shell-out as cross-version
  hardening (with a regression test pinning the argv).
- **Resolved-grant schema (0.43.1) — the contract the audit assessor parses** —
  does NOT match the audit's current synthetic fixture
  (`external-command:{mode,allow}` etc.). Real top-level keys:
  `name`, `description`, `extends[]`, `security{groups[], allowed_commands[],
  signal_mode, process_info_mode, ipc_mode, capability_elevation,
  wsl2_proxy_policy}`, `filesystem{allow[], read[], write[], allow_file[],
  read_file[], write_file[]}`, `policy{exclude_groups, add_allow_*, add_deny_*,
  override_deny}`, `network{block, network_profile, allow_domain[], credentials[],
  open_port[], listen_port[], upstream_proxy, upstream_bypass[]}`,
  `workdir{access}`, `rollback{exclude_patterns, exclude_globs}`.
- Resolved `opencode` profile grants: `filesystem.allow` =
  `$HOME/.opencode`, `$HOME/.config/opencode`, `$HOME/.cache/opencode`,
  `$HOME/.local/share/opencode`, `$HOME/.local/share/opentui`,
  `$HOME/.local/state/opencode`, `$TMPDIR`; `network.block:false` (no domain/port
  limits); `workdir.access:ReadWrite`; `security.groups` includes
  `deny_keychains_macos`, `deny_credentials`, `dangerous_commands*`,
  `node_runtime`, `git_config`, `unlink_protection`. Confirms an enforced profile
  blocks the macOS Keychain — the audit-first / inverted-topology justification.

## Authoring schema (0.43.1) — diverges from research/design assumptions
`nono profile schema` top-level fields: `$schema`, `extends`, `meta`, `security`,
`filesystem`, `policy`, `network`, `env_credentials`, `secrets`, `environment`,
`workdir`, `hooks`, `rollback`, `undo`, `open_urls`, `allow_launch_services`,
`allow_gpu`, `allow_parent_of_protected`, `interactive`, `skipdirs`, `packs`,
`brokered_commands`, `command_args`, `unsafe_macos_seatbelt_rules`.
Key deltas from the earlier research sections:
- `name`/`description` are NOT top-level — they live under `meta`
  (`profile validate` rejected a top-level `name`).
- Group selection is `security.groups[]` + `policy.exclude_groups[]` — NOT a
  top-level `groups{include,exclude}`.
- Hooks are `hooks` — NOT `session_hooks`.
- New fields not previously noted: `secrets`, `undo`, `open_urls`,
  `allow_launch_services`, `allow_gpu`, `allow_parent_of_protected`,
  `interactive`, `brokered_commands`, `command_args`,
  `unsafe_macos_seatbelt_rules`.
- `nono profile validate <file>` gives precise field-level errors — directly
  usable for R6.1 validation checks (wrap with the repo's `[validate-failure:
  <label>]` pattern).

## Phase 0 verdict
HARD GATE PASSED for the inverted topology: `/nix/store` exec, env pass-through,
and loopback `open_port` all work on macOS Seatbelt. Profile rendering and the
audit assessor must target the **real 0.43.1 schema** (re-author against
`meta`/`security.groups`/`hooks`; not the assumed `groups`/`session_hooks`). The
audit `profile show` shell-out now passes `--silent` as cross-version hardening
(its stdout parse was already safe — the banner is on stderr). Pin the nono
version before authoring; the design's `0.5.0` is wrong (actual pin 0.43.1,
latest 0.61.1).
