# Design Document

## Overview

This feature gives the `git-mcp` upstream a dedicated CTK-backed SSH signer while leaving global Git and SSH behavior unchanged. It adds a Go signer runtime, an operator lifecycle CLI, typed Home Manager configuration, and staged physical-host acceptance.

### Goals

- Sign every `git-mcp` commit with one non-exportable per-host identity.
- Continue signing after first unlock across screen lock and sleep.
- Fail closed on missing, ambiguous, or mismatched signing state.
- Prove environment isolation, native-provider behavior, and GitHub verification.

### Non-Goals

- Restricting platform signing access to the `git-mcp` process.
- Replacing global 1Password Git signing or SSH authentication.
- Managing private material through Nix, SOPS, Keychain generic-password items, or an agent.
- Changing mcpproxy routing, persistence, or unrelated upstream registrations.

## Boundary Commitments

### This Spec Owns

- The git-mcp-only Git configuration overlay and its typed per-host metadata.
- The Git SSH signer process contract and native-provider preflight.
- CTK identity bootstrap, resident-stub recovery, rotation staging, decommissioning, and acceptance evidence.
- Render, contract, isolation, and physical-host verification.

The per-host Nix declaration is authoritative for the active identity. Home Manager renders a non-secret active-enrollment marker from that declaration. CTK owns the private key. XDG state owns reconstructable resident stubs and acceptance evidence.

### Out of Boundary

- `home-manager/common/git.nix`, `home-manager/common/ssh.nix`, and the current public signing keys in both host `git.nix` files.
- Adding the dedicated key to GitHub authentication keys, SSH `IdentityFile`/`IdentityAgent` configuration, an `ssh-agent`, or `authorized_keys`.
- `mcp-secrets-sops-nix`, secret activation, and generic-password Keychain records.
- The mcpproxy launch wrapper, runtime config ownership, tool routing, and other upstreams.
- GitHub repository selection for the acceptance commit.
- Claiming control over a descendant that voluntarily creates another session or process group. The signer controls and verifies only members of its dedicated worker process group.

### Allowed Dependencies

- macOS `/usr/sbin/sc_auth`, `/usr/lib/ssh-keychain.dylib`, `/usr/bin/ssh-keygen`, CryptoTokenKit, and Secure Enclave.
- Git's SSH signing and process-runtime configuration interfaces.
- The existing `home.mcp` module, `git-mcp-server`, Nix packaging through `pkgs.buildGoModule`, the Go toolchain, Darwin process inspection through an in-process Go binding, XDG state, the Node outer test runner, and the flake check.
- GitHub's signing-key registration and commit-verification surfaces for operator acceptance.

No third-party signer, persistent `ssh-agent`, new daemon, secret pipeline, Node or JavaScript signer runtime, shell signer wrapper, or standalone C signer helper is allowed.

### Revalidation Triggers

- A macOS update changes `sc_auth`, the provider ABI/path, CTK accessibility, or selector behavior.
- Git changes `gpg.ssh.program`, `user.signingKey`, or environment-config precedence.
- `git-mcp-server` changes environment inheritance, commit arguments, unsigned retry behavior, or its 60-second timeout.
- mcpproxy changes explicit upstream-environment propagation.
- GitHub changes SSH-SK verification or signing-key registration policy.
- A host identity rotates, a new host is enrolled, or the state layout changes.

## Architecture

### Existing Architecture Analysis

`home-manager/mcp/default.nix` owns the common `git-mcp` server and passes its explicit environment through the mcpproxy renderer. The upstream copies that environment to shell-free Git subprocesses. Global Git selects 1Password, and common SSH selects the 1Password agent. The new path changes only the existing `git-mcp.env` attrset; no second server entry or launch path is introduced.

### Architecture Pattern and Boundary Map

```mermaid
graph LR
    HostConfig[Host enrollment declaration] --> MpcModule[Home Manager MCP module]
    MpcModule --> Mpp[mcpproxy]
    Mpp --> GitMcp[git mcp server]
    GitMcp --> Git[Git subprocess]
    Git --> Signer[Signer adapter]
    Signer --> AppleSsh[Apple ssh keygen]
    AppleSsh --> Provider[Apple keychain provider]
    Provider --> Ctk[CryptoTokenKit identity]
    Ctk --> Enclave[Secure Enclave]
    Admin[Lifecycle CLI] --> Ctk
    Admin --> Stub[Resident stub state]
    Stub --> Signer
    GlobalGit[Interactive Git] --> OnePassword[1Password signer]
```

