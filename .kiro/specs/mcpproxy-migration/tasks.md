# Implementation Plan

## Phase 1: Foundation

- [x] 1. Package the mcpproxy daemon for Nix consumption
  - Add a `pkgs.mcpproxy-go` derivation using `buildGoModule` pinned to upstream tag `v0.33.1` (commit `1356c60`)
  - Build only the headless `cmd/mcpproxy` subpackage; do not build the tray binary
  - Disable cgo (`CGO_ENABLED=0`) and skip upstream tests (`doCheck = false`)
  - Resolve `vendorHash` via offline vendoring; no `replace` directives exist in upstream `go.mod`
  - **Observable completion**: `nix build .#mcpproxy-go` succeeds and produces `bin/mcpproxy`; `meta.mainProgram = "mcpproxy"` resolves via `lib.getExe`
  - _Requirements: 1.1, 1.6_
  - _Boundary: overlays/mcp-servers.nix_

- [x] 2. Add the mcpproxy API key as a SOPS-bridged secret
  - Generate a 256-bit hex key (`openssl rand -hex 32`) per host and add it as `mcpproxy-api-key` to `secrets/mcp.shopify.yaml` and `secrets/mcp.personal.yaml`
  - Extend the SOPS bridge manifest renderer to declare `mcpproxy-api-key` as one of the operator-declared MCP secrets so the activation script picks it up
  - Confirm the key surfaces under `/run/secrets/mcpproxy-api-key` after `sops-nix` activation completes
  - **Observable completion**: `sops decrypt secrets/mcp.<host>.yaml` shows the `mcpproxy-api-key` entry; the rendered manifest contains it in the `keychainSecrets` list; `/run/secrets/mcpproxy-api-key` exists post-activation
  - _Requirements: 5.1, 5.2, 5.4_
  - _Boundary: secrets/, configurations/common-darwin/mcp-sops-bridge.nix_

- [x] 3. Migrate the secret-bridge activation script to mcpproxy's keychain layout
  - Swap the keychain write axes for MCP secrets from `(-s <secret> -a mcp-hub)` to `(-s mcpproxy -a <secret>)`
  - Add a parallel write path for sqlite-backup secrets at `(-s nix-config-secrets -a <secret>)`
  - In the same activation pass, delete legacy `(-s <secret> -a mcp-hub)` entries for both MCP and sqlite-backup secrets; cleanup is driven by the installed-services registry, so only script-installed entries are removed
  - Ordering invariant: write all new entries first, then delete legacy entries; activation aborts on guard or write failure before any delete
  - Preserve the defensive `/run/secrets/*` existence guard, the gh-token short-circuit, the `/var/lib/mcp-keychain-sync/installed-services` registry, and exit codes 0/1/2/3/4
  - Idempotent on re-run: a second activation on an already-migrated host writes only new entries and reports no legacy entries to delete
  - **Observable completion**: After activation on a host with legacy entries, `security find-generic-password -s mcpproxy -a mcp-github-token -w` returns the token AND `security find-generic-password -s mcp-github-token -a mcp-hub -w` returns "not found"
  - _Requirements: 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 12.2_
  - _Boundary: scripts/mcp-secrets-activate.nix_

- [x] 4. Update the secret verification script to read new layouts
  - Change keychain read axes to `(-s mcpproxy -a <secret>)` for MCP secrets and `(-s nix-config-secrets -a <secret>)` for sqlite-backup secrets
  - Preserve the existing output format (`MATCH | MISMATCH | MISSING` per service) and exit codes (0/1/2/3)
  - Preserve the gh-token verification path (`gh auth status`) unchanged
  - **Observable completion**: Running the verify script post-migration prints `MATCH` for every operator-declared MCP secret and every sqlite-backup secret
  - _Requirements: 6.5, 12.5_
  - _Boundary: scripts/mcp-verify-secrets.nix_

## Phase 2: Core implementation

- [x] 5. Rewrite the MCP orchestrator module for mcpproxy

