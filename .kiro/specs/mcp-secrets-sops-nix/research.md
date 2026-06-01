# Implementation Gap Analysis: mcp-secrets-sops-nix

Written: 2026-05-11. Source: requirements.md (9 requirements, 35 EARS criteria), brief.md (Approach A + K3 key model + gh-token expansion), discovery-phase memories (`2026-05-10-cc-sdd-integration-plan.md`, viability check).

## 1. Current State Investigation

### Domain assets in scope

| File | Role | Lines |
|---|---|---|
| `home-manager/mcp/default.nix` | HM module: declares `home.mcp.{enable,githubToken,obsidianVaultPath,extraServers,keychainSecrets,readKeychainSecret}`; builds `mcp-sync-secrets` script; writes `~/.config/mcphub/servers.json`; runs `mcp-hub` via launchd | 158 |
| `configurations/shopify/home-manager/default.nix` | Declares 6 Shopify keychainSecrets + extraServers consuming them | 123 |
| `configurations/personal/home-manager/default.nix` | Declares 8 Personal keychainSecrets + extraServers consuming them | 146 |
| `configurations/common-darwin/default.nix` | nix-darwin module wiring home-manager; owns `system.activationScripts.postActivation` (re-runs settings) | 220 |
| `configurations/{shopify,personal}/default.nix` | Per-host nix-darwin module entry points; import `../common-darwin` and `home-manager.users.${username}` | 57 / 51 |
| `flake.nix` | 18 inputs (no sops-nix); two `darwinConfigurations`; passes `inputs outputs username` via `extraSpecialArgs` to HM | 306 |
| `home-manager/common/gh-cli.nix` | Enables `programs.gh` with `gitCredentialHelper.enable = true`. Token storage external | (small) |

### Architectural patterns observed

- **HM-first secrets pattern**: Secrets are declared in HM modules (`home.mcp.keychainSecrets`), even though they ultimately land in a system-wide artefact (macOS Keychain). The current `mcp-sync-secrets` script is a `home.packages` entry that runs in the user context.
- **Activation as documentation, not action**: `home.activation.mcpKeychainSecrets` only prints a reminder (`echo "MCP secrets may need refreshing..."`). No actual side effect on switch.
- **`extraSpecialArgs` threading**: `inputs`, `outputs`, `username` flow from flake → darwinSystem → home-manager via `extraSpecialArgs`. New flake inputs (sops-nix) reach HM modules through this same channel.
- **Overlay-based custom packages**: `overlays/{misc,mcp-servers,zellij-plugins}.nix` define package additions; consumed by `nixpkgs.overlays` in `common-darwin/default.nix`.
- **Flake-app pattern**: `flake.nix` has `apps.${system}.bump-shopify-taps` exposed via `import ./scripts/bump-shopify-taps.nix`. Same pattern applies for the new `mcp-sync-from-1password` app.
- **Pre-commit guards**: `.pre-commit-config.yaml` enforces nixfmt, statix, deadnix, no-tmp-paths, no-builtins-fetch, no-hardcoded-users. The new module must comply.
- **`extraSpecialArgs` exposes `inputs`** but does NOT expose system-level `config`. nix-darwin system modules and HM modules are evaluated in different contexts; cross-reference between them requires care.

### Conventions

- **Naming**: kebab-case for everything (file names, package names, secret service names). Existing keychain services follow `mcp-<consumer>-<purpose>` (`mcp-github-token`, `mcp-vault-token`, `mcp-fastmail-caldav-password`). Account is uniformly `mcp-hub`.
- **Layering**: `flake.nix` → `configurations/<host>/default.nix` (nix-darwin) → `configurations/<host>/home-manager/default.nix` (HM) → `home-manager/{common,mcp,nixvim}/` (shared HM modules). System modules live under `configurations/`; user modules live under `home-manager/`. New system modules belong under `configurations/common-darwin/` or a new top-level `modules/` directory.
- **Testing**: nixvim has tier-1/2/3 tests via `flake.nix#checks`. The MCP/secrets path has no existing test scaffold.
- **No-CI policy**: All validation is local (`nix flake check --no-build`, `nix build`, `darwin-rebuild switch`). Spec verification will follow the same pattern.