**Architecture integration**:

- Pattern: hybrid extension. Existing server ownership is extended; native signing and lifecycle behavior live in new tools.
- Dependency direction: host declaration → mcpproxy rendering → Git environment → signer adapter → Apple tools. The lifecycle CLI writes state but never mutates the declarative host declaration.
- Existing patterns preserved: `buildGoModule`, typed Home Manager options, XDG state, Node integration tests, and the current flake check.

### Technology Stack

| Layer | Choice | Role |
|---|---|---|
| Configuration | Nix and Home Manager | Validate enrollment and render git-mcp-only environment |
| Runtime adapter | Nix-packaged Go binary | Public SSH signer dispatch, native preflight, fixed paths, and bounded worker-group cleanup |
| Platform | macOS 26 CTK, Secure Enclave, Apple OpenSSH | Store the non-exportable key and produce SSH signatures |
| State | XDG state files | Store resident handles, public keys, and acceptance evidence |
| Verification | Go, Node 22, Git, OpenSSH, Nix flake checks | Exercise deterministic supervision, render, contract, Git, and failure behavior |

## File Structure Plan

### New Files

```text
scripts/
├── git-mcp-secure-enclave-signer.nix    # buildGoModule package and fixed native-path injection
├── git-mcp-secure-enclave-signer/
│   ├── go.mod                            # Isolated Darwin signer module
│   ├── cmd/
│   │   ├── signer/main_darwin.go          # Public SSH signer dispatch
│   │   └── worker/main_darwin.go          # Private libexec worker entry
│   └── internal/
│       ├── signer/                        # Preflight validation and native execution
│       ├── supervisor/                    # Deadline state machine and process-group teardown
│       └── darwinproc/                    # In-process Darwin process inspection binding
└── git-mcp-secure-enclave-admin.nix      # Identity lifecycle and acceptance CLI package
tests/git-mcp/
├── signer-adapter.test.js                # Black-box Git and public signer contracts
├── admin-contract.test.js                # Lifecycle state-machine and export-selection contracts
├── upstream-isolation.test.js            # Failed-signing isolation across mcpproxy upstreams
└── fixtures/
    ├── process-control_darwin.go          # Go process identity and cleanup fixture CLI
    └── signing-tools.nix                  # Fake native tools and injectable package builds
docs/
└── git-mcp-secure-enclave-signing.md     # Operator runbook and accepted security boundary
```

### Modified Files

- `home-manager/mcp/default.nix` — Define signing options, derive paths/environment, render the active marker, assert metadata, install tools, and merge only into `git-mcp`.
- `configurations/personal/home-manager/default.nix` — Declare the personal host's new dedicated public metadata after enrollment.
- `configurations/shopify/home-manager/default.nix` — Declare the Shopify host's new dedicated public metadata after enrollment.
- `tests/git-mcp/hm-render.test.js` — Verify host-specific rendering, global compatibility, and upstream isolation.
- `tests/git-mcp/index.js` — Load all git-mcp test files.
- `flake.nix` — Add Git/OpenSSH test dependencies to the existing `git-mcp` check.

The host `git.nix` files, common Git/SSH modules, secret files, and roadmap are not modified.

## System Flows

### Runtime Signing

```mermaid
sequenceDiagram
    participant Agent
    participant GitMcp
    participant Git
    participant Signer
    participant Ctk
    Agent->>GitMcp: git commit request
    GitMcp->>Git: commit with inherited environment
    Git->>Signer: SSH sign command and resident stub
    Signer->>Signer: start bounded signing worker
    Signer->>Signer: validate provider identity stub and fingerprint
    Signer->>Ctk: sign through Apple provider
    alt signature succeeds
        Ctk-->>Signer: SSH SK signature
        Signer-->>Git: signature
        Git-->>GitMcp: signed commit
        GitMcp-->>Agent: commit result
    else preflight or provider fails
        Signer-->>Git: nonzero result and diagnostic
        Git-->>GitMcp: no commit
        GitMcp-->>Agent: error
    end
```