- [x] 5.1 Replace the orchestrator's option surface and config rendering
  - Add a new `home.mcp.listenPort` option (default 8080) with a documented description
  - Replace the `servers.json` renderer with an `mcp_config.json` renderer that emits mcpproxy's array shape (`mcpServers: [{name, command, args, env, protocol, enabled, quarantined}]`)
  - Implement an internal attrset→array translator so `home.mcp.extraServers` keeps its `attrsOf attrs` shape; the 15+ cross-host call sites compile unchanged
  - Update the `home.mcp.readKeychainSecret` helper body to emit `"\${keyring:" + name + "}"`; update its docstring to clarify the placeholder is resolved by mcpproxy at server-spawn time
  - Set top-level `quarantine_enabled: false`; emit `enabled: true` and `quarantined: false` explicitly per server; reference `${keyring:mcpproxy-api-key}` in the `api_key` field; do NOT override `tools_limit` (default 15 keeps retrieve_tools mode active)
  - **Observable completion**: `darwin-rebuild build` produces a configuration whose rendered `~/.config/mcpproxy/mcp_config.json` validates as JSON, contains `"quarantine_enabled": false`, references the api key via `${keyring:mcpproxy-api-key}`, has all four base upstream servers as array entries with `enabled: true`, omits any `tools_limit` override, and contains no `mcp-hub` strings
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3, 5.1, 5.2, 7.3_
  - _Depends: 1, 2_
  - _Boundary: home-manager/mcp/default.nix_

- [x] 5.2 Replace the orchestrator's launchd plist and packages
  - Replace the launchd plist with label `com.smart-mcp-proxy.mcpproxy`, listening on `127.0.0.1:${toString cfg.listenPort}`, `KeepAlive = true`, `RunAtLoad = true`, additional ProgramArguments `--log-to-file=false`, log paths under `~/Library/Logs/mcpproxy/launchd.{log,error.log}`
  - Preserve the existing PATH supplementation (`google-cloud-sdk`, `git-lfs`) so spawned upstreams (gcloud-mcp, github-mcp-server) continue to find their tools
  - Rename the restart-helper `writeScriptBin` from `restart-mcp-hub` to `restart-mcpproxy`; point `launchctl kickstart` at the new label
  - Replace `pkgs.mcp-hub` in `home.packages` with `pkgs.mcpproxy-go`; remove the old `mcphub/servers.json` `xdg.configFile` block; remove the old launchd block
  - **Observable completion**: Post-activation, `launchctl list | grep mcpproxy` shows the new label loaded; `~/Library/LaunchAgents/com.smart-mcp-proxy.mcpproxy.plist` exists; `restart-mcpproxy` is on PATH; `pkgs.mcp-hub` is absent from `home.packages`; no `com.ravitemer.mcp-hub` agent remains loaded
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6_
  - _Depends: 5.1_
  - _Boundary: home-manager/mcp/default.nix_

- [ ] 6. (P) Close the cavemem split-brain and rewrite its wrapper probe
  - Remove the `programs.opencode.settings.mcp.cavemem` block (around L491-501) so opencode reaches cavemem only via mcpproxy
  - Keep the `home.mcp.extraServers.cavemem` entry (L431-437); the orchestrator's translator (task 5.1) renders it into mcpproxy's array form, preserving the `CAVEMEM_DATA_DIR` env propagation
  - Rewrite the cavemem wrapper-probe snippet (around L549-557) to: read the api key via `security find-generic-password -s mcpproxy -a mcpproxy-api-key -w`, then probe `GET http://127.0.0.1:8080/healthz` (no auth) for liveness, then probe `GET http://127.0.0.1:8080/api/v1/servers/cavemem` with `X-API-Key` header for cavemem connection state
  - Update failure messages to name "mcpproxy" and the new launchd label `com.smart-mcp-proxy.mcpproxy`; preserve the single-quote-free wrapper-snippet convention
  - Update the in-file narrative comments referencing the mcphub integration to reference mcpproxy; pre-migration history may stay if explicitly framed as historical
  - Leave the `options.home.cavemem` block (L56-211) and the `settings.json` rendering logic byte-identical to pre-migration
  - **Observable completion**: With the cavemem upstream offline, the wrapper-probe snippet exits 1 with a "cavemem MCP server not reachable via mcpproxy" stderr message naming the new launchd label; exit 0 when connected; `git diff home-manager/common/cavemem.nix` shows no changes inside the `options.home.cavemem` block or the settings.json renderer
  - _Requirements: 7.1, 7.2, 7.4, 7.5, 8.3, 8.4, 13.5_
  - _Boundary: home-manager/common/cavemem.nix_

