# Gap Analysis: rtk-install

Generated: 2026-05-22T23:43:45Z

## Status and context

- Requirements are generated and approved in `.kiro/specs/rtk-install/spec.json`.
- Core steering files `product.md`, `tech.md`, and `structure.md` are not present under `.kiro/`; this analysis used `.kiro/steering/roadmap.md` and `.kiro/steering/session-compaction.md` where relevant.
- The feature is bounded to RTK for OpenCode Bash/shell tool calls on both nix-darwin hosts. Native Read/Grep/Glob/WebFetch/Task/LSP compression remains out of scope per `.kiro/specs/rtk-install/requirements.md:18`.

## Current state investigation

### OpenCode configuration surfaces

- `home-manager/common/opencode.nix` is the central OpenCode module. It defines `home.opencode.package`, `home.opencode.wrapperCommands`, and `home.opencode.lspPackages` at `home-manager/common/opencode.nix:8`. `wrapperCommands` is explicitly for host/module snippets composed into the OpenCode wrapper at `home-manager/common/opencode.nix:14`.
- The OpenCode package is wrapped with `pkgs.symlinkJoin`, `makeWrapper`, `--suffix PATH`, and `--run '${lib.concatStringsSep "\n" config.home.opencode.wrapperCommands}'` at `home-manager/common/opencode.nix:199`. RTK runtime env and binary PATH wiring can reuse this surface.
- Wrapper snippets must respect the module's quoting constraint; the file documents that snippets are embedded in a single-quoted wrapper string at `home-manager/common/opencode.nix:120`.
- Common OpenCode settings disable hidden title/summary agents at `home-manager/common/opencode.nix:259`, showing the repo already adjusts OpenCode behavior declaratively.
- Common Home Manager enables OpenCode-adjacent modules for both hosts, including cost diagnosis, subagent context budget, and session compaction at `home-manager/common/default.nix:193`.

### Plugin installation patterns

- Simple plugin install already uses `xdg.configFile."opencode/plugins/zellij-attention.ts".source` at `home-manager/common/default.nix:206`.
- Session compaction installs a plugin entry under `opencode/plugins/` and implementation files outside the plugin scan path at `home-manager/common/session-compaction.nix:151`. This solves the OpenCode plugin-loader constraint for multi-file plugins.
- Session compaction exports runtime configuration to the OpenCode process via `home.opencode.wrapperCommands` at `home-manager/common/session-compaction.nix:163`.
- Subagent context budget installs plugin and metadata artifacts declaratively at `home-manager/common/subagent-context-budget.nix:211` and `home-manager/common/subagent-context-budget.nix:216`.
- Existing plugins use `tool.execute.before`/`tool.execute.after` for observation in cavemem at `home-manager/common/opencode-plugins/cavemem.js:68`, and self-check/logging via `client.app.log` in subagent context budget at `home-manager/common/subagent-context-budget/plugin.ts:515`.

### Package overlay patterns

- Custom packages are composed from `mcp-servers`, `zellij-plugins`, `misc`, and `litestream` in `overlays/default.nix:25`.
- `tokscale` is a Rust CLI precedent using `rustPlatform.buildRustPackage`, `fetchFromGitHub`, a tag, a source hash, and `cargoHash` at `overlays/misc.nix:85`.
- `opencode-pinned` is pinned from the upstream fork with source and vendor hashes at `overlays/misc.nix:213`.
- RTK has no package, module, plugin, or option in the repo today. The only live RTK config is Shopify's usage tag `"rtk:disabled"` at `configurations/shopify/home-manager/opencode.nix:10`.

### Host-specific surfaces

- Shopify config builds `Shopify-Usage-Tag` with `"opencode_cli"`, the session id, and `"rtk:disabled"` at `configurations/shopify/home-manager/opencode.nix:10`.
- All Shopify providers reuse the shared provider-header helper at `configurations/shopify/home-manager/opencode.nix:153`, so RTK tag state can remain centralized.
- Personal config currently only enables caveman style and routes MCP through mcpproxy at `configurations/personal/home-manager/opencode.nix:11` and `configurations/personal/home-manager/opencode.nix:16`. There is no provider tag surface on the personal host.

### Measurement and verification surfaces