`commit.gpgSign=true` remains effective when upstream retries without `--gpg-sign`; the retry therefore cannot create an unsigned commit. For each signing attempt, the public Go signer captures `T0` before it starts its worker. The immutable work deadline is `T0 + 20 seconds` and covers worker startup, CTK identity listing, every preflight native call, Apple `ssh-keygen`, and delivery of the worker result. Cleanup begins on a terminal worker result, worker protocol failure, parent interruption, or work-deadline expiry. Its immutable deadline is the earlier of `cleanupStart + 2 seconds` and `T0 + 22 seconds`. A worker result at or after the work deadline is a timeout. A successful pre-deadline result is returned only after worker-group cleanup and direct-worker reaping finish before the work deadline.

| Transition | Result |
|---|---|
| Successful worker result and complete cleanup before `T0 + 20s` | Return `0`. |
| Nonzero worker result before `T0 + 20s` and complete cleanup by its cleanup deadline | Return the worker's nonzero status. |
| No result by `T0 + 20s`, or successful result whose cleanup/reaping/output relay completes at or after `T0 + 20s` | Return `124` after cleanup succeeds by `cleanupDeadline`. |
| Parent interruption with complete cleanup by `cleanupDeadline` | Return `128 + signal number`. |
| Group observation, output completion, or direct-worker reaping cannot complete by `cleanupDeadline` | Return `125` with a cleanup-uncertain diagnostic. |

`termDeadline` is the earlier of `cleanupStart + 1 second` and `T0 + 22 seconds`. `cleanupDeadline` is the earlier of `cleanupStart + 2 seconds` and `T0 + 22 seconds`. These values are calculated once when cleanup begins and are never extended.

### Supervisor State Machine

```text
Start
  -> Working
  -> CleanupTerm       result, protocol failure, interrupt, or work deadline
  -> CleanupKill       worker group remains at the TERM deadline
  -> VerifyGroup       no non-worker group member remains
  -> ReapDirectWorker
  -> RelayOutput       bounded native output copy completes
  -> Succeeded         successful result and cleanup before work deadline
  -> Failed            nonzero result before work deadline
  -> TimedOut          result absent or incomplete at work deadline
  -> Interrupted       parent signal and complete cleanup
  -> CleanupUncertain  group observation or direct-worker reaping missed cleanup deadline
```

Parent interruption takes precedence over a worker result. After clean bounded cleanup, it returns `128 + signal number`; cleanup uncertainty returns `125`. Every wait, read, process snapshot, signal retry, and sleep receives an immutable absolute deadline. An `EINTR` retry checks its deadline and pending parent signal before it retries. No retry may derive a new grace period.

### Enrollment and Rollout

```mermaid
stateDiagram-v2
    [*] --> Candidate: bootstrap new identity
    Candidate --> CandidateVerified: local sign and verify
    CandidateVerified --> GitHubRegistered: register as signing key
    GitHubRegistered --> Declared: add public metadata and registration attestation
    Declared --> Activated: activate and restart mcpproxy
    Activated --> Accepted: unlocked locked sleep and GitHub probes pass
    Activated --> RolledBack: any mandatory probe fails
    Accepted --> Candidate: rotate additively
    Accepted --> Decommissioned: disable then explicit removal
```

Candidate creation never overwrites the active identity directory. Rollback disables the host declaration and restores inherited global signing without deleting CTK state.

## Components and Interfaces

| Component | Intent | Requirement Coverage | Dependencies |
|---|---|---|---|
| Signing configuration | Render one validated git-mcp-only enrollment | 1, 2, 3, 5, 6, 9 | Home Manager P0; mcpproxy P0 |
| Signer adapter | Enforce identity/stub match and delegate Git's signer contract | 2, 4, 5, 6 | Apple OpenSSH P0; CTK P0 |
| Lifecycle CLI | Manage non-exportable identity lifecycle and evidence | 1, 4, 6, 7, 8, 10 | `sc_auth` P0; provider P0 |
| Test harness | Prove fail-closed behavior and boundary isolation | 2, 3, 5, 6, 9 | Nix P0; Node/Git/OpenSSH P0 |
| Runbook | Define operator and security procedures | 5, 7, 8, 10, 11 | GitHub P1 |

