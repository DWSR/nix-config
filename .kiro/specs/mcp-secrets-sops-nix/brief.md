# Brief: mcp-secrets-sops-nix

## Problem
Today, MCP keychain secrets in DWSR/nix-config are bridged from
1Password to macOS Keychain via an imperative `mcp-sync-secrets`
script that the user must run manually after every `darwin-rebuild
switch`. This causes:
- First-run UX friction on a new laptop (must remember to run the
  script; must have 1Password CLI authenticated).
- Drift between hosts when secrets are added/removed.
- Imperative state outside Nix's reproducibility guarantees.
- The `gh auth login` token is similarly out-of-band, stored in
  `~/.config/gh/hosts.yml` outside any management.

## Current State
- `home-manager/mcp/default.nix` declares `keychainSecrets` and a
  `mcp-sync-secrets` script (read 1P → write Keychain). Activation
  only prints a reminder; it does NOT auto-sync.
- 14 MCP secrets across two hosts (6 Shopify, 8 Personal). All
  consumed by mcphub via `${cmd: security find-generic-password ...}`.
- `gh` CLI auth token at `~/.config/gh/hosts.yml`, populated by
  `gh auth login` once per laptop, not in repo.
- 1Password is canonical for both flows already; what's missing is
  declarative deployment.

## Desired Outcome
- `darwin-rebuild switch` populates the Keychain end-to-end
  declaratively, without any manual `mcp-sync-secrets` invocation,
  without 1Password being authenticated at activation time.
- Adding/removing a secret is a single repo edit + commit + sync +
  switch; no manual Keychain cleanup needed.
- `gh` auth token comes under the same management; no manual
  `gh auth login` after first laptop bootstrap.
- 1Password remains canonical (humans edit there); ciphertext in
  the repo is the deployable cache.

## Approach
Approach A — sops-nix + Keychain bridge (per K3 key model):

1. Each host has its own age key, stored in 1P at
   `op://<vault>/sops-age-key-<host>/private`. Bootstrap on a fresh
   laptop: one `op read` → `~/.config/sops/age/keys.txt`.
2. Per-host encrypted yamls: `secrets/mcp.shopify.yaml` (recipient =
   Shopify host's age key only) and `secrets/mcp.personal.yaml`
   (recipient = Personal host's age key only). `.sops.yaml` enforces
   path-based recipient rules.
3. New flake-app `mcp-sync-from-1password` reads each secret from
   `op` and re-encrypts the host-appropriate yaml. Run on demand by
   the user; output committed to repo.
4. nix-darwin SYSTEM module (NOT home-manager) wires sops-nix to
   decrypt at `darwin-rebuild switch` into stable runtime paths
   under `/run/secrets/<name>`.
5. A new `system.activationScripts.mcpKeychainSync` (deps =
   `["postActivation"]`) reads the decrypted files and copies values
   into macOS Keychain via `security add-generic-password -U`. Same
   service/account layout as today (`mcp-<name>` / `mcp-hub`), so
   mcphub consumers are unchanged.
6. A registry file at `/var/lib/mcp-keychain-sync/installed-services`
   tracks currently-installed entries. On each activation, diff vs
   declared set; remove stale Keychain entries.
7. `gh` token centralisation: add `gh-token` to the sops yaml; at
   activation, write `~/.config/gh/hosts.yml` with the right shape
   from the decrypted token.
8. Decommission `mcp-sync-secrets` and the
   `home.activation.mcpKeychainSecrets` reminder once parity is
   verified end-to-end.

## Scope
- **In**: 14 MCP keychain secrets; sops-nix + age + ssh-to-age
  packaging; per-host encrypted yamls; `mcp-sync-from-1password`
  flake-app; nix-darwin sops module wiring on both hosts;
  activation Keychain bridge with stale-entry cleanup; `gh auth`
  token under same management; documentation of bootstrap +
  non-scope rationale.
- **Out**: OpenCode/devx-llm-gateway token (still minted per
  invocation; documented as deliberately out-of-scope). Atuin
  sync key, AWS credentials file, SSH private keys, git signing
  key (1P SSH agent). The "promote to direct file consumption"
  (Approach B) — deferred until upstream PR #952 stabilises
  `$DARWIN_USER_TEMP_DIR`.

## Boundary Candidates
- **Encryption infra**: `.sops.yaml`, `secrets/*.yaml`, sops-nix
  flake input + nix-darwin module wiring. No runtime consumers.
- **Sync workflow (1P → ciphertext)**: `mcp-sync-from-1password`
  flake-app. Imperative (humans run it), no machine-runtime impact.
- **Activation decryption (ciphertext → Keychain)**: nix-darwin
  activation script + registry-file cleanup. Pure machine flow,
  no 1P involvement.
- **Consumer rewiring**: minimal — `home.mcp.keychainSecrets`
  attrset stays; only the population mechanism changes.
- **gh token centralisation**: separate seam; same encryption infra
  but a different activation target (file write, not Keychain).

## Out of Boundary
- OpenCode `OPENCODE_API_KEY` flow (devx-minted per invocation).
- `~/.cache/tool-gateway-token` flow (populated by external Shopify
  tooling).
- 1Password SSH commit signing.
- Atuin sync key, AWS credentials, SSH host/user keys.
- Approach A → Approach B promotion (separate future spec).
- Cleanup of `mcp-fastmail-username` mis-classification (cosmetic,
  defer).

## Upstream / Downstream
- **Upstream**: 1Password CLI (`op`), pinned sops-nix flake input,
  age + ssh-to-age binaries (via sops-nix's transitive closure),
  the existing `home.mcp.keychainSecrets` attrset shape.
- **Downstream**: every MCP server that reads `${cmd: security
  find-generic-password ...}` (unchanged contract); future
  Approach B spec that promotes Keychain bridge to direct file
  consumption.

## Existing Spec Touchpoints
- **Extends**: none (no existing spec covers this domain).
- **Adjacent**: `cc-sdd-integration` is unrelated. The MCP module
  (`home-manager/mcp/default.nix`) is the only existing module
  this spec materially touches.

## Constraints
- macOS aarch64 only (both hosts are Apple Silicon).
- nix-darwin + home-manager (use SYSTEM sops-nix module, NOT the
  HM module — the HM module on Darwin has known launchd-agent
  issues per upstream #801).
- Decryption MUST work without 1Password CLI being authenticated
  (the whole point of the hybrid model).
- Keychain population must be idempotent on re-activation.
- No GPL contamination in the eval graph (sops-nix MIT, sops MPL
  2.0 file-level — invoked as binary, fine).
- Document the per-host age-key-from-1P bootstrap step
  prominently in `secrets/README.md` so a future-self adding a 3rd
  laptop knows what to do.