### Integration surfaces

- **Consumer contract**: 14 mcphub `${cmd: /usr/bin/security find-generic-password -s '<svc>' -a mcp-hub -w}` placeholders in `~/.config/mcphub/servers.json`. R7 requires this contract is unchanged.
- **`readKeychainSecret` helper**: Generates the placeholder string. R7.3 explicitly requires the signature stays the same.
- **1Password URI scheme**: `op://<vault>/<item>/<field>`. Both `Employee` (Shopify) and `Private` (Personal) vaults are referenced. R6.2 lets the `gh` token follow the same scheme.
- **macOS Keychain**: `login.keychain-db`, service `mcp-<name>`, account `mcp-hub`. R7.1 requires preservation.
- **gh CLI auth file**: `~/.config/gh/hosts.yml`, owned by gh CLI itself. R6.3 requires removal on declaration removal.

## 2. Requirements Feasibility Analysis

### Requirement-to-asset map

| # | Requirement | Maps to asset | Gap | Tag |
|---|---|---|---|---|
| R1.1 | Switch populates Keychain | `home.activation.mcpKeychainSecrets` (reminder-only) | Replace with real activation that decrypts + writes Keychain | Missing |
| R1.2 | No manual post-activation step | `mcp-sync-secrets` script (manual today) | Remove the manual step; new activation does the work | Missing |
| R1.3 | Works without 1P authenticated | Current flow REQUIRES `op read` | sops-nix decryption from local age key (no 1P at runtime) | Missing |
| R1.4 | Works with 1P offline | Same as R1.3 | Same | Missing |
| R1.5 | Idempotent re-runs | `security add-generic-password -U` is already idempotent | Wrap in activation that respects -U semantics | Constraint (existing pattern works) |
| R2.1–R2.4 | Per-host isolation | Hosts have separate keychainSecrets attrsets but no encryption layer today | Per-host encrypted yamls; per-host age recipients in `.sops.yaml` | Missing |
| R3.1–R3.4 | Bootstrap UX + 3rd-host enrollment | None | Documented procedure; convention for age key location (`~/.config/sops/age/keys.txt` is sops-nix default) | Missing |
| R4.1 | Sync tool from 1P | `mcp-sync-secrets` does 1P→Keychain (wrong direction) | New flake-app `mcp-sync-from-1password`: 1P→encrypted yaml | Missing |
| R4.2–R4.5 | Sync error handling, idempotency, atomicity | None | New script must implement these from scratch | Missing |
| R5.1–R5.2 | Stale cleanup, only touch managed entries | None | Registry file at known path; diff-and-delete logic | Missing |
| R5.3 | Operator-visible logs | Existing `echo` in `mcp-sync-secrets` | Equivalent in new activation script | Constraint |
| R6.1 | gh CLI authenticated after switch | `gh-cli.nix` enables gh; auth state external | Activation writes `~/.config/gh/hosts.yml` from decrypted token | Missing |
| R6.2 | gh token in same encrypted store | Encrypted store doesn't exist yet | Add `gh-token` (per-host) to the same yaml | Missing |
| R6.3 | Removal cleans up auth file | None | Activation logic for the `gh` slot | Missing |
| R6.4 | Rotation propagates | Same plumbing as R6.1 | Same | Constraint (falls out of R6.1) |
| R7.1–R7.3 | Backwards compatibility | All consumer surfaces (`readKeychainSecret`, `keychainSecrets`, `${cmd:}` placeholders) intact | Preservation only — no edits to consumer surface | Constraint |
| R8.1 | Preserve legacy bridge during verification | `mcp-sync-secrets` script + activation reminder both still present | Keep until R1 verified end-to-end on both hosts | Constraint (sequencing) |
| R8.2 | Remove legacy after verification | Need to delete code in `home-manager/mcp/default.nix` | Targeted removal of `mcpSyncSecretsScript` + reminder activation | Missing (sequencing) |
| R8.3 | No lingering references | No grep across docs yet | Audit AGENTS.md, agents.md, README files for `mcp-sync-secrets` mentions | Missing |
| R9.1–R9.5 | secrets/README.md | None | Greenfield doc | Missing |