- [ ] 7. Update opencode integration on both hosts

- [ ] 7.1 (P) Rewrite the opencode wrapper preflight for mcpproxy
  - Replace the existing mcphub `/api/health` probe (around L85-92) with the sequence: read api key via `security find-generic-password -s mcpproxy -a mcpproxy-api-key -w`, probe `GET /healthz`, then probe `GET /api/v1/servers/obsidian` with `X-API-Key` header
  - Each probe failure must exit 1 with a stderr message naming the failing component (mcpproxy itself, obsidian) and a recovery hint referencing the new launchd label
  - Preserve the existing single-quote convention (no literal single quotes inside the wrapper snippet)
  - Leave the `opencode-prewarm` launchd agent (around L237) unchanged so it continues to invoke the unwrapped binary
  - **Observable completion**: With mcpproxy stopped, running the wrapped `opencode --version` exits 1 with stderr message "mcpproxy unreachable" and a recovery hint that names `com.smart-mcp-proxy.mcpproxy`; the `opencode-prewarm` plist still invokes the unwrapped binary path
  - _Requirements: 8.1, 8.2, 8.4, 8.5_
  - _Boundary: home-manager/common/opencode.nix_

- [ ] 7.2 (P) Replace the Shopify-host opencode mcp.hub entry
  - Rename the `programs.opencode.settings.mcp.hub` block to `programs.opencode.settings.mcp.mcpproxy`
  - Change the `url` from `http://localhost:37373/mcp/` to `http://127.0.0.1:8080/mcp`
  - Preserve `type = "remote"`, `enabled = true`
  - **Observable completion**: `grep 37373 configurations/shopify/home-manager/` returns no matches; the rendered Shopify `~/.config/opencode/opencode.json` contains exactly one remote MCP entry under key `mcpproxy` pointing at `127.0.0.1:8080`
  - _Requirements: 10.1, 10.3_
  - _Boundary: configurations/shopify/home-manager/opencode.nix_

- [ ] 7.3 (P) Add a personal-host opencode mcpproxy entry
  - Add a `programs.opencode.settings.mcp.mcpproxy` block with `type = "remote"`, `url = "http://127.0.0.1:8080/mcp"`, `enabled = true`
  - **Observable completion**: The rendered personal-host `~/.config/opencode/opencode.json` contains exactly one remote MCP entry under key `mcpproxy` pointing at `127.0.0.1:8080`
  - _Requirements: 10.2_
  - _Boundary: configurations/personal/home-manager/opencode.nix_

- [ ] 8. (P) Rewrite the memory-sync CLI probe for mcpproxy
  - Rename the `MCPHUB_BASE` constant to `MCPPROXY_BASE` and set it to `http://127.0.0.1:8080`
  - Rewrite the `probe_mcp_server <name> <exit-code>` helper to call `GET /api/v1/servers/<name>` with `X-API-Key` header (api key read at runtime via `security find-generic-password -s mcpproxy -a mcpproxy-api-key -w`)
  - Update recovery-hint strings to reference the new launchd label `com.smart-mcp-proxy.mcpproxy`
  - Preserve the per-precondition exit-code contract verbatim: the existing distinct codes for "cavemem unreachable" (4) and "obsidian unreachable" (5) retain their semantics and values
  - **Observable completion**: With mcpproxy stopped, `memory-sync` exits with the existing obsidian-unreachable code (5); stderr names the new launchd label; the recovery hint refers to `com.smart-mcp-proxy.mcpproxy`
  - _Requirements: 9.1, 9.2, 9.3_
  - _Boundary: scripts/memory-sync.nix_