### Signing Configuration

The `home.mcp.gitMcpSigning` submodule has this contract:

| Option | Type and default | Constraint |
|---|---|---|
| `enable` | Boolean, `false` | Adds no signing environment when false |
| `stateDir` | Absolute string, `$XDG_STATE_HOME/git-mcp-secure-enclave-signing` | Host-local non-secret state |
| `identityLabel` | Nullable string | Required and non-empty when enabled |
| `ctkPublicKeyHash` | Nullable string | Required 40-character lowercase hex when enabled |
| `sshPublicKey` | Nullable string | Required `sk-ecdsa-sha2-nistp256@openssh.com` public key when enabled |
| `sshFingerprint` | Nullable string | Required `SHA256:` fingerprint when enabled |
| `githubSigningKeyRegistered` | Boolean, `false` | Must be explicitly true for the declared key when enabled |
| `signerPackage` | Package | Defaults to the production signer adapter |
| `adminPackage` | Package | Defaults to the production lifecycle CLI |

The resident stub path is derived as `<stateDir>/identities/<ctkPublicKeyHash>/id_ecdsa_sk_rk`. The signer and admin packages are installed whenever `home.mcp.enable` is true, so the admin CLI can bootstrap an unenrolled host while `gitMcpSigning.enable` remains false. A partial enabled declaration or missing GitHub-registration attestation fails Nix evaluation. When signing is enabled, Home Manager renders `$XDG_CONFIG_HOME/git-mcp-secure-enclave-signing/active.json` from the same declaration; the lifecycle CLI treats its presence as the active-enrollment signal.

The module merges these non-secret values only into the existing `git-mcp.env`:

| Variable | Value or role |
|---|---|
| `GIT_SIGN_COMMITS` | `true`, pinning upstream signing intent |
| `GIT_CONFIG_COUNT` | `4` |
| Pair `0` | `commit.gpgSign=true` |
| Pair `1` | `gpg.format=ssh` |
| Pair `2` | `gpg.ssh.program=<signer adapter>` |
| Pair `3` | `user.signingKey=<resident stub>` |
| `SSH_SK_PROVIDER` | `/usr/lib/ssh-keychain.dylib` |
| `KEYCHAIN_CERTIFICATES` | The configured CTK public-key hash only |
| `GIT_MCP_SIGNING_CTK_HASH` | Expected CTK hash |
| `GIT_MCP_SIGNING_PUBLIC_KEY` | Expected SSH public key |
| `GIT_MCP_SIGNING_FINGERPRINT` | Expected SSH fingerprint |
| `GIT_MCP_SIGNING_STUB` | Derived resident-stub path |

Existing `MCP_SESSION_MODE` and `STORAGE_PROVIDER_TYPE` values are merged unchanged. The module does not set or clear `SSH_AUTH_SOCK`; SSH transport may continue using the global 1Password agent while signing uses the resident stub directly.

### Signer Adapter

The signer package is one Darwin-only Go module built with `buildGoModule`, `CGO_ENABLED=1`, and Darwin build tags. It installs a public signer executable and a private Go worker in its package `libexec` directory. Non-signing SSH-program operations `exec` the fixed Apple `ssh-keygen` path with the original argument vector. For each recognized `-Y sign` form, the public command starts the fixed private worker in a new session and process group before any validation or native operation.

The worker ports the provider, selector, stub, public-key, fingerprint, and CTK identity checks to Go. Native paths are injected only at Nix build time. It invokes `sc_auth` and Apple `ssh-keygen` without a shell, preserves native stdout and stderr through bounded temporary capture, and never invokes an agent or fallback signer.

The public signer owns one direct worker child. The worker accepts only a one-shot random capability over an inherited anonymous socketpair and verifies that its direct parent is the fixed public signer executable. This prevents normal direct invocation of the private worker without claiming same-user platform authorization. While the direct child remains unreaped, the supervisor may signal only the negative worker process-group ID. It observes the group before it reaps the direct child, then returns the recorded worker result only if the work deadline permits it. It never sends another group signal after direct-worker reaping, so a reused PID cannot become a signal target.

A Darwin-only in-process Go binding enumerates process records with `proc_listpids` and `proc_pidinfo(..., PROC_PIDTBSDINFO, 1, ...)`, uses `pbi_pgid` for membership, and treats `SZOMB` as present. The binding is compiled into the Go executable; it is not a standalone C helper or executable.

