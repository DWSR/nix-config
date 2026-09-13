# Research and Gap Analysis

## Verdict

The native CTK/OpenSSH path is supported by the installed macOS interfaces and the current `git-mcp` process model. Runtime feasibility remains `MANUAL_VERIFY_REQUIRED`: Apple does not document locked-screen accessibility for `sc_auth ... -t none`, `KEYCHAIN_CERTIFICATES` is not documented specifically for the SecurityKeyProvider ABI, and GitHub's treatment of no-user-presence SSH-SK signatures is not published.

These are empirical acceptance gates, not unresolved product choices. The task sequence must prove them before enabling the feature on each host.

## Verified Platform Contracts

### Local macOS 26.6.2

- `/usr/sbin/sc_auth`, `/usr/lib/ssh-keychain.dylib`, and `/usr/bin/ssh-keygen` exist and are executable.
- `sc_auth(8)`, section `CTK Identity`, supports `create-ctk-identity -k p-256-ne -t bio|none`. The `-ne` suffix is non-exportable; the manual states that the private key is Secure Enclave-protected and never leaves it in open form.
- `sc_auth(8)` supports identity list and hash-addressed delete operations. It does not promise locked-screen availability.
- `ssh-keychain(8)`, sections `OVERVIEW` and `ENVIRONMENT`, says the provider exposes all compatible identities by default and accepts `KEYCHAIN_CERTIFICATES` as a semicolon-separated public-key-hash filter. The selector's hash algorithm is not named.
- `/usr/lib/ssh-keychain.dylib` exports `_sk_api_version`, `_sk_enroll`, `_sk_load_resident_keys`, and `_sk_sign`, confirming the OpenSSH SecurityKeyProvider ABI.
- `ssh-keygen(1)`, sections `-K` and `FIDO AUTHENTICATOR`, says resident-key download writes a private-key file containing a key handle while the device private key remains non-exportable.
- `ssh-keygen(1)`, section `-Y sign`, selects the signing key with `-f`. Its `ENVIRONMENT` section uses `SSH_SK_PROVIDER` to load security-key-backed keys. Agentless signing therefore uses the resident stub path, not the `.pub` path.
- The local CTK binary at `/System/Library/Frameworks/CryptoTokenKit.framework/ctkcard` imports `_kSecAttrAccessibleAfterFirstUnlock` for both architectures. This proves linkage, not that the `p-256-ne -t none` creation path applies that accessibility class.
- `git-config(1)` documents `gpg.format=ssh`, `gpg.ssh.program`, and `user.signingKey`. Without an agent, `user.signingKey` must be a private-key path; the resident stub satisfies that file role without containing the private key.
- `git-config(1)`, section `ENVIRONMENT`, documents zero-indexed `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, and `GIT_CONFIG_VALUE_<n>`. These override config files but remain subordinate to explicit `git -c` options.

### External Evidence

- The [native Secure Enclave gist](https://gist.githubusercontent.com/arianvp/5f59f1783e3eaf1a2d4cd8e952bb4acf/raw/6df39fcfc8ec7d6b18c4b64bd1dd0ef0fe566e07/SSH_MACOS_SECURE_ENCLAVES.md) demonstrates CTK identity creation, `/usr/lib/ssh-keychain.dylib`, `ssh-keygen -K`, and an `sk-ecdsa-sha2-nistp256@openssh.com` resident stub. Its [no-agent discussion](https://gist.github.com/arianvp/5f59f1783e3eaf1a2d4cd8e952bb4acf?permalink_comment_id=6142067#gistcomment-6142067) reports Git signing with `SSH_SK_PROVIDER` and no `ssh-agent`.
- OpenSSH documents resident handles and `SSH_SK_PROVIDER` in [`ssh-keygen(1)`](https://man.openbsd.org/ssh-keygen#FIDO_AUTHENTICATOR).
- Git documents SSH signing and signer selection in [`git-config(1)`](https://git-scm.com/docs/git-config/2.55.0#Documentation/git-config.txt-usersigningKey). Git's [`gpg-interface.c`](https://github.com/git/git/blob/v2.55.0/gpg-interface.c) shows that `gpg.ssh.program` must support Git's SSH signing and verification command forms.
- GitHub documents separate [authentication and signing key registrations](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account) and separate REST collections for [authentication keys](https://docs.github.com/en/rest/users/keys) and [SSH signing keys](https://docs.github.com/en/rest/users/ssh-signing-keys).
- GitHub's `ssh_data` library recognizes the key type, but its defaults require the SSH-SK user-presence flag ([implementation](https://github.com/github/ssh_data/blob/8f67092f253e36be1a980513458e1fcff777d1e2/lib/ssh_data/public_key/security_key.rb)). GitHub production options are unpublished; a real `Verified` commit is required.
- Secretive [issue #462](https://github.com/maxgoedjen/secretive/issues/462) reports locked-screen rejection. Open [PR #819](https://github.com/maxgoedjen/secretive/pull/819) changes opaque-key accessibility to `AfterFirstUnlockThisDeviceOnly` and reports locked signing until reboot. This is comparative evidence only; Secretive is not a dependency and does not prove CTK behavior.
- Gist discussion reports a multiple-identity resident-export collision and a later developer-beta fix ([report](https://gist.github.com/arianvp/5f59f1783e3eaf1a2d4cd8e952bb4acf?permalink_comment_id=5993654#gistcomment-5993654), [follow-up](https://gist.github.com/arianvp/5f59f1783e3eaf1a2d4cd8e952bb4acf?permalink_comment_id=6272725#gistcomment-6272725)). Stable filename and ordering behavior remains undocumented.

## Current Repository Assets

- `git-mcp` is a common base server with `MCP_SESSION_MODE=stateless` and `STORAGE_PROVIDER_TYPE=in-memory` in `home-manager/mcp/default.nix:131-150`.
- `renderServer` copies a server's explicit environment into rendered mcpproxy configuration in `home-manager/mcp/default.nix:52-65`.
- The packaged server uses nixpkgs Git and stdio transport in `overlays/mcp-servers.nix:690-733`.
- Common Git keeps SSH signing and 1Password's `op-ssh-sign` in `home-manager/common/git.nix:2-33`.
- Common SSH keeps the 1Password agent socket in `home-manager/common/ssh.nix:1-19`.
- Host Git files contain distinct existing signing public keys in `configurations/personal/home-manager/git.nix:1-5` and `configurations/shopify/home-manager/git.nix:1-23`.
- `tests/git-mcp/hm-render.test.js:45-96` validates both hosts and the two hardening variables. `flake.nix:1958-1974` owns the `git-mcp` check.
- Existing feature packaging uses `writeShellApplication`, typed options, XDG-derived state, and `mkIf`; `scripts/git-clone-isolation.nix:1-21` and `home-manager/common/git-clone-isolation.nix:8-61` are local examples.

## Upstream git-mcp Behavior

- Version `v2.15.1` spawns `git` shell-free with a full `process.env` copy ([command-builder.ts](https://github.com/cyanheads/git-mcp-server/blob/62b237109b0d62940f88766df9937919b34a44bb/src/services/git/providers/cli/utils/command-builder.ts#L61-L101)). Explicit mcpproxy server variables reach Git descendants.
- `git_commit` accepts no arbitrary `-c` or `--no-gpg-sign` input ([git-commit.tool.ts](https://github.com/cyanheads/git-mcp-server/blob/62b237109b0d62940f88766df9937919b34a44bb/src/mcp-server/tools/definitions/git-commit.tool.ts#L37-L69)).
- The first attempt includes `--gpg-sign`. On any failure, the server removes that flag and retries ([commit.ts](https://github.com/cyanheads/git-mcp-server/blob/62b237109b0d62940f88766df9937919b34a44bb/src/services/git/providers/cli/operations/commits/commit.ts#L43-L97)). Command-scoped `commit.gpgSign=true` is therefore required to prevent an unsigned retry.
- Git commands have a hard-coded 60-second timeout ([git-executor.ts](https://github.com/cyanheads/git-mcp-server/blob/62b237109b0d62940f88766df9937919b34a44bb/src/services/git/providers/cli/utils/git-executor.ts#L27-L28)). Because the upstream retries signing, one shorter deadline must enclose the complete signing worker, including CTK identity listing, every preflight native call, and provider signing.
- Non-zero stderr is preserved in the MCP error path. A successful commit can still be followed by a failing metadata query, so tests must inspect `HEAD` and the commit object rather than trust response fields alone.

## Requirement-to-Asset Map

| Requirements | Existing asset | Gap |
|---|---|---|
| 1, 4 | Native CTK identity commands and Secure Enclave | Per-host identities and physical-state evidence are missing |
| 2 | git-mcp signed commit path; Git SSH signing | Dedicated signer, stub, pinning, and signature verification are missing |
| 3 | Base-server env rendering; global Git and SSH config | No git-mcp-only override or isolation assertion exists |
| 5 | Nix/SOPS boundaries from adjacent specs | No private-material scanner or security-boundary runbook exists |
| 6 | Provider filtering and Git error propagation | No deterministic preflight, mismatch detection, or clear diagnostics exist |
| 7, 8 | `sc_auth` lifecycle operations | No idempotent bootstrap, rotation, recovery, or decommission workflow exists |
| 9 | Existing render test and flake check | No signer contract, failure, timeout, or upstream-isolation coverage exists |
| 10 | None | Every physical-host probe and GitHub verification result is missing |
| 11 | Existing repository documentation patterns | No signing runbook exists |

## Implementation Approach Options

### Option A: Inline extension

Add signing options, scripts, and all rendered environment logic directly to `home-manager/mcp/default.nix`.

- Minimal integration surface.
- Mixes operator lifecycle, signer behavior, and orchestrator rendering in an already large module.
- Harder to unit-test without full host evaluation.

### Option B: Independent signing module

Create a standalone Home Manager module that owns tools, paths, host metadata, and the full `git-mcp` server definition.

- Clear lifecycle ownership and isolated tests.
- Replacing the base server attrset can drop stateless/in-memory settings or diverge from mcpproxy conventions.
- Creates an unnecessary second owner for the `git-mcp` registration.

### Option C: Hybrid extension

Package signer and lifecycle tools separately, add a typed signing submodule to the existing mcpproxy module, and merge generated non-secret overrides into the existing `git-mcp` entry.

- Keeps the orchestrator as the only server-registration owner.
- Keeps platform-specific logic and tests outside the renderer.
- Requires an explicit contract between host metadata, state paths, and rendered environment.

Option C best fits current ownership and limits regression risk. Design must define the contract rather than duplicate the mcpproxy server definition.

## Gaps and Design Inputs

- **Mandatory rollout gate**: Prove `p-256-ne -t none` signing unlocked, locked, after sleep, and GitHub `Verified` on each host. Stop rollout on failure.
- **Identity pinning**: Validate the `KEYCHAIN_CERTIFICATES` hash form against the SecurityKeyProvider path. Treat the resident stub plus expected SSH fingerprint as the primary key match.
- **Export ambiguity**: Export into a temporary empty directory, enumerate all outputs, match by public-key fingerprint, and install exactly one selected stub atomically. Never depend on provider ordering or default filenames.
- **Signer contract**: For Git's `-Y sign` path, start the bounded worker before CTK listing or any other preflight native call. Preserve direct passthrough for non-signing SSH program operations.
- **Unsigned retry**: Render `commit.gpgSign=true` in addition to `gpg.format`, `gpg.ssh.program`, and `user.signingKey`.
- **Timeout**: Capture immutable `T0 + 20s` work and `T0 + 22s` attempt deadlines. Cleanup uses the earlier of cleanup start plus one or two seconds and the attempt deadline. Hang each native phase in tests and assert a bounded result, no commit, and no surviving owned worker-group member.
- **Process boundary**: Environment scoping constrains normal inheritance, not platform authorization. Any same-user process can reproduce the provider invocation.
- **Rollout data**: Actual public keys and fingerprints do not exist until per-host enrollment. They are non-secret values to capture in host configuration only after probe success.
- **Check portability**: Darwin flake checks need fake-provider coverage; physical Secure Enclave tests remain operator-gated and host-specific.
- **Adjacent scope**: Do not add signing material to `mcp-secrets-sops-nix`, replace mcpproxy ownership, modify global host signing keys, or alter `git-clone-isolation`.

## Complexity and Risk

- **Effort**: L. The code footprint is moderate, but per-host enrollment, negative-path testing, and staged physical acceptance span several implementation waves.
- **Risk**: High until the first-host locked-screen and GitHub probes pass; Medium afterward because the remaining integration follows established Home Manager and test patterns.

## Design Synthesis

- Adopt the platform CTK and OpenSSH contracts; build only a thin Git signer adapter and lifecycle CLI.
- Keep `home-manager/mcp/default.nix` as the sole owner of the `git-mcp` server entry. Separate scripts own runtime signing and imperative identity lifecycle.
- Model an enrollment as one host declaration containing label, CTK hash, SSH public key, and fingerprint. Derive its resident-stub path from the CTK hash.
- Keep rotation additive: a candidate identity receives a separate state directory and cannot replace the active declaration until validation succeeds.
- Use direct provider signing. Do not add an agent, daemon, secret store, active-key symlink, or second mcpproxy registration.

## Design Validation Outcome

The first review returned `NO-GO` for missing active-enrollment detection, declaration before GitHub registration, and unbounded provider descendants. The revision added a Home Manager-derived active marker, explicit pre-selection registration attestation, and bounded worker-group cleanup. The later Go amendment defines immutable work, TERM, cleanup, and attempt deadlines around the direct worker and its owned group rather than promising control over arbitrary descendants. CTK lock-state and GitHub verification remain physical-host gates.

The pre-task review also made the admin package available while signing is disabled and classified the runbook and physical probes as required interface and integration-test deliverables. No separate deployment workstream was added.

## Amendment: Go Supervisor and Bounded Cleanup

- Darwin permits a process to reap only its direct children. The signer can terminate and observe a dedicated worker process group, but it cannot truthfully promise to reap arbitrary grandchildren or a process that leaves the group.
- The revised contract separates an immutable `T0 + 20s` work deadline from an immutable `T0 + 22s` attempt deadline. A successful worker result after the work deadline is a timeout, and every interrupted retry checks its absolute deadline before retrying.
- `proc_pidinfo(..., PROC_PIDTBSDINFO, 1, ...)` with `pbi_pgid` is required to observe Darwin process-group members, including `SZOMB`. A zombie is cleanup evidence until it disappears; `getpgid` is not sufficient for that observation.
- The signer runtime, worker, supervisor, and process-control helpers move to Go. The Darwin process inspection binding may use cgo inside the Go executable; it is not a standalone C helper. Node remains the repository's outer integration-test runner only.
