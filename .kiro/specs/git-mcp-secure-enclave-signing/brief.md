# Brief: git-mcp-secure-enclave-signing

## Problem

> git-mcp runs outside OpenCode’s sandbox but global Git commit signing uses 1Password `op-ssh-sign`; 1Password requires user interaction and fails for agent commits while macOS is locked although the user remains logged in.

The operator cannot rely on `git-mcp` to create signed commits during unattended agent work. Unlocking 1Password or approving each signature defeats the out-of-sandbox Git workflow.

## Current State

`git-mcp` is a common mcpproxy upstream with stateless, in-memory server posture. Its Git subprocesses inherit the user's global SSH-signing configuration, including the 1Password signer. Personal and Shopify hosts have distinct existing public signing keys, and common SSH uses the 1Password `IdentityAgent`.

No repository-managed Secure Enclave signer, per-host CTK identity lifecycle, git-mcp-specific Git override, or locked-screen acceptance probe exists.

## Desired Outcome

Each host has a dedicated, non-exportable Secure Enclave identity that repository configuration selects and registers only for Git commit signing. `git-mcp` can use it after the host's first unlock, including across screen lock and sleep until reboot. Interactive Git, Graphite, SSH authentication, and all other mcpproxy upstreams retain their existing behavior.

## Approach

Use macOS CryptoTokenKit with a per-host `p-256-ne` identity created by `sc_auth ... -t none`. A git-mcp-specific Go signer invokes `/usr/bin/ssh-keygen` with `/usr/lib/ssh-keychain.dylib` and a local resident-key stub. Its monotonic work deadline and bounded process-group cleanup prevent one signing request from consuming git-mcp's 60-second upstream timeout. Command-scoped Git configuration in the `git-mcp` upstream selects the signer and stub without changing global Git configuration.

Pin the intended CTK identity with `KEYCHAIN_CERTIFICATES` where supported. Fail closed with actionable diagnostics when the provider, stub, identity, or provider operation is unavailable or mismatched. Validate the undocumented locked-screen behavior empirically on every host.

Rejected alternatives are Secretive, exportable private keys, SOPS-managed signing material, macOS generic-password items, biometric protection, and a persistent `ssh-agent`. They either add a dependency, permit extraction, require user presence, or widen runtime state.

## Scope

- **In**:
  - A dedicated CTK identity configured and registered only for Git commit signing, plus a non-secret resident-key stub per host.
  - A git-mcp-specific Go signer and command-scoped Git configuration.
  - Per-host bootstrap, GitHub signing-key registration, validation, rotation, recovery, and decommission procedures.
  - Render, contract, failure-path, and physical-host locked-screen verification.
  - Clear documentation of the same-user process authorization boundary.
- **Out**:
  - Changes to global or interactive Git signing.
  - Changes to the 1Password SSH `IdentityAgent` or existing host signing public keys.
  - Adding the dedicated key to GitHub authentication keys, SSH `IdentityFile`/`IdentityAgent` configuration, an `ssh-agent`, or `authorized_keys`.
  - Private-key export, backup, synchronization, escrow, or secret-pipeline integration.
  - Changes to mcpproxy's core routing, persistence, quarantine, or other upstream servers.

## Boundary Candidates

- Declarative git-mcp signing configuration and signer contract.
- Imperative per-host identity lifecycle and empirical acceptance evidence.
- Automated configuration, isolation, and failure-path verification.

## Out of Boundary

- The feature does not restrict Secure Enclave signing requests to `git-mcp`. Any process running as the same logged-in user that can invoke the provider may request signatures.
- The feature does not modify `mcp-secrets-sops-nix`, store signing material in Nix/SOPS/Keychain generic-password records, or extend the secrets pipeline.
- The feature does not redesign the mcpproxy orchestrator or Git clone isolation.
- The feature does not guarantee unattended signing before the first unlock after boot.
- The signer reaps its direct worker child and verifies its dedicated worker process group. It does not claim to reap grandchildren or processes that leave that group.

## Upstream / Downstream

- **Upstream**: macOS CryptoTokenKit, Secure Enclave, `sc_auth`, Apple's SSH SecurityKeyProvider, OpenSSH `ssh-keygen`, Git SSH signing, Home Manager's mcpproxy rendering, and per-host Git identity configuration.
- **Downstream**: `git-mcp` commit operations and operator registration of each host's public key as a GitHub signing key.

## Existing Spec Touchpoints

- **Extends**: None. This is a new single-scope spec.
- **Adjacent**: `mcpproxy-migration` owns the orchestrator; `mcp-secrets-sops-nix` excludes SSH signing material; `git-clone-isolation` owns clone behavior only.

## Constraints

- Target the native paths `/usr/sbin/sc_auth`, `/usr/lib/ssh-keychain.dylib`, and `/usr/bin/ssh-keygen`.
- Identity protection is `none`, not `bio`, because locked-screen signing cannot satisfy user-presence authentication.
- The Secure Enclave private key never enters Nix, SOPS, generic-password Keychain items, mcpproxy configuration, environment variables, or disk.
- The resident-key stub, key handle, public key, certificate selector, and fingerprints are non-secret per-host state.
- Every new host and every rotation creates a new non-exportable identity and requires GitHub signing-key registration.
- A reboot requires first unlock before unattended signing resumes.
- Signer runtime wrappers and process-control helpers are Go programs. Node remains only the existing outer test runner.
- The existing cost-reduction roadmap remains unchanged.