- `programs.opencode-cost-diagnosis` installs the report CLI and smoke-test wrapper at `home-manager/common/opencode-cost-diagnosis.nix:83` and adds packages to PATH at `home-manager/common/opencode-cost-diagnosis.nix:112`.
- The diagnostic already computes a per-tool dimension via `byTool` at `scripts/opencode-cost-report.js:1129`.
- Reports are persisted as Markdown and JSON under XDG state at `scripts/opencode-cost-report.js:2660`.
- Existing checks include `nix flake check` custom checks and pre-commit hooks at `flake.nix:216`, `opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/` documented at `tests/opencode-cost-diagnosis/README.md:101`, and plugin self-check tests using Node's test runner at `tests/session-compaction/plugin-self-check.test.ts:17`.

## External dependency findings

### RTK

- Upstream is `rtk-ai/rtk`, "Rust Token Killer". It should be sourced from that GitHub project rather than crates.io name resolution because `cargo install rtk` can install the unrelated Rust Type Kit package.
- RTK v0.40.0 is a Rust/Cargo project that installs a binary named `rtk`. Release assets include macOS aarch64 and x86_64 archives, so both source builds and binary packaging are plausible.
- RTK's OpenCode installer path is global-only (`rtk init -g --opencode`) and installs `~/.config/opencode/plugins/rtk.ts`.
- The upstream plugin hooks `tool.execute.before`, checks `input.tool` for `bash` or `shell`, and mutates `output.args.command` after running `rtk rewrite <command>`.
- Upstream plugin rewrite failures are intentionally quiet/pass-through. That behavior conflicts with requirements that RTK failures and unavailable states be visible.
- Telemetry is documented as disabled by default with explicit controls, including `rtk telemetry status|enable|disable|forget` and `RTK_TELEMETRY_DISABLED=1`. Design must verify exact behavior for the pinned version.

Sources consulted: `https://github.com/rtk-ai/rtk/blob/v0.40.0/Cargo.toml`, `https://github.com/rtk-ai/rtk/blob/v0.40.0/INSTALL.md`, `https://github.com/rtk-ai/rtk/blob/v0.40.0/hooks/opencode/rtk.ts`, `https://github.com/rtk-ai/rtk/blob/v0.40.0/docs/TELEMETRY.md`.

### OpenCode docs

- OpenCode docs state local plugins load from `.opencode/plugins/` and `~/.config/opencode/plugins/` at startup.
- Plugins are JavaScript/TypeScript modules that return hook objects; examples show `tool.execute.before` mutating `output.args.command` for the `bash` tool.
- Plugin context includes Bun shell `$`, `client`, `directory`, `project`, and `worktree`.
- Config files are merged, and plugin files are loaded at startup; no documented hot-reload behavior was found.
- Config schema is published at `https://opencode.ai/config.json`; design should fetch it before changing config shape.

Sources consulted: `https://opencode.ai/docs`, `https://opencode.ai/docs/plugins/`, `https://opencode.ai/docs/config/`.

## Requirement-to-asset map

| Requirement area | Existing assets | Gap classification |
|---|---|---|
| R1 host availability and declarative activation | Common HM imports and enabled OpenCode-adjacent modules at `home-manager/common/default.nix:193`; OpenCode wrapper at `home-manager/common/opencode.nix:199` | **Missing**: no RTK module, package, plugin, or enablement option. |
| R2 Bash-tool routing scope | OpenCode plugin hooks already used by cavemem at `home-manager/common/opencode-plugins/cavemem.js:68`; OpenCode docs confirm `tool.execute.before` mutation | **Unknown**: upstream RTK rewrites command text, not result payload; must validate failure semantics and scope. |
| R3 operator control and rollback | `mkEnableOption` and `lib.mkIf cfg.enable` patterns in `home-manager/common/session-compaction.nix:83` and `home-manager/common/session-compaction.nix:141` | **Missing**: host override state and visible enabled/disabled artifacts for RTK. |
| R4 source provenance | Rust package pins in `overlays/misc.nix:85`; OpenCode pin at `overlays/misc.nix:213` | **Missing**: pinned `rtk-ai/rtk` package and exposed version/source identity. |
| R5 telemetry/local data | Global `DO_NOT_TRACK` exists in common shell environment outside this analysis; RTK has its own telemetry controls | **Unknown**: exact RTK telemetry-off guarantees must be verified for the pinned build. |
| R6 measurement and attribution | `opencode-cost-report` persists reports and computes per-tool attribution at `scripts/opencode-cost-report.js:1129` and `scripts/opencode-cost-report.js:2660` | **Partial**: before/after reports work; no first-class RTK-enabled session dimension exists. |
| R7 compatibility/failure visibility | Plugin self-check/logging precedent in `home-manager/common/subagent-context-budget/plugin.ts:515`; tests at `tests/session-compaction/plugin-self-check.test.ts:17` | **Partial/Unknown**: need RTK-specific self-checks; upstream plugin currently fails quietly. |