- [ ] 9. Rewrite agent contracts for the four-tool retrieve_tools surface

- [ ] 9.1 (P) Rewrite AGENTS.md startup gate, memory-recall rules, and failure messages
  - Replace the direct `hub_obsidian__list-notes` and `hub_cavemem__list_sessions` calls in the startup gate with the documented two-step idiom: `retrieve_tools(query: …)` to discover the tool, then `call_tool_read(name: …, arguments: …)` to invoke it (one retrieve_tools + one call_tool_read pair per server, four calls total)
  - Rewrite the memory-recall section so all `hub_obsidian__*` and `hub_cavemem__*` references follow the discover-then-invoke pattern while preserving the existing when-to-search, deduplication, and memory-format semantics
  - Update the startup-gate failure message to name mcpproxy and provide a recovery hint referencing the new launchd label `com.smart-mcp-proxy.mcpproxy`
  - Update narrative copy referencing "mcphub" or "mcp-hub" to reference mcpproxy
  - **Observable completion**: `grep -E 'hub_[a-z]|mcphub|mcp-hub' home-manager/common/agents.md` returns zero non-historical matches
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 13.1_
  - _Boundary: home-manager/common/agents.md_

- [ ] 9.2 (P) Rewrite vault-curator subagent prompts for the four-tool surface
  - Replace each of the 14 `hub_obsidian__*` invocations with the discover-then-invoke pattern (retrieve_tools query + appropriate `call_tool_*` invocation; deletes use `call_tool_destructive`)
  - Preserve all dedup, merge, and delete semantics described in the prompt — the rewrite is mechanical, not behavioral
  - **Observable completion**: `grep -E 'hub_[a-z]' home-manager/common/agents/vault-curator.md` returns zero matches
  - _Requirements: 4.1, 4.3_
  - _Boundary: home-manager/common/agents/vault-curator.md_

- [ ] 9.3 (P) Rewrite vault-synthesizer subagent prompts for the four-tool surface
  - Replace each of the 51 `hub_obsidian__*` and `hub_cavemem__*` invocations with the discover-then-invoke pattern
  - Replace the negative allow-list ("no `hub_buildkite__*`, no `hub_observe_*`, no `hub_gcloud_mcp__*`, no `hub_storage_mcp__*`") with the upstream-server-name pattern ("invoke only tools whose retrieve_tools result indicates the server is `obsidian` or `cavemem`; refuse any tool from another server")
  - **Observable completion**: `grep -E 'hub_[a-z]' home-manager/common/agents/vault-synthesizer.md` returns zero matches
  - _Requirements: 4.1, 4.3_
  - _Boundary: home-manager/common/agents/vault-synthesizer.md_

- [ ] 9.4 (P) Rewrite security-auditor subagent prompts for the four-tool surface
  - Replace the 2 `hub_obsidian__write-note` invocations with the discover-then-invoke pattern (`call_tool_write` for note creation)
  - **Observable completion**: `grep -E 'hub_[a-z]' home-manager/common/agents/security-auditor.md` returns zero matches
  - _Requirements: 4.1, 4.3_
  - _Boundary: home-manager/common/agents/security-auditor.md_

- [ ] 9.5 (P) Rewrite Shopify-host stack-captain subagent prompts
  - Replace the 13 `hub_github__*` and `hub_buildkite__*` invocations with the discover-then-invoke pattern
  - **Observable completion**: `grep -E 'hub_[a-z]' configurations/shopify/home-manager/agents/stack-captain.md` returns zero matches
  - _Requirements: 4.1, 4.3_
  - _Boundary: configurations/shopify/home-manager/agents/stack-captain.md_