The signer reaps only its direct worker child. It terminates and observes other worker-group members, including zombies, but does not claim to reap grandchildren. A process that voluntarily creates another session or process group is outside this ownership contract.

### Lifecycle CLI

**Command contract**:

| Command | Effect | Idempotency and failure rule |
|---|---|---|
| `bootstrap --label <label>` | Create one `p-256-ne` identity with protection `none`, export its resident stub, and print public metadata | Require no active marker and an empty managed `identities` directory; direct existing state to doctor, recovery, or explicit decommission |
| `doctor --hash <hash>` | Validate platform paths, identity, selector, stub, public key, fingerprint, and local sign/verify | Read-only |
| `probe --hash <hash>` | Produce and locally verify a disposable signature | Writes only temporary probe data |
| `recover-stub --hash <hash>` | Re-export and atomically restore matching non-secret stub files | Require the active marker to match; leave prior valid state unchanged on ambiguity or failure |
| `rotate --label <label>` | Require an active marker, create a separate candidate, and print a replacement Nix declaration with registration attestation disabled | Never changes or deletes the active identity |
| `record-acceptance --hash <hash> --unlocked-commit <sha> --locked-commit <sha> --sleep-commit <sha> --reboot-commit <sha> --github-commit <sha> --github-verified` | Verify the local probe commits and atomically record host, OS, probe states, and the operator-confirmed GitHub result | Require the active marker to match; reject incomplete, unsigned, or mismatched evidence |
| `decommission --hash <hash> --fingerprint <fingerprint>` | Delete the exact CTK identity and its local state after explicit confirmation | Never use delete-all; refuse hash/fingerprint mismatch or an active marker that selects the target; allow the marker to be absent or to select a replacement |

Bootstrap checks the Home Manager-derived active marker and managed identities directory before creating anything. It then compares CTK identity sets before and after creation, requires exactly one new hash, sets `KEYCHAIN_CERTIFICATES` to that hash, exports into an empty temporary directory, and selects output by SSH fingerprint. It atomically installs only the selected stub and `.pub` after local signature verification. The CLI never edits repository configuration or calls GitHub APIs.

### Test Harness and Runbook

The fixture builds signer/admin packages against deterministic fake `sc_auth`, provider, and `ssh-keygen` commands. `tests/git-mcp/fixtures/process-control_darwin.go` is built through `signing-tools.nix` with the Go toolchain and retains the fixture process-control CLI contract. Go owns signer runtime, supervisor state, and process-control helper behavior. Node remains the outer test runner for black-box Git, render, lifecycle, and upstream integration contracts. The runbook owns manual registration, per-host activation, actual locked/sleep probes, GitHub `Verified` confirmation, rollback, and lifecycle recovery.

The Go-port task rewrites the Node signer suite in the same change that removes legacy C/shell expectations. The suite exercises only the public Go package as an outer runner; deterministic deadline, signal, process-group, and `EINTR` behavior remains in Go tests. No approved task may intentionally leave the canonical signer suite red between these two representations.

## Data Models

### Declarative Enrollment

```text
HostEnrollment = {
  identityLabel: non-empty string
  ctkPublicKeyHash: 40 lowercase hexadecimal characters
  sshPublicKey: sk-ecdsa-sha2-nistp256 OpenSSH public key
  sshFingerprint: SHA256 OpenSSH fingerprint
  githubSigningKeyRegistered: true
}
```

Invariants: the four identity fields identify one key; the CTK hash selects one provider identity; the SSH values match the resident stub; registration attestation is explicit; no field is secret.

### Host-Local State

```text
$XDG_STATE_HOME/git-mcp-secure-enclave-signing/
├── identities/<ctk-hash>/id_ecdsa_sk_rk
├── identities/<ctk-hash>/id_ecdsa_sk_rk.pub
└── acceptance/<ctk-hash>.json

$XDG_CONFIG_HOME/git-mcp-secure-enclave-signing/
└── active.json
```