## Implementation approach options

### Option A: Extend `home-manager/common/opencode.nix`

**Shape:** Add RTK package install, plugin file, wrapper env, and enablement state directly to the central OpenCode module.

**Files likely touched**:
- `home-manager/common/opencode.nix`
- `overlays/misc.nix`
- `configurations/shopify/home-manager/opencode.nix`
- tests and smoke checks as needed

**Pros**:
- Direct access to `home.opencode.wrapperCommands` and `programs.opencode.settings`.
- Fewer new module imports.
- Easy to keep OpenCode-specific state near OpenCode wrapper logic.

**Cons**:
- `home-manager/common/opencode.nix` is already broad: package wrapping, preflight, LSP, agents, settings, and launchd prewarm are all present.
- RTK has distinct lifecycle, telemetry, package provenance, and measurement concerns.
- Host-specific disable/usage-tag behavior can become awkward if encoded in the core OpenCode module.

**Effort/risk:** M / Medium. Low mechanical overhead, higher maintainability risk.

### Option B: Dedicated common module

**Shape:** Add a module such as `home-manager/common/opencode-rtk.nix` with `programs.opencode-rtk.enable`, package exposure, plugin file installation, wrapper env, telemetry controls, assertions, and a smoke-test package.

**Files likely touched**:
- new `home-manager/common/opencode-rtk.nix`
- `home-manager/common/default.nix`
- `overlays/misc.nix`
- new plugin file under `home-manager/common/opencode-plugins/` or a small RTK plugin tree
- tests/smoke checks

**Pros**:
- Mirrors existing feature modules like `programs.session-compaction` and `programs.opencode-cost-diagnosis`.
- Clean enable/disable semantics and peer assertion against `programs.opencode.enable`.
- Easier to add smoke tests and operator-visible metadata.
- Avoids bloating the central OpenCode module.

**Cons**:
- Shopify usage-tag state still needs host config integration.
- Personal has no provider tag, so visible state must come from config metadata, logs, or a smoke command.
- Requires a small interface between the module and host config if provider tags should reflect the state.

**Effort/risk:** M / Medium. Best separation, but needs careful module interface design.

### Option C: Hybrid module plus host tag integration

**Shape:** A dedicated common RTK module owns package/plugin/env/state and exposes a read-only or normal option for rendered RTK state. Shopify config consumes that state to replace `rtk:disabled` with `rtk:enabled` or `rtk:disabled`; personal uses module metadata/logging for visibility.

**Files likely touched**:
- all Option B files
- `configurations/shopify/home-manager/opencode.nix`
- optional diagnostic/report extension if design chooses first-class RTK session attribution

**Pros**:
- Keeps common behavior shared across both hosts while preserving Shopify-specific provider-header ownership.
- Satisfies the usage-tag requirement where provider usage tags exist.
- Allows host-specific disable without duplicating plugin/package logic.
- Leaves room to extend cost diagnostics without making RTK dependent on that extension.

**Cons**:
- More moving pieces than Option A.
- Needs careful evaluation-order design so Shopify can read RTK state without circular dependencies.
- Measurement may still require operator discipline unless the diagnostic learns an RTK state dimension.

**Effort/risk:** M / Medium. Best fit for design evaluation, but not a final decision.

## Integration challenges

- **Hook semantics:** The repo proves observation and prompt augmentation through OpenCode hooks, but not command-result replacement. RTK's upstream approach rewrites `output.args.command` before execution, so design must prove that this preserves underlying command success/failure and satisfies R2/R7.
- **Silent upstream failure behavior:** Upstream RTK's plugin passes through on rewrite errors. Requirements demand visible failures for unavailable RTK or incompatible OpenCode surfaces, so a direct copy of upstream plugin may need a wrapper, self-check, or local patch.
- **Telemetry controls:** RTK's telemetry controls look viable, but design must pin the exact version and verify `RTK_TELEMETRY_DISABLED=1` plus any config-state behavior before reporting RTK as enabled.
- **Session attribution:** Shopify can tag provider requests, but personal has no provider tag surface. The existing diagnostic can compare before/after Bash costs, but it cannot currently infer RTK state from historical DB rows.
- **Wrapper composition:** RTK env must compose with mcpproxy preflight, cavemem probes, LSP env, session compaction env, and Shopify auth snippets without breaking wrapper quoting or startup ordering.
- **Plugin coexistence:** The feature must not disrupt existing OpenCode plugins and modules, especially cavemem capture, session-compaction, subagent-context-budget, mcpproxy, and the diagnostic.