- [ ] 9.6 (P) Rewrite Shopify-host agents-graphite and graphite-pitfalls skill
  - Replace the 3 references in `agents-graphite.md` (`hub_gt_mcp__run_gt_cmd`, `hub_github__pull_request_review_write`) with the discover-then-invoke pattern
  - Replace the 2 references in the `graphite-pitfalls/SKILL.md` (`hub_gt_mcp`, `hub_github__pull_request_review_write`) similarly
  - **Observable completion**: `grep -rE 'hub_[a-z]' configurations/shopify/home-manager/agents-graphite.md configurations/shopify/home-manager/skills/graphite-pitfalls/` returns zero matches
  - _Requirements: 4.1, 4.3_
  - _Boundary: configurations/shopify/home-manager/agents-graphite.md, configurations/shopify/home-manager/skills/graphite-pitfalls/SKILL.md_

- [ ] 9.7 (P) Update agents-cc-sdd.md and nix-pkg subagent for mcpproxy terminology
  - Scan `agents-cc-sdd.md` for narrative references to "mcphub" or "mcp-hub" and update them to "mcpproxy"
  - Update the `nix-pkg.md` troubleshooting table row referencing the mcphub preflight to reference the mcpproxy preflight
  - **Observable completion**: `grep -E 'mcphub|mcp-hub' home-manager/common/agents-cc-sdd.md home-manager/common/agents/nix-pkg.md` returns zero non-historical matches
  - _Requirements: 13.2, 13.4_
  - _Boundary: home-manager/common/agents-cc-sdd.md, home-manager/common/agents/nix-pkg.md_

- [ ] 9.8 (P) Verify no hub_* references remain across all in-scope agent files
  - Run a recursive grep for `hub_[a-z]` across every file rewritten in 9.1-9.6
  - Confirm zero matches across the agent-contract scope
  - **Observable completion**: `grep -rE 'hub_[a-z]' home-manager/common/agents.md home-manager/common/agents/ configurations/shopify/home-manager/agents/ configurations/shopify/home-manager/agents-graphite.md configurations/shopify/home-manager/skills/graphite-pitfalls/` exits 1 (no matches)
  - _Requirements: 4.1_
  - _Depends: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - _Boundary: agent-contract scope_

- [ ] 10. Tear down nvim MCP integration

- [ ] 10.1 (P) Delete the mcphub.nvim plugin file and its imports entry
  - Remove `home-manager/nixvim/plugins/mcphub.nix` entirely
  - Remove the `./plugins/mcphub.nix` entry from the imports list in `home-manager/nixvim/default.nix`
  - **Observable completion**: `home-manager/nixvim/plugins/mcphub.nix` no longer exists in the working tree; the imports list contains no reference to it; `darwin-rebuild build` does not report a missing-import error for mcphub
  - _Requirements: 11.1_
  - _Boundary: home-manager/nixvim/plugins/mcphub.nix, home-manager/nixvim/default.nix_

- [ ] 10.2 (P) Strip codecompanion's MCP extension wiring
  - Remove the `before.__raw` lz.n hook block (around L15-25) that triggers `mcphub.nvim` loading
  - Remove the `extensions.mcphub` block (around L43-58)
  - Preserve everything else: codecompanion enable, package, lazyLoad cmd list, display/snacks settings, keymaps
  - **Observable completion**: `grep mcphub home-manager/nixvim/plugins/codecompanion.nix` returns zero matches; `:CodeCompanion` opens the chat interface in nvim without errors about missing `mcphub.extensions.codecompanion`
  - _Requirements: 11.2_
  - _Boundary: home-manager/nixvim/plugins/codecompanion.nix_

- [ ] 10.3 (P) Remove the lualine mcphub status component
  - Remove the `mcphub = helpers.mkRaw "..."` let-binding (L8) and the `mcphub` use-site in `sections.lualine_x` (L34)
  - Clean up the `let` block if it becomes vacuous
  - **Observable completion**: `grep mcphub home-manager/nixvim/plugins/lualine.nix` returns zero matches; nvim opens with a clean lualine status line
  - _Requirements: 11.3_
  - _Boundary: home-manager/nixvim/plugins/lualine.nix_