### Complexity signals

- **External integration**: sops-nix is new to this repo. The viability check (in discovery) confirmed nix-darwin module is active and well-maintained.
- **Cross-layer state**: nix-darwin system module needs to read HM-declared `home.mcp.keychainSecrets`. Achievable via `config.home-manager.users.<user>.home.mcp.keychainSecrets` from a system module, but introduces coupling that needs a clean abstraction.
- **Activation script ordering**: sops-nix's `system.activationScripts.postActivation` (mkAfter) runs early; our keychain-copy must run after. nix-darwin uses an ordered list, not a DAG with named entries on Darwin (different from NixOS systemd).
- **Per-host yaml split**: With K3 (per-host age keys) the encrypted store splits into `secrets/mcp.shopify.yaml` + `secrets/mcp.personal.yaml`. `.sops.yaml` path-based recipient rules enforce this mechanically.
- **gh CLI hosts.yml format**: gh stores OAuth + token + user info in `~/.config/gh/hosts.yml`. Writing this file directly couples to gh's storage format. Alternative: `gh auth login --with-token` invocation at activation. Need to choose during design.
- **No CI**: All verification is local; verification-complete (R8 gate) is operator-judged.

## 3. Implementation Approach Options

### Option A: Extend the existing `home-manager/mcp/` HM module

Add sops-nix wiring, decryption, and Keychain population entirely inside the HM module.

- **Files extended**: `home-manager/mcp/default.nix` only.
- **Compatibility**: Same data shape (`keychainSecrets` attrset). Minimal churn for callers.
- **Maintainability**: Single file owns everything secrets-related.