The stub contains a provider credential handle, not private key material. Directory and file permissions protect integrity, not secrecy. `active.json` is a Home Manager-generated projection of the active Nix declaration, including `stateDir`; it is not independently writable lifecycle state. The acceptance record contains schema version, host, macOS version, CTK hash, SSH fingerprint, tested states, commit identifier, GitHub verification result, timestamps, and no private material.

## Error Handling

| Condition | Responsible component | Response |
|---|---|---|
| Enabled declaration incomplete or malformed | Signing configuration | Abort evaluation with the option and expected form |
| Provider path absent | Signer or CLI | Exit nonzero and name `/usr/lib/ssh-keychain.dylib` |
| Identity absent | Signer or CLI | Exit nonzero with configured hash and bootstrap/recovery command |
| Stub absent or malformed | Signer | Exit before Git signing and name the path |
| Public key or fingerprint mismatch | Signer or CLI | Exit before signing; print expected and observed public identifiers |
| Export returns zero or multiple candidates | Lifecycle CLI | Install nothing; report candidates and recovery steps |
| Provider rejects signing | Signer | Preserve stderr and mention first unlock after reboot |
| Work deadline expires before worker result | Signer adapter | Enter cleanup immediately, terminate the dedicated worker group, and return exit `124` only if group absence and direct-worker reaping are proven by the cleanup deadline. |
| Cleanup deadline expires or group observation fails | Signer adapter | Return exit `125` with a cleanup-uncertain diagnostic. Never return signing success or claim descendant reaping. |
| Any physical probe fails | Rollout workflow | Disable or retain disabled config; keep identity for diagnosis |

Signer failure affects only the current Git command. It does not stop mcpproxy or modify another upstream.

## Testing Strategy

### Render Tests

- Evaluate both hosts and assert one `git-mcp` entry, preserved hardening variables, exact four Git config pairs, native provider, distinct metadata, and signer/stub paths.
- Assert every other upstream lacks signing variables.
- Evaluate global Git and SSH settings to prove 1Password signer, existing public keys, and `IdentityAgent` remain unchanged.
- Scan rendered values and repository paths for private-key blocks, `op://` signing material, authentication registration, and `authorized_keys` changes.

### Signer and Git Contract Tests

- Inject fake native tools to cover success, non-sign passthrough, missing provider, missing identity, missing stub, malformed stub, hash/public-key/fingerprint mismatch, ambiguous identity, provider failure, and first-unlock guidance.
- Verify the adapter preserves Git's `-Y sign` arguments and never invokes an agent or fallback signer.
- Use temporary Git repositories to prove environment config overrides conflicting global signing settings, successful commits contain a signature, and both upstream attempts fail without moving `HEAD` when signing fails.
- Move signer-supervisor tests into the Go package. Use a fake monotonic clock, result observer, process inspector, signaler, reaper, and output relay to test every state transition without wall-clock races.
- Deterministically inject `EINTR` into result reads, worker observation, group inspection, termination waits, direct-worker reaping, and output relay. Every test advances the fake clock to prove retries stop at the work or cleanup deadline.
- Replace the Node late-descendant fixture with a Go helper-process test using pipe barriers. The worker-group observation gains a member after `SIGTERM`; the test proves the bounded `SIGKILL` phase, group verification, and direct-worker reaping without deriving a fresh deadline.
- Test an exact-deadline worker result, exact-deadline cleanup, incomplete output relay, persistent zombie, parent interruption, and repeated `EINTR`; none may return signing success.
- Hang CTK identity listing, each preflight native call, and provider signing through the public signer; assert the work and cleanup deadlines, unchanged `HEAD`, no unsigned retry commit, and no surviving owned worker-group member.
- Start mcpproxy with a failing signing fixture and an independent fake upstream; prove the failed Git call does not stop mcpproxy or the sibling upstream.

### Lifecycle CLI Tests

- Model identity-set before/after behavior, one-new-identity selection, temporary export enumeration, atomic install, and local verification.
- Prove bootstrap refuses an active marker and non-empty managed identity state, recovery preserves valid state on failure, rotation is additive, and decommission requires exact hash/fingerprint without deleting the active identity or using delete-all.
- Validate acceptance record schema and rejection of incomplete or mismatched evidence.

### Repository Policy Tests

