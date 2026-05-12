# Implementation Plan

> **Phased landing per R8**: Phase 1 lands Tasks 1–3 (sops-nix infra + new tools, legacy `mcp-sync-secrets` preserved). After Phase 1 lands, the operator performs Tasks 4 (bootstrap) and 5 (validation gate). Only after `5.1 mcp-verify-secrets` exits 0 on both hosts does Phase 2 (Task 6) decommission the legacy bridge.
>
> **Operator-gated tasks** (Tasks 4 + 5) require interactive 1Password access, `sudo darwin-rebuild switch`, and a logged-in GUI session for Keychain unlock. These cannot be executed by an autonomous agent and are listed for completeness with explicit `_Boundary:_` annotations naming the operator action surface.

- [ ] 1. Foundation: flake input, recipient config, operator runbook

- [x] 1.1 Add sops-nix as a pinned flake input
  - Add `inputs.sops-nix` to `flake.nix` with `inputs.nixpkgs.follows = "nixpkgs"` (matches the repo's existing `home-manager` / `darwin` input pattern)
  - Run `nix flake update sops-nix` and commit the resulting `flake.lock` change in the same commit as the input declaration
  - Confirm `nix eval '.#inputs.sops-nix.lastModifiedDate'` returns a timestamp (observable completion)
  - _Requirements: 1.1, 2.1_
  - _Boundary: flake.nix_

- [x] 1.2 Create the recipient config with placeholder per-host age keys
  - Author `.sops.yaml` at repo root with two `creation_rules` entries, one regex per host yaml (`secrets/mcp\.shopify\.yaml$`, `secrets/mcp\.personal\.yaml$`)
  - Each rule's `key_groups.age` lists exactly one age recipient — ShopifyLaptop's age public key for the shopify yaml, Brandons-MacBook-Pro's age public key for the personal yaml
  - Use `age1placeholder...` strings until the operator bootstrap completes (Task 4.3 replaces these); commit a comment block at the top documenting the placeholder convention and pointing readers at `secrets/README.md`
  - Observable completion: `cat .sops.yaml` shows valid YAML with two creation rules; the file passes `python3 -c 'import yaml; yaml.safe_load(open(".sops.yaml"))'`
  - _Requirements: 2.1, 2.2, 2.4_
  - _Boundary: .sops.yaml_

- [x] 1.3 Author the operator runbook
  - Create `secrets/README.md` covering five named subsections: **Bootstrap** (per-host: how to fetch the host's age key from 1P, install at `/var/lib/sops-nix/key.txt` with the right permissions, verify with `head -1`), **Adding a new host** (the chicken-and-egg constraint — existing host must add the new recipient and `sops updatekeys` before the new host can decrypt), **Rotating a secret** (edit in 1P → `nix run .#mcp-sync-from-1password -- <host>` → commit → `darwin-rebuild switch`), **Recovery from lost key** (re-enrol via existing host), and **Out of scope** (OpenCode `OPENCODE_API_KEY`, `~/.cache/tool-gateway-token`, with rationale)
  - Document the GUI-session prerequisite (login keychain must be unlocked at activation time) and what diagnostic the operator sees if not
  - Document the `gh auth login` short-circuit behaviour: rotation requires a GitHub network round-trip; unchanged-token switches do not
  - Observable completion: `secrets/README.md` exists and contains five named `## ` headings (one per subsection above)
  - _Requirements: 3.4, 9.1, 9.2, 9.3, 9.4, 9.5_
  - _Boundary: secrets/README.md_

- [ ] 2. Core: HM extension, helper scripts, system bridge module

- [x] 2.1 (P) Extend the home-manager mcp module with the gh auth token slot
  - Add `home.mcp.ghAuthToken` option (`type = lib.types.nullOr lib.types.str; default = null`) to `home-manager/mcp/default.nix`
  - Document in option `description` that the value is a 1P URI (e.g., `op://Employee/...` on Shopify, `op://Private/...` on Personal) sourced via the same pipeline as `keychainSecrets`
  - Existing `keychainSecrets` option, `readKeychainSecret` helper signature, `githubToken` option, `extraServers` option, and the `mcpSyncSecretsScript` + `home.activation.mcpKeychainSecrets` reminder all REMAIN unchanged in this Phase 1 commit (R7.3 + R8.1)
  - Observable completion: `nix eval '.#darwinConfigurations.ShopifyLaptop.config.home-manager.users.brandonmcnama.home.mcp.ghAuthToken'` returns `null` (default) before any per-host wiring
  - _Requirements: 6.2, 7.3, 8.1_
  - _Boundary: home-manager/mcp/default.nix_

- [x] 2.2 (P) Build the on-demand 1Password sync helper
  - Create `scripts/mcp-sync-from-1password.nix` as `pkgs.writeShellApplication`
  - Argument `$1` = host name (`shopify` | `personal`); reject other values with usage text and exit 1
  - Pre-flight: `op whoami` to confirm authenticated 1P session; exit 2 with diagnostic "1Password authentication required; run `op signin`" on failure (R4.2)
  - Gather: `nix eval --json '.#darwinConfigurations.<host>.config.home-manager.users.brandonmcnama.home.mcp.{keychainSecrets, ghAuthToken}'`; iterate URIs and `op read --no-newline '<uri>'` each; abort on first failure printing the failing URI and exit 3 (R4.3)
  - Build plaintext yaml in `$(mktemp -d)` with one `<key>: <value>` line per declared secret; for `ghAuthToken`, add a `gh-token: <value>` entry only when declared
  - `sops --encrypt --in-place "$tmpfile"` then atomic `mv` to `secrets/mcp.<host>.yaml` (R4.5: partial failure leaves prior store untouched)
  - Declare `runtimeInputs = [ pkgs._1password-cli pkgs.sops pkgs.coreutils pkgs.nix pkgs.jq ]`
  - Observable completion: invoking against a host with an authenticated `op` session writes a `secrets/mcp.<host>.yaml` containing valid sops-encrypted YAML that decrypts to a flat `<service-name>: <value>` map matching the declared `keychainSecrets` keys
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 6.4_
  - _Boundary: scripts/mcp-sync-from-1password.nix_

- [x] 2.3 (P) Build the verification helper
  - Create `scripts/mcp-verify-secrets.nix` as `pkgs.writeShellApplication`
  - Argument `$1` = host name
  - Decrypt the host's yaml in memory: `sops -d --output-type json "secrets/mcp.<host>.yaml" | jq -r 'to_entries[] | select(.key != "sops") | "\(.key)\t\(.value)"'`
  - For each `(key, expected)` pair: query `security find-generic-password -s "<key>" -a mcp-hub -w` and compare with `expected`; for `gh-token`, additionally call `gh auth status --hostname github.com` and verify it reports a logged-in user
  - Per-key output: `printf '%s %s\n' MATCH|MISMATCH|MISSING <key>` to stdout
  - Aggregate exit code: 0 if every key MATCH, non-0 with a final summary line otherwise
  - Declare `runtimeInputs = [ pkgs.sops pkgs.jq pkgs.gh pkgs.coreutils ]`
  - Observable completion: against a fully-populated host, invocation prints one MATCH line per declared secret + the gh-token (if declared) and exits 0
  - _Requirements: 8.1, 8.2_
  - _Boundary: scripts/mcp-verify-secrets.nix_

- [x] 2.4 (P) Build the activation bridge script
  - Create `scripts/mcp-secrets-activate.nix` as `pkgs.writeShellApplication`
  - Arguments: `$1` = target username; `$2` = path to JSON manifest (rendered by Task 2.5 via `pkgs.writeText`)
  - Manifest schema: `{"keychainSecrets": ["mcp-github-token", ...], "ghAuthToken": true|false}`. Parse via `jq`
  - Defensive guard: for every entry in `manifest.keychainSecrets` (and `gh-token` when `ghAuthToken=true`), assert `[ -e /run/secrets/<name> ]`; exit 1 naming the missing path on any failure (catches sops-nix ordering regressions)
  - For each MCP secret: read value from `/run/secrets/<name>` as root, then `sudo -u "$USERNAME" -H /usr/bin/security add-generic-password -U -s "<svc>" -a mcp-hub -w "$value" "/Users/$USERNAME/Library/Keychains/login.keychain-db"`; emit `printf 'mcp-secrets: %s %s\n' add-or-update <svc>` to stderr (R5.3)
  - For gh-token (when `ghAuthToken=true`): SHA-256 hash `/run/secrets/gh-token`; compare against `/var/lib/mcp-keychain-sync/gh-token-hash`; if hashes match AND `sudo -u "$USERNAME" -H /usr/bin/env PATH="${pkgs.gh}/bin:$PATH" gh auth status --hostname github.com >/dev/null 2>&1` exits 0, log "skip gh-login no work needed" and SKIP (R1.3, R1.4 offline-capable invariant). Otherwise run `sudo -u "$USERNAME" -H gh auth login --with-token --hostname github.com < /run/secrets/gh-token` and atomically update the hash file
  - Stale Keychain cleanup: read sorted `/var/lib/mcp-keychain-sync/installed-services`; compute set difference `comm -23 was current` to find stale; for each stale, `sudo -u "$USERNAME" -H security delete-generic-password -s "<svc>" -a mcp-hub "/Users/$USERNAME/Library/Keychains/login.keychain-db" || true`; emit `printf 'mcp-secrets: remove %s\n' <svc>` (R5.1, R5.3)
  - Stale gh cleanup: if `/var/lib/mcp-keychain-sync/gh-token-installed` flag exists but `manifest.ghAuthToken == false`, run `sudo -u "$USERNAME" -H gh auth logout --hostname github.com` and remove flag (R6.3)
  - Update registry atomically: write current declared service names (sorted) to a temp file, `mv` into `/var/lib/mcp-keychain-sync/installed-services`; touch/remove the gh-token-installed flag accordingly
  - Declare `runtimeInputs = [ pkgs.jq pkgs.coreutils pkgs.gh pkgs.diffutils ]` (the latter for `comm`); system binaries `/usr/bin/security` and `/usr/bin/sudo` are invoked by absolute path
  - Observable completion: a synthetic dry-run with a 1-key manifest and a one-line file at `/run/secrets/test-key` populates the corresponding Keychain entry, writes `test-key` to the registry file, and emits a single `mcp-secrets: add-or-update test-key` log line
  - _Requirements: 1.1, 1.2, 1.5, 5.1, 5.2, 5.3, 6.1, 6.3, 6.4, 7.1, 7.2_
  - _Boundary: scripts/mcp-secrets-activate.nix_

- [x] 2.5 Build the nix-darwin system bridge module
  - Create `configurations/common-darwin/mcp-sops-bridge.nix`
  - **Bridge OWNS the sops-nix import**: `imports = [ inputs.sops-nix.darwinModules.default ]`. Per-host `default.nix` files MUST NOT separately import sops-nix (per design D3 ordering decision; the bridge's `mkAfter` block is concatenated after sops-nix's `installScript` only when sops-nix is imported via this module)
  - Read `config.home-manager.users.${username}.home.mcp.{keychainSecrets, ghAuthToken}` to enumerate which sops secrets to declare (read-only against HM config; no redefinition)
  - Set `sops.age.keyFile = "/var/lib/sops-nix/key.txt"` and `sops.age.sshKeyPaths = []` (disables the default SSH-host-key derivation path which is unavailable on hosts without sshd enabled)
  - Generate `sops.secrets.<name> = { sopsFile = config.sops.defaultSopsFile; }` for every key in HM's `keychainSecrets`; conditionally add `sops.secrets."gh-token" = { sopsFile = config.sops.defaultSopsFile; }` when `ghAuthToken != null`
  - Render the activation manifest: `manifest = pkgs.writeText "mcp-secrets-manifest.json" (builtins.toJSON { keychainSecrets = builtins.attrNames hmMcp.keychainSecrets; ghAuthToken = hmMcp.ghAuthToken != null; })`
  - Import the activation script as a derivation: `mcp-secrets-activate = import ../../scripts/mcp-secrets-activate.nix { inherit pkgs; };` (mirrors the existing `cc-sdd-init` import pattern from Phase 5 of the cc-sdd-integration spec)
  - Add the activation invocation: `system.activationScripts.postActivation.text = lib.mkAfter "${mcp-secrets-activate}/bin/mcp-secrets-activate ${username} ${manifest}"`
  - Observable completion: `nix eval --raw '.#darwinConfigurations.ShopifyLaptop.config.system.activationScripts.postActivation.text' | grep mcp-secrets-activate` returns a non-empty match referencing the manifest path under `/nix/store/`
  - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 6.2, 7.3_
  - _Depends: 1.1, 2.1, 2.4_
  - _Boundary: configurations/common-darwin/mcp-sops-bridge.nix_

- [ ] 3. Integration: per-host wiring + flake apps

⚠️ **Hazard window**: Once Tasks 3.1–3.4 land, every subsequent `darwin-rebuild switch` on the affected host fails until Task 4 (bootstrap) completes. The defensive guard in `mcp-secrets-activate` produces a clear "missing /run/secrets/<name>" diagnostic, but the operator must perform Task 4 in the same session — DO NOT push 3.1–3.4 to a host without committing to the bootstrap immediately afterwards.

- [x] 3.1 (P) Wire the sops bridge into ShopifyLaptop
  - In `configurations/shopify/default.nix`, add `imports = [ ../common-darwin/mcp-sops-bridge.nix ]` (alongside the existing `../common-darwin` import)
  - Set `sops.defaultSopsFile = ../../secrets/mcp.shopify.yaml`
  - Confirm there is no separate `inputs.sops-nix.darwinModules.default` import — the bridge owns it (see Hazard window above)
  - Observable completion: `nix build --no-link '.#darwinConfigurations.ShopifyLaptop.system'` succeeds
  - _Requirements: 1.1, 6.1_
  - _Depends: 2.5_
  - _Boundary: configurations/shopify/default.nix_

- [x] 3.2 (P) Wire the sops bridge into Brandons-MacBook-Pro
  - In `configurations/personal/default.nix`, add `imports = [ ../common-darwin/mcp-sops-bridge.nix ]` (alongside the existing `../common-darwin` import)
  - Set `sops.defaultSopsFile = ../../secrets/mcp.personal.yaml`
  - Observable completion: `nix build --no-link '.#darwinConfigurations.Brandons-MacBook-Pro.system'` succeeds
  - _Requirements: 1.1, 6.1_
  - _Depends: 2.5_
  - _Boundary: configurations/personal/default.nix_

- [x] 3.3 (P) Declare the gh CLI token URI on Shopify
  - In `configurations/shopify/home-manager/default.nix`, set `home.mcp.ghAuthToken = "op://Employee/<gh-token-item>/<field>"`
  - Operator picks the actual 1P URI (separate item vs reuse of `mcp-github-token` PAT — design defers to operator; document choice in commit message)
  - Observable completion: `nix eval --raw '.#darwinConfigurations.ShopifyLaptop.config.home-manager.users.brandonmcnama.home.mcp.ghAuthToken'` returns the configured URI
  - _Requirements: 6.1, 6.2_
  - _Depends: 2.1_
  - _Boundary: configurations/shopify/home-manager/default.nix_

- [x] 3.4 (P) Declare the gh CLI token URI on Personal
  - In `configurations/personal/home-manager/default.nix`, set `home.mcp.ghAuthToken = "op://Private/<gh-token-item>/<field>"`
  - Observable completion: `nix eval --raw '.#darwinConfigurations.Brandons-MacBook-Pro.config.home-manager.users.brandonmcnama.home.mcp.ghAuthToken'` returns the URI
  - _Requirements: 6.1, 6.2_
  - _Depends: 2.1_
  - _Boundary: configurations/personal/home-manager/default.nix_

- [x] 3.5 Expose sync + verify as flake apps
  - In `flake.nix`, add `apps.${system}.mcp-sync-from-1password` and `apps.${system}.mcp-verify-secrets` outputs that wrap the `pkgs.writeShellApplication` packages from `scripts/`, mirroring the existing `apps.${system}.bump-shopify-taps` shape
  - Observable completion: `nix run '.#mcp-sync-from-1password' -- --help` and `nix run '.#mcp-verify-secrets' -- --help` both print usage text and exit 0
  - _Requirements: 4.1, 8.1_
  - _Depends: 1.1, 2.2, 2.3_
  - _Boundary: flake.nix_

- [x] 4. Operator Bootstrap (manual, gated by Phase 1 land)

These tasks require interactive 1Password access and `sudo`; an autonomous agent cannot execute them. Tasks 4.1–4.5 must complete on each host before that host's first post-Phase-3 `darwin-rebuild switch` succeeds.

- [x] 4.1 Generate per-host age keys and store in 1Password
  - On each host (or in any local environment with `op` access): `age-keygen -o /tmp/<host>-age-key.txt` (use a path inside the OS user's home or `mktemp`; do NOT commit)
  - Store the private key in 1P at: ShopifyLaptop → `op://Employee/sops-age-key-shopify`, Brandons-MacBook-Pro → `op://Private/sops-age-key-personal`
  - Capture the public recipient (`age-keygen -y` against the private key file) — needed for Task 4.3
  - Securely delete the local plaintext file (`rm /tmp/<host>-age-key.txt`)
  - Observable completion: each 1P item exists, contains an `AGE-SECRET-KEY-...` value, and the public recipients are recorded for the next task
  - _Requirements: 3.1, 3.2_
  - _Boundary: 1Password vault (operator action)_

- [x] 4.2 Install the age key on each host at the canonical location
  - On each host: pre-create the parent dir (`sudo install -d -m 0755 -o root -g wheel /var/lib/sops-nix`), then `op read 'op://<vault>/sops-age-key-<host>/notesPlain' | sudo install -m 0600 -o root -g wheel /dev/stdin /var/lib/sops-nix/key.txt` (the `/notesPlain` field path is required by op 2.x; the install warning about "/dev/stdin: file changed before being copied" is benign)
  - Verify: `sudo head -3 /var/lib/sops-nix/key.txt` returns the 3-line file (header comments + AGE-SECRET-KEY-...); round-trip via `sudo nix shell nixpkgs#age -c age-keygen -y /var/lib/sops-nix/key.txt` should match the public key captured in Task 4.1
  - Observable completion: `/var/lib/sops-nix/key.txt` exists with mode `0600` owned by root on both hosts; round-trip pubkey matches Task 4.1 capture
  - _Requirements: 3.1, 3.2_
  - _Depends: 4.1_
  - _Boundary: each host filesystem (operator action)_

- [x] 4.3 Update `.sops.yaml` with the real per-host age recipients
  - Replace the `age1placeholder...` strings in `.sops.yaml` with the real public recipients captured in Task 4.1
  - Commit the updated `.sops.yaml`
  - Observable completion: `grep -E 'age1[a-z0-9]{50,}' .sops.yaml` returns two matches (one per host) and zero placeholder strings remain
  - _Requirements: 2.1, 2.2_
  - _Depends: 4.2_
  - _Boundary: .sops.yaml_

- [x] 4.4 Initial sync from 1Password to encrypted yaml on each host
  - On each host (in the repo working tree): `nix run '.#mcp-sync-from-1password' -- shopify` (and `... -- personal` on the corresponding host)
  - Confirm `secrets/mcp.<host>.yaml` is created and decrypts cleanly: `sops -d secrets/mcp.<host>.yaml | head -1` returns the first declared secret
  - Commit both encrypted yamls
  - Observable completion: `secrets/mcp.shopify.yaml` and `secrets/mcp.personal.yaml` are committed sops-encrypted files; `sops -d` against each succeeds on its respective host
  - _Requirements: 4.1_
  - _Depends: 3.1, 3.2, 3.5, 4.3_
  - _Boundary: secrets/_

- [x] 4.5 Initial activation on each host
  - On each host: `sudo darwin-rebuild switch --flake .`
  - Verify activation populated the Keychain: `security find-generic-password -s mcp-github-token -a mcp-hub` returns a populated entry
  - Verify activation populated gh auth: `gh auth status` shows logged in to github.com as the maintainer
  - Observable completion: switch exits 0 on both hosts; for every key in `home.mcp.keychainSecrets`, `security find-generic-password -s '<key>' -a mcp-hub` returns a populated entry; `gh auth status` reports logged in
  - _Requirements: 1.1, 1.2_
  - _Depends: 4.4_
  - _Boundary: each host (operator action)_

- [ ] 5. Verification (manual integration tests, gated by Task 4.5)

These tests prove the end-to-end invariants and gate Phase 2 decommissioning. Each can be run in any order on either host once 4.5 completes; mark `(P)` accordingly.

- [ ] 5.1 (P) Verify the parity gate
  - Run `nix run '.#mcp-verify-secrets' -- shopify` and `... -- personal`; both must exit 0 (this is the R8.1 hard gate that authorizes Task 6 decommissioning)
  - Observable completion: both invocations print one MATCH line per declared secret + a MATCH for gh-token (if declared) and exit 0
  - _Requirements: 8.1_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.2 (P) Verify the offline-decryption invariant
  - On one host: sign out of 1P CLI (`op signout` or kill `op` agent); confirm network reachability to github.com is unaffected
  - Run `sudo darwin-rebuild switch --flake .`
  - Verify activation succeeds AND every Keychain entry still matches the encrypted yaml's value (re-run `mcp-verify-secrets` to confirm)
  - Observable completion: switch exits 0 with no `op` invocation in the activation log; `mcp-verify-secrets` exits 0
  - _Requirements: 1.3, 1.4_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.3 (P) Verify per-host scoping fails closed
  - Temporarily swap `/var/lib/sops-nix/key.txt` between hosts (back up original first); run `sudo darwin-rebuild switch --flake .` on the host with the wrong key
  - Verify sops-nix exits with a "no key could decrypt the data" diagnostic; confirm activation does NOT proceed past sops-nix (Keychain unchanged from prior valid state)
  - Restore the correct keys; run switch again to confirm recovery
  - Observable completion: failed-key switch exits non-0 with named diagnostic; subsequent restored switch succeeds
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.4 (P) Verify stale Keychain cleanup + non-managed entry safety
  - Pre-condition: add a sentinel `security add-generic-password -s sentinel-not-managed -a mcp-hub -w 'sentinel'`
  - Edit `home.mcp.keychainSecrets` to remove one declared secret (e.g., `mcp-buildkite-token`); commit; switch
  - Verify removed entry is gone: `security find-generic-password -s mcp-buildkite-token -a mcp-hub` returns "not found"
  - Verify sentinel UNTOUCHED: `security find-generic-password -s sentinel-not-managed -a mcp-hub -w` still returns `sentinel` (R5.2)
  - Restore declarations and resync; clean up sentinel
  - Observable completion: removed entry's `security` lookup returns 44 (not-found); sentinel still queryable; activation log shows `mcp-secrets: remove mcp-buildkite-token`
  - _Requirements: 5.1, 5.2, 5.3_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.5 (P) Verify gh auth flow (initial auth + rotation + short-circuit + removal)
  - After bootstrap, confirm `gh auth status` shows the expected user (R6.1)
  - Re-run `sudo darwin-rebuild switch --flake .` with NO rotation: confirm activation log includes `skip gh-login no work needed` (short-circuit fired; R1.3/R1.4 invariant)
  - Rotate the gh token in 1P, run sync, switch; confirm activation log shows the short-circuit was BYPASSED (hash changed) and `gh auth status` continues to report logged in (R6.4)
  - Set `home.mcp.ghAuthToken = null` in HM config; switch; confirm `gh auth status` reports no login (R6.3)
  - Restore declaration and resync to leave the host functional
  - Observable completion: activation logs across the four states show the expected branch (login / skip / login / logout) and `gh auth status` outputs match
  - _Requirements: 6.1, 6.3, 6.4_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.6 (P) Verify backwards-compatibility surface
  - Confirm a running mcphub MCP server (e.g., `vault-mcp` on Shopify) authenticates successfully after the cutover — its `${cmd: security find-generic-password ...}` placeholder is unchanged
  - Confirm in the diff: `git diff main -- home-manager/mcp/default.nix` shows ONLY additive changes (the new `ghAuthToken` option). `keychainSecrets` shape and `readKeychainSecret` signature are byte-identical pre/post
  - Confirm in the diff: `git diff main -- configurations/{shopify,personal}/home-manager/default.nix` shows ONLY the `ghAuthToken = "op://..."` addition; existing `keychainSecrets` attrset entries unchanged
  - Observable completion: the `git diff` shows only additive changes per the above; mcphub vault-mcp call returns a successful response
  - _Requirements: 7.1, 7.2, 7.3_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.7 (P) Verify sync error paths
  - Sign out of 1P CLI; run `nix run '.#mcp-sync-from-1password' -- shopify`; assert exit 2 with "1Password authentication required" message; confirm `secrets/mcp.shopify.yaml` mtime is unchanged (R4.5)
  - Add a non-existent 1P URI to `keychainSecrets` (commit not required for this test, just edit the working tree); run sync; assert exit 3 naming the failing URI; confirm `secrets/mcp.shopify.yaml` mtime is unchanged
  - Revert the working-tree edit
  - Observable completion: each failure path exits with the documented code AND the encrypted yaml file's mtime + content is unchanged from before the failed run
  - _Requirements: 4.2, 4.3, 4.5_
  - _Depends: 3.5_
  - _Boundary: validation only_

- [ ] 5.8 (P) Verify the bootstrap-incomplete diagnostic
  - On one host: `sudo mv /var/lib/sops-nix/key.txt /var/lib/sops-nix/key.txt.bak`; run `sudo darwin-rebuild switch --flake .`
  - Verify activation fails with a sops-nix diagnostic that names the missing key path; the activation script's defensive guard does NOT corrupt Keychain state (no Keychain modifications happen; verify by re-running `mcp-verify-secrets` after restoring)
  - Restore the key: `sudo mv /var/lib/sops-nix/key.txt.bak /var/lib/sops-nix/key.txt`; switch again to confirm recovery
  - Observable completion: failed switch exits non-0 with a diagnostic referencing `/var/lib/sops-nix/key.txt`; `mcp-verify-secrets` exits 0 after recovery (Keychain unchanged from pre-test state)
  - _Requirements: 3.3_
  - _Depends: 4.5_
  - _Boundary: validation only_

- [ ] 5.9 (P) Verify sync idempotence at value level
  - On one host: capture `sops -d secrets/mcp.<host>.yaml > /tmp/before.yaml` (decrypted plaintext)
  - Without changing any 1P value, run `nix run '.#mcp-sync-from-1password' -- <host>` again
  - Capture `sops -d secrets/mcp.<host>.yaml > /tmp/after.yaml`; `diff /tmp/before.yaml /tmp/after.yaml` must report no differences (R4.4 requires no value-level diff when 1P unchanged; sops MAC drift in the encrypted file is acceptable per the requirement's "value-level" wording)
  - Clean up `/tmp/before.yaml` and `/tmp/after.yaml`
  - Observable completion: `diff` exits 0 between the two decrypted plaintext snapshots
  - _Requirements: 4.4_
  - _Depends: 3.5, 4.4_
  - _Boundary: validation only_

- [ ] 6. Decommissioning (Phase 2, gated by 5.1 verify exit 0 on both hosts)

- [ ] 6.1 Remove the legacy mcp-sync-secrets script and reminder from the HM mcp module
  - Delete the `mcpSyncSecretsScript` definition (the `pkgs.writeScriptBin "mcp-sync-secrets" ...` block) from `home-manager/mcp/default.nix`
  - Delete the `home.activation.mcpKeychainSecrets` activation entry (the one that prints the reminder)
  - Remove the `lib.optional (config.home.mcp.keychainSecrets != { }) mcpSyncSecretsScript` clause from `home.packages` (replace the whole `home.packages = [...] ++ lib.optional ...` expression with the static list)
  - PRESERVE: `keychainSecrets` option, `readKeychainSecret` helper + its `home.mcp.readKeychainSecret` mkOption, `githubToken` option, `extraServers` option, `obsidianVaultPath` option, `enable` option, the `xdg.configFile."mcphub/servers.json"` block, and the `launchd.agents.mcp-hub` block (R7.3)
  - Verify both host configs still build: `nix build --no-link '.#darwinConfigurations.{ShopifyLaptop,Brandons-MacBook-Pro}.system'`
  - Observable completion: `git grep mcpSyncSecretsScript -- home-manager/mcp/default.nix` returns no matches; both host system closures still build
  - _Requirements: 8.1, 8.2_
  - _Depends: 5.1_
  - _Boundary: home-manager/mcp/default.nix_

- [ ] 6.2 Audit and remove lingering legacy references
  - Run `git grep -E 'mcp-sync-secrets|mcpSyncSecretsScript|mcpKeychainSecrets'` across the entire repo (excluding `.kiro/specs/` which preserves spec history)
  - Update any `AGENTS.md`, `home-manager/common/agents.md`, `agents-cc-sdd.md`, README, or steering files that mention the legacy script — replace with references to the new pipeline (`darwin-rebuild switch` + `mcp-sync-from-1password` for rotation)
  - Observable completion: `git grep -E 'mcp-sync-secrets|mcpSyncSecretsScript' -- ':!.kiro/specs/'` returns no matches
  - _Requirements: 8.3_
  - _Depends: 6.1_
  - _Boundary: any user-visible doc surface_

## Implementation Notes

Cross-cutting insights surfaced during execution that may affect downstream tasks or future spec edits:

- **Task 1.1**: `nix eval '.#inputs.sops-nix.lastModifiedDate'` (the literal command this task's observable-completion bullet specified) is invalid for any flake input — flake `outputs` does not expose `inputs` as an attribute path. Canonical equivalent: `nix flake metadata --json | jq '.locks.nodes."sops-nix".locked.lastModified'`. Tasks 1.1 / future spec edits documenting flake input verification should prefer the metadata-jq form.
- **Tasks 1.1, 2.2, 2.3, 2.4**: `nix build --no-link --print-out-paths '.#…system.drvPath'` hits a Nix string-context limitation (`error: ... has a context which refers to a complete source and binary closure`). Use `nix eval --raw '.#…system.drvPath'` instead for build-validation that only needs the .drv path.
- **Tasks 2.2, 2.3, 2.4**: `pkgs.git` is required as a `runtimeInput` for any helper that uses `git rev-parse --show-toplevel` for repo-root discovery. The design's Runtime Dependencies tables list the minimum but not git; this is an additive deviation each helper makes consistently.
- **Task 2.4**: `awk` is invoked implicitly via system PATH inheritance on macOS but not in `runtimeInputs`. Non-blocking on the current macOS deploy targets, but a future hardening pass could swap to `cut -d' ' -f1` (already in `coreutils`). Flag if porting to a host with a stricter PATH.
- **Task 2.4**: `# shellcheck disable=SC2024` is required for `sudo gh auth login --with-token < /run/secrets/gh-token`. The disable is correct: root opens the fd before sudo drops privileges, and the sudo'd `gh` process inherits it. SC2024's generic warning ("sudo doesn't affect redirects") doesn't apply because the redirect happens in the parent shell context, not after sudo.
- **Task 2.2**: YAML emission uses single-quoted scalars with `''` doubling for embedded `'`. Works for all current MCP secrets (single-line bearer strings). If a future secret needs multi-line content, extend to YAML pipe-block-scalar form.
- **Task 2.2**: `sops --filename-override` is required (sops ≥ 3.7) so the encrypted file's recipient set matches the destination path's `creation_rule` even though the temp file lives elsewhere. Currently safe with sops 3.11.0 in nixpkgs-25.11; revalidate if downgrading.
- **Task 3.1 remediation**: Original Task 2.5 design (D3) claimed bridge owning the `inputs.sops-nix.darwinModules.default` import would guarantee sops-nix's `mkAfter installScript` runs before the bridge's own `mkAfter`. **This is empirically wrong on this nix-darwin/module-system version**: the imported module is evaluated AFTER the importer in module merge order, putting sops-nix's `mkAfter` later in the merge chain at the same priority. Fix: replaced bridge's `lib.mkAfter` with `lib.mkOrder 9999` to force strictly-later ordering. nix-darwin does NOT support `system.activationScripts.<name>.deps` for custom names (silently no-ops). Documented at `configurations/common-darwin/mcp-sops-bridge.nix:9-53` and in vault memory `2026-05-11-nix-darwin-activation-script-ordering.md`. Design.md D3 should be updated in a follow-up.
- **Task 3.1 placeholder convention**: `secrets/mcp.shopify.yaml` exists as a one-line placeholder so `sops.defaultSopsFile = ../../secrets/mcp.shopify.yaml` resolves at module-eval. To suppress sops-nix's build-time validation against the empty placeholder (which would fail because no keys match the declared `sops.secrets.<name>`), per-host configs set `sops.validateSopsFiles = false` with a `# TODO: remove once Task 4.4 produces the real encrypted yaml` marker. Activation-time validation still runs (`sops-install-secrets` is invoked without `-check-mode`), so missing/unreadable keys at switch time will surface clearly.
- **Task 3.5 allowUnfree**: `nixpkgs.legacyPackages.<system>` (the default `pkgs` for flake-app context) ships with the upstream config that disallows unfree licenses. `pkgs._1password-cli` is unfree, so importing the sync-tool's derivation through `legacyPackages` failed eval with `Package '1password-cli-2.32.0' has an unfree license`. The `darwinConfigurations` already enable `nixpkgs.config.allowUnfree = true` via `configurations/common-darwin/default.nix`, but flake-app context must opt in separately. Fixed by switching the apps block to `pkgs = import nixpkgs { inherit system; config.allowUnfree = true; }`. Existing `bump-shopify-taps` app continues to work under the same pkgs set.
- **Task 4.1 op CLI 2.x URI quirk**: `op read 'op://Vault/Item'` (no field path) used to resolve to the `notesPlain` field of a Secure Note; op CLI 2.x rejects this with `invalid secret reference 'op://Vault/Item': too few '/'`. The corrected form is `op read 'op://Vault/Item/notesPlain'`. The runbook (`secrets/README.md`) bootstrap step 3, recovery section, and Task 4.2 task description all use the bare-form URI and need the `/notesPlain` suffix in a follow-up doc fix-up commit.
- **Task 4.2 install warning**: `op read 'op://...' | sudo install -m 0600 -o root -g wheel /dev/stdin /var/lib/sops-nix/key.txt` emits a benign `install: /dev/stdin: file changed before being copied` warning. coreutils `install` `fstat`s `/dev/stdin` twice and the reported size differs (0 before read vs actual after) because the source is a pipe. The file content IS correct; round-trip via `nix shell nixpkgs#age -c age-keygen -y /var/lib/sops-nix/key.txt` should still derive the matching public key. Worth documenting in `secrets/README.md` Bootstrap step 3.
- **Task 4.2 parent dir pre-create**: `/var/lib/sops-nix` is NOT auto-created by sops-nix on first activation when the operator installs the key file BEFORE the first `darwin-rebuild switch` (the standard bootstrap sequence). Operator must `sudo install -d -m 0755 -o root -g wheel /var/lib/sops-nix` first. The runbook mentions this as conditional ("if it does not yet exist") but it's the always-case on first bootstrap.
- **Task 4.5 sops-nix gnupg.sshKeyPaths**: sops-nix has TWO ssh-key probe paths, not one. `sops.age.sshKeyPaths` (default `["/etc/ssh/ssh_host_ed25519_key"]`) was already disabled in the bridge module. `sops.gnupg.sshKeyPaths` (default `["/etc/ssh/ssh_host_rsa_key"]`) was missed. Both must be `[]` to silence the `Cannot read ssh key '/etc/ssh/ssh_host_rsa_key'` warning on macOS hosts that don't run sshd. Fixed in `mcp-sops-bridge.nix` (commit `4cabdb8`). Worth flagging in design D3 if updating.
- **Task 4.5 mcp-verify-secrets sudo dependency**: The verifier as originally shipped called `sops -d` directly without setting `SOPS_AGE_KEY_FILE`, relying on operator-set env or `~/.config/sops/age/keys.txt` fallback — neither exists by default after sops-nix bootstrap. The runbook documents `nix run '.#mcp-verify-secrets' -- <host>` as a one-shot but it never worked as written. Fixed in commit `a73fd41` to shell out to `sudo SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt ${sopsBin} -d ...` for the one decrypt call. The absolute store path is required because sudo strips PATH by default. Operator UX cost: one sudo prompt per invocation. Worth documenting in `secrets/README.md` Rotation section step 5.