- [ ] 10.4 (P) Remove mcphub flake inputs and the mcp-hub overlay alias
  - Remove the `mcphub` and `mcphub-nvim` input declarations from `flake.nix` (around L73-79)
  - Remove the `mcp-hub = inputs.mcphub.packages.${final.stdenv.hostPlatform.system}.default;` alias from `overlays/mcp-servers.nix` (around L36)
  - **Observable completion**: `nix flake metadata` shows no `mcphub` or `mcphub-nvim` inputs; `nix eval .#legacyPackages.aarch64-darwin.mcp-hub` returns an error indicating the attribute is missing; `darwin-rebuild build` succeeds
  - _Requirements: 1.6, 11.4_
  - _Depends: 5.2, 10.1, 10.2, 10.3_
  - _Boundary: flake.nix, overlays/mcp-servers.nix_

- [ ] 11. Rename sqlite-backup's keychain account to the neutral name

- [ ] 11.1 (P) Update the sqlite-backup CLI to read its keychain account from the manifest
  - Replace the hardcoded `readonly KEYCHAIN_ACCOUNT=mcp-hub` shell constant with a `jq` read of `.keychainAccount` from the rendered manifest at runtime
  - Update the cli script's L18 docstring referencing the `mcp-hub` account to describe the manifest-driven account read
  - **Observable completion**: The cli script's `KEYCHAIN_ACCOUNT` is sourced from the manifest via `jq`; an operator-driven `sqlite-backup verify-credentials` invocation succeeds against a host whose manifest emits `nix-config-secrets`
  - _Requirements: 12.1, 12.3, 12.4_
  - _Boundary: scripts/sqlite-backup-cli.nix_

- [ ] 11.2 (P) Update the sqlite-backup home-manager module to emit the neutral account name
  - Change the manifest renderer in `sqlite-backup.nix` from `keychainAccount = "mcp-hub"` (L350) to `keychainAccount = "nix-config-secrets"`
  - Update the option docstrings for `archivePassphraseSecret` (L205-210) and `rcloneConfigPassphraseSecret` (L215-220) to reference the new account name (no longer "mcp-hub")
  - **Observable completion**: The rendered sqlite-backup manifest contains `"keychainAccount": "nix-config-secrets"`; `grep mcp-hub home-manager/common/sqlite-backup.nix` returns zero matches
  - _Requirements: 12.1, 12.4_
  - _Boundary: home-manager/common/sqlite-backup.nix_

- [ ] 11.3 (P) Update the sqlite-backup verify module docstring
  - Update the docstring at `configurations/common-darwin/sqlite-backup-verify.nix:L35-37` to reference the new account name; no code change required (the script already reads from the manifest dynamically)
  - **Observable completion**: `grep mcp-hub configurations/common-darwin/sqlite-backup-verify.nix` returns zero matches
  - _Requirements: 12.4_
  - _Boundary: configurations/common-darwin/sqlite-backup-verify.nix_

- [ ] 12. (P) Update operator-facing secrets documentation
  - Update `secrets/README.md` rotation docs to reference both keychain accounts (`mcpproxy` for MCP secrets, `nix-config-secrets` for sqlite-backup secrets)
  - Document the new `mcpproxy-api-key` secret with generation instructions (`openssl rand -hex 32`) and the `sops edit secrets/mcp.<host>.yaml` workflow
  - **Observable completion**: `grep mcp-hub secrets/README.md` returns zero non-historical matches; the new `mcpproxy-api-key` generation procedure is documented step-by-step
  - _Requirements: 13.3_
  - _Boundary: secrets/README.md_

## Phase 3: Integration

- [ ] 13. Verify host configurations build cleanly

- [ ] 13.1 (P) Build the Shopify host configuration without switching
  - Run `darwin-rebuild build --flake .#<shopify-host>` against the post-migration tree
  - Verify the build produces no errors related to mcphub, mcp-hub, or removed imports
  - Inspect the rendered `mcp_config.json` (find via the build output path): confirm well-formed JSON containing the four base upstream servers as array entries
  - **Observable completion**: `darwin-rebuild build` exits 0 with no `mcphub` or `mcp-hub` warnings; the rendered `mcp_config.json` parses with `jq .` and contains an `mcpServers` array with at least obsidian, github, mcp-nixos, cavemem
  - _Requirements: 1.6, 2.1, 11.5_
  - _Depends: 5.2, 6, 7.1, 7.2, 8, 9.1, 9.5, 9.6, 9.7, 9.8, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 12_
  - _Boundary: Shopify host evaluation_

