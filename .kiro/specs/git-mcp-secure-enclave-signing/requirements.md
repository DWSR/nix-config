# Requirements Document

## Introduction

`git-mcp-secure-enclave-signing` provides unattended signed commits for the `git-mcp` upstream without changing interactive Git or SSH authentication. See `brief.md` for the problem, selected platform approach, and scope.

## Boundary Context

- **In scope**: Per-host signing identity lifecycle, git-mcp-only signing selection, failure diagnostics, operator procedures, automated isolation checks, and physical-host locked-screen acceptance.
- **Out of scope**: Global signer changes, adding the dedicated key to SSH authentication configuration, private-key export or secret-pipeline storage, mcpproxy redesign, and restrictions that prevent other same-user processes from invoking the platform signer.
- **Adjacent expectations**: Existing 1Password Git and SSH behavior, host author identities and signing keys, git-mcp stateless/in-memory posture, other mcpproxy upstreams, and adjacent specs remain unchanged.
- **Runtime ownership boundary**: The signer controls ordinary descendants that remain in its dedicated worker process group. It reaps only its direct worker child and fails closed rather than claiming to reap a grandchild or a process that leaves that group.

## Requirements

### Requirement 1: Dedicated per-host signing identity

**Objective:** As the host operator, I want each host to use its own hardware-backed signing identity, so that agent commits do not depend on an exportable or shared private key.

#### Acceptance Criteria

1. The Git MCP Signing System shall use a distinct signing identity on each enrolled host.
2. The Git MCP Signing System shall keep each signing identity's private key non-exportable.
3. The Git MCP Signing System shall NOT copy a signing identity between hosts.
4. The Git MCP Signing System shall configure the dedicated identity only as a signer for Git commit operations.
5. The Git MCP Signing System shall register the dedicated public key only through GitHub's signing-key surface and shall NOT register it as a GitHub authentication key.

### Requirement 2: Signed git-mcp commits

**Objective:** As an agent user, I want commits created through `git-mcp` to use the dedicated identity, so that unattended commits remain signed.

#### Acceptance Criteria

1. When `git-mcp` creates a commit on an enrolled host, the Git MCP Signing System shall sign the commit with that host's dedicated identity.
2. When a signed `git-mcp` commit is inspected, the commit shall contain an SSH signature verifiable against the enrolled dedicated public key.
3. If the dedicated identity cannot sign a `git-mcp` commit, the Git MCP Signing System shall fail the commit without creating an unsigned commit.
4. If dedicated signing fails, the Git MCP Signing System shall NOT fall back to the global 1Password signer or another available identity.
5. The Git MCP Signing System shall preserve the host's existing Git author name and email for `git-mcp` commits.

### Requirement 3: Runtime scope isolation

**Objective:** As the operator, I want the dedicated signer selected only for the `git-mcp` upstream, so that unrelated Git and MCP workflows do not change.

#### Acceptance Criteria

1. While Git runs as a descendant of the managed `git-mcp` upstream, the Git MCP Signing System shall select the dedicated signing configuration.
2. While Git runs outside the managed `git-mcp` upstream, the Git MCP Signing System shall leave the existing global 1Password signing configuration effective.
3. The Git MCP Signing System shall leave the existing per-host global signing public keys unchanged.
4. The Git MCP Signing System shall leave the common 1Password SSH `IdentityAgent` configuration unchanged.
5. The Git MCP Signing System shall NOT add the dedicated identity to SSH `IdentityFile` or `IdentityAgent` configuration, load it into an `ssh-agent`, or place it in an `authorized_keys` file.
6. When mcpproxy renders or starts an upstream other than `git-mcp`, the Git MCP Signing System shall leave that upstream's command, environment, and behavior unchanged.
7. The Git MCP Signing System shall preserve `git-mcp`'s existing stateless and in-memory configuration.

### Requirement 4: Locked-session availability

**Objective:** As the operator, I want unattended signing after the first unlock, so that screen lock and sleep do not block agent commits.

#### Acceptance Criteria

1. While the host has completed its first user unlock after boot, the Git MCP Signing System shall sign without a biometric prompt or other user-presence approval.
2. When the screen is locked after the first unlock, the Git MCP Signing System shall continue to sign `git-mcp` commits.
3. When the host resumes from sleep after the first unlock, the Git MCP Signing System shall continue to sign `git-mcp` commits.
4. If signing is attempted before the first user unlock after boot, the Git MCP Signing System shall fail closed with a diagnostic that identifies the first-unlock precondition.
5. When the host reboots and the user completes the first unlock, the Git MCP Signing System shall resume using the enrolled identity without requiring rotation or GitHub re-registration.