## Research needed for design

- Confirm exact RTK version/tag to pin and discover final Nix source hash and cargo hash.
- Confirm whether source build or release-asset packaging is preferable for Darwin aarch64/x86_64.
- Verify RTK telemetry behavior for the pinned build, including whether compile-time telemetry URL is unset in source builds and whether `RTK_TELEMETRY_DISABLED=1` is sufficient.
- Inspect OpenCode v1.15.5 plugin API locally or through schema/source to confirm `tool.execute.before` argument shape and failure behavior.
- Decide whether to vendor upstream `hooks/opencode/rtk.ts`, generate an equivalent local plugin, or wrap upstream behavior with repo-specific logging/self-checks.
- Decide how to expose RTK state on personal host and whether the cost diagnostic needs a small RTK-state dimension or whether before/after report discipline is enough.

## Validation candidates for design/tasks

- Build RTK package for both target host package sets.
- Evaluate both `darwinConfigurations.ShopifyLaptop` and `darwinConfigurations.Brandons-MacBook-Pro`.
- Add or reuse a smoke test that verifies RTK binary availability, plugin file installation, explicit telemetry-off posture, and OpenCode dependency assertion.
- Add plugin unit tests using the existing Node 22 test style to verify Bash/shell command rewrite, native tool pass-through, missing-RTK failure visibility, and command failure preservation.
- Run `opencode-cost-report` before and after an RTK-enabled Bash-heavy session to measure whether Bash-only savings justify keeping the feature enabled.

## Recommendation for design phase

Carry Option B and Option C into design. Option C currently aligns best with the requirements because it separates common RTK behavior from Shopify provider-tag rendering, but design should validate the OpenCode hook and telemetry questions before committing.

---

# Design Discovery Update

Generated: 2026-05-23T00:00:48Z

## Summary

- **Feature**: `rtk-install`
- **Discovery Scope**: Complex Integration
- **Key Findings**:
  - OpenCode local plugins support TypeScript files and `tool.execute.before`, so RTK command rewrite can be implemented as a repo-owned plugin.
  - RTK v0.40.0 release assets may include upstream CI telemetry compile variables; a source build avoids that risk.
  - Shopify usage tagging must consume the same wrapper-resolved env state that the plugin consumes, otherwise per-launch overrides can drift.

## Research Log

### OpenCode plugin and config contracts

- **Context**: Design must route Bash/shell commands and support fast per-launch state changes.
- **Sources Consulted**: `https://opencode.ai/docs/plugins/`, `https://opencode.ai/docs/config/`, `https://opencode.ai/config.json`.
- **Findings**:
  - Local plugins load from `~/.config/opencode/plugins/` and `.opencode/plugins/` at startup.
  - Plugins can mutate `output.args` in `tool.execute.before`.
  - Config supports environment substitution through `{env:VAR}`.
  - No hot reload is documented for plugin changes.
- **Implications**:
  - The plugin is installed declaratively with `xdg.configFile`.
  - OpenCode must be restarted after config/plugin changes.
  - Shopify can read `OPENCODE_RTK_USAGE_TAG` through existing env substitution.

### RTK packaging and telemetry

- **Context**: Requirements require source provenance and explicit local-first telemetry posture.
- **Sources Consulted**: `rtk-ai/rtk` v0.40.0 `Cargo.toml`, release workflow, OpenCode hook source, and telemetry docs.
- **Findings**:
  - RTK is a Rust crate named `rtk`, binary `rtk`, MIT licensed.
  - Upstream warns that crates.io name resolution can install a different package.
  - Release workflow injects telemetry URL/token for official binaries.
  - Telemetry docs state binaries built without telemetry URL make no telemetry network calls; runtime `RTK_TELEMETRY_DISABLED=1` disables telemetry.