**Trade-offs**:
- ✅ One file to read/edit.
- ✅ No new module surface.
- ❌ **Conflicts with viability finding**: sops-nix HM module on Darwin has known launchd-agent issues (upstream #801); the viability check explicitly recommends the SYSTEM module. The HM activation runs in user context after system activation, but sops decryption must happen as root for `/run/secrets/<name>` paths.
- ❌ Cross-purpose: `mcp` HM module would handle data declarations AND deployment mechanism — single-responsibility violation.

**Verdict**: Rejected. Direct contradiction with the design constraint from the viability check.

### Option B: New nix-darwin SYSTEM module owns the deployment; HM module remains the data source (Recommended)

- **New module**: `home-manager/mcp/sops-bridge.nix` (or `configurations/common-darwin/mcp-sops-bridge.nix`). Imports sops-nix's nix-darwin module, declares `sops.secrets.*` from a scope-derived attrset, and adds `system.activationScripts.mcpKeychainSync` that reads `${config.sops.secrets.<name>.path}` and `security add-generic-password -U`s into the macOS Keychain.
- **Read HM-declared secrets from system module**: via `config.home-manager.users.<username>.home.mcp.keychainSecrets`. This works because `home-manager.darwinModules.home-manager` (already imported in common-darwin) makes HM config visible at the system layer.
- **Gh token**: extend the same encrypted yaml with a `gh-token` key; activation writes `~/.config/gh/hosts.yml` (or runs `gh auth login --with-token` for the user).
- **Encrypted yamls**: `secrets/mcp.shopify.yaml`, `secrets/mcp.personal.yaml` at repo root. `.sops.yaml` declares path-based recipient rules (per host).
- **Sync tool**: New `scripts/mcp-sync-from-1password.nix` exposes `apps.${system}.mcp-sync-from-1password` (mirrors `bump-shopify-taps.nix`).
- **Registry**: `/var/lib/mcp-keychain-sync/installed-services` written/read by the activation script; diff-and-delete logic for stale cleanup.
- **Decommissioning**: After verification, delete `mcpSyncSecretsScript` and `home.activation.mcpKeychainSecrets` from `home-manager/mcp/default.nix`. Audit docs.

**Trade-offs**:
- ✅ Aligns with viability finding (system module, not HM).
- ✅ Preserves consumer surface (`keychainSecrets` attrset stays where it is).
- ✅ Clean separation: HM declares data; system module deploys it.
- ✅ Bootstrap and runtime contracts are explicit and testable.
- ❌ Cross-layer config read (system reading HM) introduces minor coupling complication.
- ❌ Two activation entries coexist briefly during R8 sequencing (the legacy reminder + the new activation script) until verification gates the removal.

**Verdict**: Recommended.

### Option C: Hybrid — phase the migration with a parallel-write period

- **Phase 1**: Land Option B's system module so that sops-driven activation populates Keychain entries with a `mcp-sops-` prefix (avoiding collision with the live `mcp-` entries). Both pipelines run.
- **Phase 2**: Verify by reading both the legacy and sops-driven keys; confirm value parity.
- **Phase 3**: Switch consumer placeholders from `mcp-<name>` to `mcp-sops-<name>` (touches mcphub server config — violates R7 if done long-term).
- **Phase 4**: Or, after parity verification, atomically swap the population mechanism (the new activation script writes to `mcp-<name>`, the legacy script is removed).

**Trade-offs**:
- ✅ Lower risk during cutover.
- ❌ Phase 3 violates R7 (consumer contract preserved). The whole point of preserving service names is to avoid touching mcphub.
- ❌ Adds 14×2 = 28 transient Keychain entries during Phase 1.
- ❌ Verification in Phase 2 is manual and easy to skip.

**Verdict**: Possible but unnecessary. Option B's R8.1 guard ("preserve legacy until verified") already gives the parallel-availability property without introducing duplicate Keychain entries. The legacy `mcp-sync-secrets` remains runnable as a fallback during the transition; the new activation populates the same `mcp-<name>` services. If a value drifts between sources, the most recent writer wins (the new activation runs every switch; legacy script runs on demand). This is acceptable for a personal config with no concurrent humans.

### Recommendation

**Option B** with R8 sequencing:

1. Land sops-nix infra + new system module + activation script + sync tool + bootstrap docs without removing legacy.
2. Verify on both hosts manually (`security find-generic-password` returns expected values for every declared key after switch with 1P offline).
3. After verification, second commit removes `mcpSyncSecretsScript`, `home.activation.mcpKeychainSecrets`, and any docs referencing `mcp-sync-secrets`.

## 4. Effort and Risk

### Per-component breakdown

| Component | Effort | Risk | Justification |
|---|---|---|---|
| sops-nix flake input + nix-darwin import | S | Low | Standard flake-input dance; mirror existing `home-manager`/`darwin` patterns |
| New nix-darwin system module (sops wiring) | S | Medium | Cross-layer config read introduces minor coupling; reading HM config from system context is documented but uncommon |
| Activation script (decrypt → Keychain + registry diff) | S | Low | Shell over `security` CLI; existing `mcp-sync-secrets` is a working reference |
| `mcp-sync-from-1password` flake-app | S | Low | `bump-shopify-taps.nix` is the template |
| Per-host age keys + 1P enrollment + initial yaml encryption | S | Medium | Manual one-time bootstrap; chicken-and-egg means first-ever encrypt must include both hosts' recipients |
| `gh` token folding | S | Medium | gh's hosts.yml format is undocumented as a contract; need to choose between file write and `gh auth login --with-token` |
| `secrets/README.md` documentation | S | Low | Pure docs |
| Decommissioning legacy bridge (post-verification commit) | S | Low | Targeted file deletes + grep audit |
| End-to-end verification on both hosts | S | Medium | Sudo gates manual; user-driven; need to confirm activation actually fires when 1P is offline |

**Total effort**: M (3–7 days), bounded by the bootstrap + manual verification work rather than the code volume.

**Total risk**: Medium. Driven by:
- New tech in the repo (sops-nix), but viability already confirmed
- Cross-layer config coupling (system module reading HM data)
- gh CLI integration mechanism is undecided
- Bootstrap chicken-and-egg has documented solutions but is operator-driven

## 5. Research Items for Design Phase

Carry these into `/kiro-spec-design`:

1. **sops-nix Darwin module shape**: Confirm exact import path (`inputs.sops-nix.darwinModules.sops`?), option surface (`sops.secrets.<name>.{key,path,owner,group,mode,sopsFile}`), and how to express per-host `sopsFile` selection cleanly.
2. **Reading HM config from a system module**: Confirm `config.home-manager.users.${username}.home.mcp.keychainSecrets` is evaluatable at the system layer. If not, fall back to a shared module read by both.
3. **Age key location convention**: sops-nix default is `$HOME/Library/Application Support/sops/age/keys.txt` on macOS for *user* keys, `/var/lib/sops-nix/key.txt` for *system* decryption. With per-host age keys (K3), confirm which path sops-nix's nix-darwin module reads at activation time.
4. **`/run/secrets` on Darwin**: nix-darwin system module writes to `/run/secrets/<name>`. Confirm `/run` is created (it's a symlink on macOS; sops-nix Darwin module handles this).
5. **`gh` CLI integration mechanism**: Pick between (a) writing `~/.config/gh/hosts.yml` directly with the right shape (couples to gh format, may break on gh upgrades) or (b) `gh auth login --with-token < /run/secrets/gh-token` invocation at activation (requires gh CLI on activation PATH; subprocess management).
6. **gh token vault path**: Decide whether to add a new 1P item per host (`op://Employee/gh-cli-token-shopify`, `op://Private/gh-cli-token-personal`) or reuse the existing `mcp-github-token` items (currently fine-grained PATs scoped for mcphub). New items are cleaner; reuse is less ceremony.
7. **`.sops.yaml` recipient rule shape**: Path-based rules with per-host age recipients. Need to confirm sops's regex matching covers `secrets/mcp.shopify.yaml` vs `secrets/mcp.personal.yaml` cleanly.
8. **Activation ordering on Darwin**: nix-darwin's activation is a single ordered list (`system.activationScripts.<name>.text` with `deps = [...]`), distinct from NixOS's systemd-driven activation. Confirm `deps = ["postActivation"]` (or whatever sops-nix uses) actually orders correctly.
9. **Sudo + activation context**: Activation runs as root via `sudo darwin-rebuild switch`. The `security add-generic-password` call targets `login.keychain-db`, which is per-user. Confirm `sudo -u $USER security ...` (or equivalent) within the activation script populates the user's login keychain, NOT root's.
10. **Verification gate definition**: For R8, what does "parity verified end-to-end on both hosts" mean concretely? Likely: a one-shot script that compares all `security find-generic-password` outputs against expected values (decrypted from sops). Could be the basis of an automated check.

## 6. Recommendations for Design Phase

**Preferred approach**: Option B (new nix-darwin system module reading HM-declared `keychainSecrets`).

**Key decisions to lock in design**:

- sops-nix flake input pin (exact ref + sha256)
- Module file location: `home-manager/mcp/sops-bridge.nix` (HM-adjacent, even though it's a system module, because it serves the HM-declared `keychainSecrets`) vs `configurations/common-darwin/mcp-sops-bridge.nix` (system-adjacent). Lean toward the latter for layering clarity.
- gh CLI integration mechanism (file write vs `gh auth login --with-token`)
- gh token 1P vault path (new item vs reuse existing PAT)
- Activation script language (pure POSIX shell vs `pkgs.writeShellApplication` with strict mode)
- Verification mechanism for R8 (manual operator check vs scripted)
- Whether `secrets/*.yaml` lives at repo root (per brief) or under `secrets/<host>/mcp.yaml` (slightly more nested but cleaner if more secret categories appear later)

**Known design constraints from this analysis**:

- Use sops-nix nix-darwin SYSTEM module, NOT the HM module (viability finding).
- Use a registry file approach for stale-entry cleanup, NOT `security dump-keychain` parsing (viability finding).
- Preserve `home.mcp.keychainSecrets` attrset shape (R7.3).
- Preserve `readKeychainSecret` helper signature (R7.3).
- Preserve mcphub `${cmd: security find-generic-password ...}` placeholders verbatim (R7.2).
- `/etc/ssh/ssh_host_ed25519_key` is NOT present on at least ShopifyLaptop (sshd never enabled). K3 sidesteps this by using a dedicated age key from 1P, but design must specify the on-disk location and permissions.
- Pre-commit guards (`no-tmp-paths`, `no-builtins-fetch`, `no-hardcoded-users`) apply to all new .nix files.

---

# Design Phase Synthesis (2026-05-11)

This section appended after `/kiro-spec-design` resolved the 10 research items in `research-q1-q10-findings.md`. Captures synthesis outcomes (generalisations, build-vs-adopt, simplifications) per `design-synthesis.md`.

## Generalisation

The 14 MCP tokens + 1 gh CLI token are all instances of one underlying capability: **host-scoped declarative secret deployment**. The design exploits this by deriving sops secret declarations from the HM-declared `home.mcp.{keychainSecrets, ghAuthToken}` attrset — adding a future secret is a data-only change (one yaml entry + one HM attrset entry), no module changes required.

The generalisation does NOT extend to "any-target activation" because there are only two distinct delivery targets (macOS Keychain, gh CLI auth) and they need different handling (Keychain via `security add-generic-password`, gh via `gh auth login --with-token`). A generic target-handler interface would be speculative abstraction; reject per the simplification lens below.

## Build vs. Adopt

| Component | Decision | Rationale |
|---|---|---|
| Encryption + decryption framework | Adopt sops-nix (Mic92/sops-nix) nix-darwin module | First-class Darwin support, MIT, actively maintained (commit 2026-01-10), per-secret `sopsFile` enables per-host yamls cleanly |
| Encryption tools | Adopt sops + age (transitive via sops-nix) | Industry-standard; no realistic alternative for the hybrid 1P-canonical + repo-cache model |
| gh CLI auth integration | Adopt `gh auth login --with-token` | Native CLI command; writes Keychain (service `gh:github.com`) on macOS automatically; idempotent re-runs; avoids hand-writing `~/.config/gh/hosts.yml` (unstable contract per Q5 findings) |
| Activation script bridging sops → Keychain | Build (`scripts/mcp-secrets-activate.nix`) | No off-the-shelf solution exists for this specific pattern (sops decrypted file → macOS Keychain via sudo+security under nix-darwin activation) |
| Sync tool 1P → encrypted yaml | Build (`scripts/mcp-sync-from-1password.nix`) | Project-specific (uses HM-declared URI list); existing `mcp-sync-secrets` is the closest reference but has wrong direction |
| Verification gate tool | Build (`scripts/mcp-verify-secrets.nix`) | Project-specific; one-shot decrypt + Keychain compare for R8 gate |
| Stale-entry tracking | Build (registry text file) | Two-line approach (sorted text file + diff); no library justification |

## Simplification

Decisions to NOT do something:

- **No generic target-handler abstraction**: only two target types (Keychain, gh CLI); branch in the activation script is sufficient. A target-handler trait/interface would add lines without simplifying any current code path. Reject.
- **No JSON registry schema**: registry is a flat sorted text file, one service name per line. JSON would force a parser and an evolution story for no benefit at 14 secrets. Reject.
- **No caching layer**: sops-nix already mounts decrypted secrets on a 64MB HFS RAM disk; adding a separate cache would shadow this with no benefit. Reject.
- **No separate per-host bridge modules**: one `mcp-sops-bridge.nix` reads the active host's HM config and works for both. Per-host modules would duplicate logic. Reject.
- **No automated verification gate**: `mcp-verify-secrets` is user-invoked, not automatic. The R8 gate is operator-judged; automation would add CI-like ceremony to a no-CI repo. Reject.
- **No abstraction for "kinds of secrets"**: treat MCP tokens and gh-token as two named categories, hardcoded in the activation script. A generic registry of secret-kinds would be premature given current scope. Reject.
- **No on-disk plaintext caching**: every activation reads `/run/secrets/<name>` afresh; sops-nix's RAM disk is the only persistence layer. Avoids new exposure surface.

## Final Design Decisions (recorded for traceability)

### Decision: nix-darwin SYSTEM module, NOT home-manager sops module

- **Context**: sops-nix offers both a system module and a HM module; the HM module on Darwin has known launchd-agent issues (upstream #801)
- **Selected**: SYSTEM module (`inputs.sops-nix.darwinModules.default`)
- **Rationale**: HM Darwin sops module is fragile (per viability check + Q1 findings); SYSTEM module is the documented happy path; activation as root simplifies file permissions
- **Trade-offs**: Cross-layer coupling (system module reads HM config) is the cost; documented as safe per Q2 findings

### Decision: Per-host age key from 1P (K3 from discovery), not SSH host key

- **Context**: K1 (auto-generated SSH host key) was rejected because at least ShopifyLaptop has no `/etc/ssh/ssh_host_ed25519_key` (sshd never enabled)
- **Selected**: K3 — per-host age private key generated by user, stored in 1P, bootstrapped to `/var/lib/sops-nix/key.txt` once per host
- **Rationale**: Aligns with hybrid model (1P canonical for the bootstrap secret); K3 over K2 (shared key) for true per-host scoping
- **Trade-offs**: Adding a 3rd host requires existing host to enroll new recipient + `nix develop -c sops-nix-sudo updatekeys` + commit; documented in `secrets/README.md`

### Decision: `gh auth login --with-token` over hand-writing `hosts.yml`

- **Context**: Q5 findings showed gh's `hosts.yml` schema is undocumented + has multi-account migrations + recent versions store token in Keychain not in the file
- **Selected**: invoke `gh auth login --with-token < /run/secrets/gh-token` from activation, dropping privileges via `sudo -u`
- **Rationale**: Native CLI command, idempotent, future-stable across gh upgrades, automatically uses macOS Keychain
- **Trade-offs**: Adds `pkgs.gh` as activation-time dependency (already present via HM module, so no incremental cost)

### Decision: `sops.age.sshKeyPaths = []` explicit

- **Context**: Default tries `/etc/ssh/ssh_host_ed25519_key` which doesn't exist on ShopifyLaptop; sops-nix would print warning but continue
- **Selected**: explicit empty list to disable the SSH-derived key path entirely
- **Rationale**: Suppresses warning; documents intent (we use a dedicated age key, not SSH-derived)
- **Trade-offs**: None; pure clarity improvement

### Decision: Two-phase landing per R8 sequencing

- **Context**: R8.1 requires legacy `mcp-sync-secrets` preserved during verification; R8.2 requires removal post-verification
- **Selected**: Phase 1 commit lands sops-nix infra + new activation; legacy remains. Phase 2 commit (after `mcp-verify-secrets` passes on both hosts) removes legacy
- **Rationale**: Reversible at every point; user retains fallback during transition; aligned with no-CI direct-to-main workflow
- **Trade-offs**: Two pipelines briefly write to the same Keychain entries; last-writer-wins; acceptable for personal config with single human

## Risks & Mitigations (carried forward)

- **Locked-keychain at activation time** — Mitigation: documented in `secrets/README.md` as "user must be in GUI session"; matches existing `mcp-sync-secrets` constraint, so no regression
- **sops-nix Darwin module evolves out from under us** — Mitigation: pin in flake.lock; revalidation triggers documented in design.md Boundary Commitments
- **Activation script ordering vs sops-nix mkAfter stack** — Mitigation: defensive `[ -e /run/secrets/<name> ] || exit 1` guard at the top of our script, surfaces ordering mistakes immediately
- **gh CLI hosts.yml format changes upstream** — Mitigation: use `gh auth login --with-token` (native command, format-agnostic); avoids hand-writing the file
- **Bootstrap chicken-and-egg for 3rd host** — Mitigation: `secrets/README.md` documents the workflow; not a code risk

## References

- `Mic92/sops-nix/modules/nix-darwin/default.nix` — Darwin secretType + activation hook
- `Mic92/sops-nix/pkgs/sops-install-secrets/{darwin.go,main.go}` — RAM disk mount + age key import
- `cli/cli/internal/config/migration/multi_account.go` — gh hosts.yml schema
- gh CLI docs: `gh auth login --with-token`
- Existing repo: `home-manager/mcp/default.nix`, `configurations/{shopify,personal}/home-manager/default.nix`