### Requirement 5: Private-material exclusion and accepted security boundary

**Objective:** As the operator, I want explicit private-key and authorization boundaries, so that the feature's protection is not overstated.

#### Acceptance Criteria

1. The Git MCP Signing System shall NOT place private key material in Nix expressions, the Nix store, SOPS data, generic-password Keychain items, mcpproxy configuration, environment variables, logs, or disk files.
2. When the Git MCP Signing System persists a local key reference or resident-key stub, that artifact shall contain no private key material.
3. The Git MCP Signing System shall treat the dedicated public key, fingerprint, identity selector, and resident-key stub as non-secret host-local state.
4. The operator documentation shall state that hardware-backed non-exportability does not provide process-level authorization.
5. The operator documentation shall state that any process running as the logged-in user and able to invoke the signing provider can request signatures from the dedicated identity.
6. The Git MCP Signing System shall NOT claim that the platform prevents same-user processes outside `git-mcp` from invoking the dedicated identity.

### Requirement 6: Identity selection and fail-closed diagnostics

**Objective:** As the operator, I want deterministic identity selection and actionable failures, so that signing never silently uses the wrong key.

#### Acceptance Criteria

1. When more than one compatible signing identity exists, the Git MCP Signing System shall select only the identity configured for the current host.
2. If the configured identity is absent, the Git MCP Signing System shall fail before commit creation and identify the missing identity.
3. If the signing provider is absent or cannot be loaded, the Git MCP Signing System shall fail before commit creation and identify the provider path.
4. If the resident-key stub is absent, unreadable, or malformed, the Git MCP Signing System shall fail before commit creation and identify the stub path.
5. If the stub, configured public key, fingerprint, and selected identity do not refer to the same key, the Git MCP Signing System shall fail before commit creation and report the mismatch without exposing private material.
6. If identity export yields no matching artifact or multiple ambiguous artifacts, the Git MCP Signing System shall fail with recovery guidance and shall NOT select an arbitrary artifact.
7. When the signer accepts a signing invocation, the Git MCP Signing System shall capture an absolute monotonic work deadline exactly 20 seconds later and an absolute attempt deadline exactly 22 seconds later. A successful worker result, worker-group observation, direct-worker reaping, and output relay completed before the work deadline shall return exit `0`. A worker result received at or after the work deadline, or a successful result whose cleanup or output relay completes at or after the work deadline, shall return exit `124` if cleanup completes by the cleanup deadline. At cleanup start, the system shall calculate one immutable TERM deadline as the earlier of cleanup start plus one second and the attempt deadline, and one immutable cleanup deadline as the earlier of cleanup start plus two seconds and the attempt deadline. No retry shall extend either deadline.
8. If dedicated signing fails, mcpproxy and upstreams other than `git-mcp` shall remain available.
9. When a signing worker reports a terminal result or the work deadline expires, the Git MCP Signing System shall terminate only its dedicated worker process group, reap its direct worker child, and return success only after observing no other member of that group and completing its bounded output relay before the work deadline. If group observation, direct-child reaping, or output completion cannot be established by the immutable cleanup deadline, the system shall return exit `125` with a cleanup-uncertain diagnostic.
10. When the signer receives a parent interruption signal, the Git MCP Signing System shall begin the same bounded cleanup before returning any worker result. If cleanup completes by the cleanup deadline, it shall return exit `128` plus the received signal number. If cleanup is uncertain, it shall return exit `125`.

### Requirement 7: Per-host bootstrap and GitHub enrollment

**Objective:** As the operator enrolling a host, I want a repeatable bootstrap workflow, so that the non-exportable identity and its public artifacts are created and verified safely.

#### Acceptance Criteria

1. When the operator bootstraps an unenrolled host, the workflow shall create a new non-exportable signing identity protected for unattended use after first unlock.
2. When bootstrap succeeds, the workflow shall produce the host-local non-secret artifacts required for signing and display the public key and fingerprint for verification.
3. If bootstrap detects an existing enrollment, the workflow shall refuse to replace it unless the operator invokes the documented rotation workflow.
4. When bootstrap validates the new identity, the workflow shall prove that its public key verifies a test signature before reporting success.
5. The bootstrap workflow shall instruct the operator to add the dedicated public key to GitHub as a signing key only.
6. The bootstrap workflow shall instruct the operator NOT to add the dedicated public key as an authentication key or to any `authorized_keys` file.
7. When a new host is added, the workflow shall create and enroll a new host-specific identity instead of copying an existing host's artifacts.