- **Implications**:
  - Build from source using `fetchFromGitHub` and `buildRustPackage`.
  - Do not package from upstream binary assets for this spec.
  - Export `RTK_TELEMETRY_DISABLED=1` in the OpenCode wrapper.

### Per-launch state and Shopify attribution

- **Context**: Requirements added quick enable/disable and exact Shopify `rtk:*` tags.
- **Sources Consulted**: Current Shopify provider header at `configurations/shopify/home-manager/opencode.nix`, OpenCode config docs, Home Manager wrapper patterns.
- **Findings**:
  - Current Shopify tag is statically `rtk:disabled`.
  - Existing provider config already uses `{env:OPENCODE_SESSION_ID}` in headers.
  - The OpenCode wrapper runs module snippets before OpenCode reads env-backed config values.
- **Implications**:
  - A wrapper state resolver exports both `OPENCODE_RTK_EFFECTIVE` and `OPENCODE_RTK_USAGE_TAG`.
  - The plugin and Shopify headers must not compute state independently.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend common OpenCode module | Put RTK directly in `opencode.nix` | Few files | Bloats already broad module | Rejected for boundary clarity |
| Dedicated module | RTK module owns package/plugin/state | Clean separation | Shopify tag still needs host wiring | Good baseline |
| Hybrid module plus host tag | Common module owns state; Shopify consumes tag | Shared behavior and exact host tag | Requires a small module-to-host contract | Selected |

## Design Decisions

### Decision: Use a source-built RTK package

- **Context**: Requirements require `rtk-ai/rtk` provenance and explicit telemetry posture.
- **Alternatives Considered**:
  1. Official release assets — easier packaging but built with upstream CI telemetry variables.
  2. Source build — needs cargo hash discovery but keeps build inputs local and auditable.
- **Selected Approach**: Source build from pinned `rtk-ai/rtk` tag or revision.
- **Rationale**: It satisfies source provenance and telemetry requirements with existing Rust package patterns.
- **Trade-offs**: Implementation must discover and maintain cargo hashes.
- **Follow-up**: Verify cargo dependencies and final hashes during implementation.

### Decision: Implement a repo-owned OpenCode plugin

- **Context**: Upstream plugin silently passes through rewrite failures, but requirements demand visible failures.
- **Alternatives Considered**:
  1. Copy upstream plugin unchanged — closest to upstream but insufficient observability.
  2. Patch upstream plugin — partial control with vendor drift.
  3. Repo-owned plugin — small local implementation of the same contract plus logging.
- **Selected Approach**: Repo-owned plugin that calls `rtk rewrite`, handles only Bash/shell, and logs local state/failures.
- **Rationale**: The behavior is small and the repo already owns OpenCode plugins.
- **Trade-offs**: Future RTK hook updates must be checked manually.
- **Follow-up**: Keep source URLs in comments or research for future comparison.

### Decision: Centralize effective state in the wrapper

- **Context**: The plugin and Shopify usage tag must reflect per-launch override state.
- **Alternatives Considered**:
  1. Static Nix tag — cannot reflect per-launch overrides.
  2. Plugin-computed state — too late for provider header substitution.
  3. Wrapper-computed env state — available to config and plugin at startup.
- **Selected Approach**: Wrapper computes `OPENCODE_RTK_EFFECTIVE` and `OPENCODE_RTK_USAGE_TAG` from host default plus `OPENCODE_RTK`.
- **Rationale**: One source of truth satisfies plugin routing and Shopify tag requirements.
- **Trade-offs**: Wrapper snippet must validate override values and avoid quoting regressions.
- **Follow-up**: Unit-test the resolver and Shopify render path.

## Risks & Mitigations

- OpenCode hook surface changes — plugin self-check and unit tests fail visibly.
- RTK telemetry behavior changes — source build and smoke test verify telemetry-off contract.
- Usage tag and plugin state drift — wrapper exports both values from one resolver.
- Command secrets in logs — plugin logs reason codes and IDs, not full command text or output.
- Native tool savings expectation — design keeps native tool compression out of boundary and measurement focuses on Bash.

## References

- `https://opencode.ai/docs/plugins/` — local plugin locations and hook examples.
- `https://opencode.ai/docs/config/` — env substitution and config precedence.
- `https://github.com/rtk-ai/rtk/tree/v0.40.0` — RTK package, hook, and telemetry source.