- Scan implementation and host-configuration paths for serialized private-key blocks, signing material in SOPS/generic-password declarations, GitHub authentication-key registration, SSH `IdentityFile`/`IdentityAgent` additions, `ssh-agent` loading, and `authorized_keys` installation.
- Exclude specs, runbook prose, and negative test fixtures from literal-string findings while still validating their executable outputs.
- Assert the host `git.nix` files and common Git/SSH modules retain their expected 1Password paths/public keys and contain no feature-specific declarations.

### Physical-Host Acceptance

- On each host: bootstrap, run the local unlocked probe, and register the public key with GitHub as a signing key only.
- Add the host declaration with registration attestation, activate it, then perform actual `git-mcp` signed commits unlocked, while screen-locked, and after sleep; inspect every signature.
- Reboot each host, complete the first unlock, and prove the same enrolled identity signs without rotation or GitHub re-registration.
- Push a probe commit to an operator-selected repository and confirm `Verified`.
- Record evidence with the lifecycle CLI. No host is complete until locked-screen, post-sleep, post-reboot, and GitHub checks pass.

## Security Considerations

- Private keys remain in Secure Enclave-backed CTK identities and are never serialized by repository tooling.
- `-t none` removes user-presence protection to satisfy locked-session signing. This is an explicit availability/security trade-off.
- Environment and Nix state contain public identifiers and paths only.
- A same-user attacker can invoke `/usr/bin/ssh-keygen` with the provider and readable resident stub. Environment scoping is not an authorization boundary.
- Local fingerprint checks detect accidental or opportunistic stub substitution but do not defend against a process that can also alter the user's declarative configuration or running environment.
- Repository-managed configuration registers the dedicated key only through GitHub's signing-key surface and adds it to no SSH client, agent, server, or GitHub authentication-key surface.

## Migration and Rollout

- Land the disabled option surface, packages, and fake-provider tests first.
- Build or activate the admin package while signing remains disabled; identity bootstrap has no active-signing prerequisite.
- Bootstrap a candidate identity on each host, register its public key through GitHub's signing-key surface only, and capture its declaration with explicit registration attestation. No identity is copied between hosts.
- Enable one host declaration at a time, activate, restart mcpproxy, and run all physical probes.
- On failure, disable that host's option and restart mcpproxy. Global Git remains the 1Password rollback path; CTK state remains for diagnosis.
- Mark a host complete only after its acceptance JSON records unlocked, locked-screen, post-sleep, post-reboot, and GitHub verification success.
- Rotation creates a candidate in a new hash-keyed directory, validates it, registers it with GitHub, updates the host declaration only after registration, reruns acceptance, then explicitly decommissions the old identity.

The versioned runbook is a required operator interface artifact. Physical-host probes are implementation integration tests against external platform contracts; activation and reboot are test preconditions with defined rollback, not an independent deployment workstream.

## Requirements Traceability

| Requirement IDs | Design coverage | Primary validation |
|---|---|---|
| 1.1, 1.2, 1.3, 1.4, 1.5 | Per-host declaration, CTK lifecycle, boundary commitments | CLI and host enrollment tests |
| 2.1, 2.2, 2.3, 2.4, 2.5 | Git config overlay and signer adapter | Temporary Git and physical commit probes |
| 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7 | Environment merge and unchanged global files | Dual-host render and upstream-isolation tests |
| 4.1, 4.2, 4.3, 4.4, 4.5 | `-t none`, first-unlock diagnostics, host rollout | Unlocked, locked, sleep, and reboot checks |
| 5.1, 5.2, 5.3, 5.4, 5.5, 5.6 | State model and security boundary | Repository scan, state inspection, runbook review |
| 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10 | Selector, absolute work and cleanup deadlines, interruption precedence, group observation, and error isolation | Deterministic supervisor tests, negative contracts, and upstream health check |
| 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7 | Bootstrap and registration workflow | CLI tests and per-host enrollment |
| 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7 | Hash-keyed candidate lifecycle | Rotation, recovery, and decommission tests |
| 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7 | Git-mcp test harness, Go supervisor tests, and flake integration | Existing `git-mcp` flake check |
| 10.1, 10.2, 10.3, 10.4, 10.5, 10.6 | Per-host acceptance workflow and evidence | Physical probes and GitHub `Verified` result |
| 11.1, 11.2, 11.3, 11.4 | Operator runbook | Documentation review against checklist |