### Requirement 8: Rotation, recovery, and decommissioning

**Objective:** As the operator, I want lifecycle procedures that respect non-exportability, so that key loss or rotation does not encourage private-key extraction.

#### Acceptance Criteria

1. When the operator rotates a host identity, the workflow shall create a new non-exportable identity and distinct public key.
2. When rotation is in progress, the workflow shall keep the previous enrollment usable until the replacement has passed local verification and GitHub signing-key registration.
3. If rotation fails before replacement validation, the workflow shall leave the previous enrollment selected and usable.
4. When rotation succeeds, the workflow shall select the replacement identity and provide steps to remove the previous GitHub signing key and local identity.
5. If non-secret local artifacts are lost while the enrolled identity remains usable, the recovery workflow shall reconstruct or reselect those artifacts and verify their match before use.
6. If the non-exportable identity is lost or the host is replaced, the recovery workflow shall require creation and GitHub registration of a new per-host identity.
7. When the operator decommissions a host enrollment, the workflow shall remove its local non-secret artifacts and instruct the operator to remove its GitHub signing key and platform identity.

### Requirement 9: Automated configuration and contract verification

**Objective:** As the maintainer, I want repeatable tests for signing scope and failure behavior, so that configuration changes cannot silently weaken the boundary.

#### Acceptance Criteria

1. When the Home Manager render tests run, the test suite shall verify the dedicated signing configuration for both managed hosts.
2. When the Home Manager render tests run, the test suite shall verify that both hosts retain distinct dedicated identity metadata and existing `git-mcp` hardening settings.
3. When the signer contract tests run, the test suite shall verify successful signing, signature-key matching, each specified fail-closed condition, absolute work and cleanup deadlines, direct-worker reaping, worker-group absence or cleanup uncertainty, and bounded interrupted retries with their specified exit status without requiring physical Secure Enclave access.
4. When the scope-isolation tests run, the test suite shall verify that `git-mcp` selects the dedicated signer and an unrelated Git process retains the global 1Password signer.
5. When the upstream-isolation tests run, the test suite shall verify that no unrelated mcpproxy upstream receives the dedicated signing configuration.
6. When repository checks run, the test suite shall verify that no private key, authentication-key registration, `authorized_keys` entry, or secret-pipeline declaration is introduced by the feature.
7. When the existing `git-mcp` flake check runs, the test suite shall execute the render, signer-contract, and deterministic signer-supervisor coverage.

### Requirement 10: Physical-host acceptance evidence

**Objective:** As the operator, I want empirical validation on every host, so that undocumented platform behavior is proven before rollout is accepted.

#### Acceptance Criteria

1. When a managed host is enrolled, the operator shall run an unlocked-session signing probe and verify the signature against that host's dedicated public key.
2. When a managed host is enrolled, the operator shall lock the screen, run a `git-mcp` commit probe without approving user presence, and verify the resulting signature against that host's dedicated public key.
3. When a managed host resumes from sleep after first unlock, the operator shall run a `git-mcp` commit probe and verify the resulting signature against that host's dedicated public key.
4. When physical-host acceptance is completed, the operator shall confirm that GitHub marks a commit signed by the dedicated identity as verified under its signing-key registration.
5. When host acceptance is recorded, the evidence shall identify the host, macOS version, public-key fingerprint, tested states, GitHub verification result, and pass or fail result without recording private material.
6. If a managed host has not passed the locked-screen and GitHub verification probes, rollout of the Git MCP Signing System on that host shall NOT be considered complete.

### Requirement 11: Operator documentation

**Objective:** As a future operator, I want a concise runbook, so that enrollment and failure recovery do not require reconstructing the design.

#### Acceptance Criteria

1. The operator documentation shall cover bootstrap, local verification, GitHub signing-key registration, first-unlock behavior, locked-screen acceptance, rotation, recovery, and decommissioning.
2. The operator documentation shall distinguish non-secret local artifacts from prohibited private-key material.
3. The operator documentation shall describe diagnostics and recovery steps for a missing provider, missing or mismatched stub, absent identity, ambiguous identity export, and provider failure.
4. The operator documentation shall state that global Git signing and 1Password SSH authentication remain unchanged.