- [ ] 13.2 (P) Build the personal host configuration without switching
  - Run `darwin-rebuild build --flake .#<personal-host>` against the post-migration tree
  - Verify no mcphub-related errors and that the rendered opencode config includes the new `mcp.mcpproxy` entry on personal
  - **Observable completion**: `darwin-rebuild build` exits 0 for the personal host; the rendered opencode config contains a `mcp.mcpproxy` entry pointing at `127.0.0.1:8080`
  - _Requirements: 1.6, 2.1, 10.2, 11.5_
  - _Depends: 5.2, 6, 7.1, 7.3, 8, 9.1, 9.2, 9.3, 9.4, 9.7, 9.8, 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 12_
  - _Boundary: personal host evaluation_

## Phase 4: Acceptance evidence

- [ ] 14. Run R14 acceptance checks on each host

- [ ] 14.1 (P) Activate on the Shopify host and run R14 acceptance checks
  - Run `darwin-rebuild switch --flake .#<shopify-host>`; confirm activation completes without errors
  - Confirm the legacy `com.ravitemer.mcp-hub` launchd agent is no longer loaded; `pkgs.mcp-hub` is no longer on PATH; no `-a mcp-hub` keychain entries remain for any prior secret name
  - Start a fresh opencode session; confirm the AGENTS.md mandatory startup gate completes successfully
  - Run `memory-sync` preflight; confirm it completes without error
  - Trigger the opencode wrapper preflight (e.g. invoke the wrapped `opencode --version`); confirm it succeeds for mcpproxy + obsidian + cavemem
  - Run `darwin-rebuild check` against the post-migration config; confirm zero warnings or errors that name `mcp-hub` or `mcphub`
  - Run `sqlite-backup verify-credentials`; confirm secrets resolve via the new `nix-config-secrets` account
  - Open `nvim` and run `:CodeCompanion` to confirm the chat interface opens cleanly with no mcphub-related errors
  - **Idempotency check**: Re-run `darwin-rebuild switch` a second time; confirm exit 0; confirm `security find-generic-password -s <any-secret> -a mcp-hub -w` still returns "not found" (no legacy entries reappeared); confirm new-layout entries remain present
  - **Observable completion**: All R14 acceptance checks pass on the Shopify host; the second `darwin-rebuild switch` exits 0 with no keychain mutations beyond upsert of already-present entries
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 4.5, 6.3, 7.5, 8.5, 11.5, 12.3_
  - _Depends: 13.1_
  - _Boundary: Shopify host runtime_

- [ ] 14.2 (P) Activate on the personal host and run R14 acceptance checks
  - Same procedure as 14.1 against the personal host
  - **Idempotency check**: Re-run `darwin-rebuild switch` a second time on the personal host; confirm exit 0; confirm no legacy `-a mcp-hub` entries reappear; confirm new-layout entries remain
  - **Observable completion**: All R14 acceptance checks pass on the personal host; the second `darwin-rebuild switch` exits 0 with no keychain mutations beyond upsert
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 4.5, 6.3, 7.5, 8.5, 11.5, 12.3_
  - _Depends: 13.2_
  - _Boundary: personal host runtime_

## Implementation Notes

- **5.1**: `tool-gateway` in `configurations/shopify/home-manager/default.nix:112` uses `${cmd: cut -d= ...}` for its auth header. mcpproxy only resolves `${keyring:...}`, NOT `${cmd:...}`. This will fail at runtime in task 14.1 acceptance. Pre-existing tech debt — out of boundary for the renderer rewrite. Either migrate `tool-gateway-token` into the SOPS+keychain pipeline OR document as a known runtime gap before task 14.1.
- **5.1**: The renderer maps `extraServers.<name>.type` → `mcpServers[].protocol`. Current type values (`http`, `streamable-http`) map 1:1 to mcpproxy protocol names; missing `type` defaults to `stdio`. Future extra-server additions must use one of these three values.
