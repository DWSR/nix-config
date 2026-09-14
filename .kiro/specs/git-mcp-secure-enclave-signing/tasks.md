# Implementation Plan

- [ ] 1. Build the deterministic test foundation
- [x] 1.1 Create injectable native-signing fixtures
  - Model identity snapshots, zero/one/multiple resident exports, hangs in CTK listing and every preflight/provider phase, and worker-tree termination without touching host CTK state.
  - Expose signer and admin package builds whose native tool paths are replaced only at Nix build time.
  - Complete when every platform scenario runs in an isolated temporary directory with inspectable calls and results.
  - _Requirements: 6.3, 6.6, 6.7, 9.3_
  - _Boundary: Test Harness_
  - _Reopened: Hang-fixture descendants must wait for Go-owned worker-group publication before entering their hang; the current parent/descendant startup race can exhaust the shared two-second readiness budget._
  - _Reopened: Fake-agent startup must retain a Go-owned lifecycle record before socket readiness, so a readiness timeout cannot leave the child alive._

- [x] 1.2 Extend the existing git-mcp check runtime
  - Add Git, OpenSSH, mcpproxy, and process-control utilities to the existing check without creating another check.
  - Preserve the current dual-host render entry point.
  - Complete when the unchanged current git-mcp suite passes with the expanded runtime.
  - _Requirements: 9.7_
  - _Boundary: Test Harness_

- [ ] 2. Implement the native signing tools
- [x] 2.1 Port the public signer and worker to Go
  - Replace the embedded shell/C runtime in `scripts/git-mcp-secure-enclave-signer.nix` with a Darwin-only `buildGoModule` package, public signer command, private worker command, one-shot capability handoff, and Go worker preflight contract while retaining Nix build-time native-path injection.
  - Preserve direct non-signing Apple `ssh-keygen` passthrough, original argument order, native output, provider/selector/stub/public-key/fingerprint validation, and no-agent/no-fallback behavior.
  - Rewrite `tests/git-mcp/signer-adapter.test.js` as a Node outer-runner black-box contract for the public Go package before deleting legacy C/shell expectations. Keep all supervisor state tests in Go and do not introduce a Node or JavaScript signer helper.
  - Complete when the public command and fixed private worker build as Go, direct private-worker invocation fails before preflight, `node --test tests/git-mcp/signer-adapter.test.js` passes against the Go package, and the signer package contains no embedded shell, standalone C runtime, or JavaScript signer wrapper. Task 2.9 solely owns shared process-control fixture migration and removal.
  - _Requirements: 2.1, 2.2, 2.4, 3.2, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 9.3, 9.4, 9.7_
  - _Boundary: Signer Adapter, Test Harness_
  - _Depends: 1.1, 1.2_
  - _Reopened: The Go package must retain the existing unversioned derivation-name interface so current Home Manager render assertions and the canonical git-mcp check stay green._

- [x] 2.2 (P) Build safe identity bootstrap
  - Require no active marker and an empty managed identities directory before creating one `p-256-ne` identity with protection `none`.
  - Compare identity sets, require one new hash, export under one selector into an empty temporary directory, and select by fingerprint.
  - Locally sign and verify before atomically installing the resident stub and public key.
  - Complete when bootstrap emits a complete non-secret enrollment declaration and reports any created orphan after partial failure.
  - _Requirements: 1.1, 1.2, 1.3, 6.1, 6.2, 6.3, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.7_
  - _Boundary: Lifecycle CLI_
  - _Depends: 1.1_

- [x] 2.3 Add diagnosis and local probes
  - Validate platform paths, active enrollment, selector, identity, stub, public key, fingerprint, and local sign/verify.
  - Keep doctor read-only and probe output temporary.
  - Complete when both commands identify exact mismatches and prove a matching enrollment without persistent probe data.
  - _Requirements: 4.1, 4.4, 6.1, 6.2, 6.3, 6.4, 6.5, 7.4_
  - _Boundary: Lifecycle CLI_

- [x] 2.4 Add atomic stub recovery
  - Require the active marker to match the requested hash and re-export only that identity.
  - Replace stub state atomically after an exact public-key and fingerprint match.
  - Complete when missing, ambiguous, or failed recovery preserves prior valid state and matching recovery restores the stub.
  - _Requirements: 6.4, 6.5, 6.6, 8.3, 8.5, 8.6_
  - _Boundary: Lifecycle CLI_

- [x] 2.5 Add additive rotation
  - Stage rotation under a new hash with registration attestation disabled and leave the selected identity unchanged.
  - Preserve the previous enrollment on candidate creation or verification failure.
  - Complete when rotation emits a distinct replacement declaration without changing or deleting the active identity.
  - _Requirements: 7.3, 8.1, 8.2, 8.3, 8.4, 8.6_
  - _Boundary: Lifecycle CLI_

- [x] 2.6 Add guarded decommissioning
  - Delete only an explicitly confirmed hash/fingerprint after proving the active marker is absent or selects a replacement.
  - Never invoke a delete-all operation or remove the active identity.
  - Complete when decommission removes only its exact inactive target and emits GitHub signing-key cleanup guidance.
  - _Requirements: 8.4, 8.6, 8.7_
  - _Boundary: Lifecycle CLI_

- [x] 2.7 Add acceptance evidence recording
  - Verify unlocked, locked, sleep, reboot, and GitHub-referenced commits against the active public identity.
  - Require explicit GitHub `Verified` attestation and atomically write the versioned host, OS, fingerprint, probe, and result record.
  - Reject incomplete, unsigned, mismatched, or inactive enrollment evidence.
  - Complete when accepted evidence contains no private material and can be revalidated from its commit references.
  - _Requirements: 4.5, 5.2, 5.3, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - _Boundary: Lifecycle CLI_

- [x] 2.8 Implement the deterministic Go supervisor state machine
  - Define explicit `Start`, `Working`, `CleanupTerm`, `CleanupKill`, `VerifyGroup`, `ReapDirectWorker`, `RelayOutput`, `Succeeded`, `Failed`, `TimedOut`, and `CleanupUncertain` states.
  - Capture immutable `T0 + 20 seconds` work and `T0 + 22 seconds` attempt deadlines, then fixed TERM and cleanup deadlines when cleanup begins. Every wait, read, signal retry, and `EINTR` retry shall receive an absolute deadline rather than derive a new grace period.
  - Complete when Go unit tests deterministically assert exit `0` for pre-deadline success, exit `124` for exact/late results and success whose cleanup crosses the work deadline, exit `128 + signal number` for clean parent interruption, and exit `125` for cleanup timeout, incomplete output relay, persistent zombie, failed group observation, interrupted cleanup uncertainty, and bounded repeated `EINTR`. They shall also prove a late group member is removed before a permitted result.
  - _Requirements: 2.3, 6.7, 6.9, 6.10, 9.3, 9.7_
  - _Boundary: Signer Adapter_
  - _Depends: 2.1_
  - _Reopened: User authorized a bounded follow-up to classify only exact zero-byte `ESRCH` as absence and fail closed on all short or negative process-inspection results._

- [x] 2.9 Port signer process-control helpers to Go
  - Replace `tests/git-mcp/fixtures/process-identity.c` and `tests/git-mcp/fixtures/process-ownership.js` with Go code while retaining Node only as the outer integration-test runner.
  - Build and export `tests/git-mcp/fixtures/process-control_darwin.go` through `signing-tools.nix`; make the fixture, signer, and upstream-isolation suites consume its process identity, group inspection, session observation, and owned-process cleanup contract.
  - Delete the legacy C and JavaScript helper files only after fixture, signer, and upstream-isolation consumers use the Go fixture CLI.
  - Complete when no Node or standalone C helper implements signer-process supervision or cleanup and every migrated consumer retains its process-safety assertions.
  - _Requirements: 6.7, 6.9, 9.3, 9.7_
  - _Boundary: Test Harness_
  - _Depends: 2.1, 2.8_

- [ ] 3. Verify native tool contracts
- [x] 3.2 Test Git fail-closed and bounded supervisor behavior
  - Use deterministic Go state tests as the source of truth for the 20-second work deadline, one-second TERM phase, two-second cleanup limit, late members, zombies, and `EINTR` behavior.
  - Retain temporary Git repositories with conflicting global settings to prove explicit and retry-shaped commits sign or fail without moving `HEAD`.
  - Repair failure-safe fixture finalization, but do not let fixture startup or a Node event-loop race stand in for signer ownership semantics.
  - Complete when every signer attempt has the exact work and attempt deadlines, leaves no owned worker-group member, and both Git attempts fail closed without using the upstream 60-second timeout.
  - _Requirements: 2.3, 2.4, 4.4, 6.7, 6.9, 9.3, 9.4, 9.7_
  - _Boundary: Test Harness_
  - _Depends: 2.8, 2.9_
  - _Reopened: The fixture-native finalizer must await its detached Node ChildProcess exit after Go cleanup before asserting worker-group state; a zombie remains liveness evidence._
  - _Reopened: Every fake-agent startup-failure path must invoke Go-owned cleanup and await ChildProcess close before fixture-state removal._
  - _Reopened: Raw-PID startup rejection must assert the immediate readiness/ownership reason first, then assert asynchronous child stderr only after Go cleanup and ChildProcess close._

- [x] 3.3 Test bootstrap selection and refusal
  - Cover identity-set comparison, zero/one/multiple exports, fingerprint selection, atomic installation, active-marker refusal, and non-empty-state refusal.
  - Verify bootstrap reports a created orphan after later failure and emits only the expected public declaration.
  - Complete when every bootstrap outcome leaves an observable safe state.
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.7, 9.3_
  - _Boundary: Test Harness_
  - _Depends: 1.1, 1.2, 2.2_

- [x] 3.4 Test diagnosis and recovery safety
  - Cover read-only diagnosis, temporary probes, active-marker matching, exact re-export, and recovery rollback.
  - Complete when failed recovery preserves prior state and successful recovery restores only a matching stub.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.4, 8.3, 8.5, 8.6, 9.3_
  - _Boundary: Test Harness_
  - _Depends: 2.3, 2.4, 3.3_

- [x] 3.5 Test rotation and decommission safety
  - Cover additive candidates, registration-before-selection state, failed-rotation rollback, exact deletion, active-identity refusal, and delete-all prohibition.
  - Complete when rotation never changes the active declaration and decommission removes only a confirmed inactive target.
  - _Requirements: 7.3, 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 9.3_
  - _Boundary: Test Harness_
  - _Depends: 2.5, 2.6, 3.4_

- [x] 3.6 Test acceptance evidence and generated-output policy
  - Validate registration ordering, evidence schema, active-identity matching, and rejection of incomplete, unsigned, or mismatched commits.
  - Assert generated outputs contain no private key, GitHub authentication registration, SSH client/agent/server key addition, or secret-pipeline material.
  - Complete when accepted evidence is revalidatable and every rejected input leaves prior evidence unchanged.
  - _Requirements: 1.4, 1.5, 5.1, 5.2, 5.3, 9.3, 9.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - _Boundary: Test Harness_
  - _Depends: 2.7, 3.5_

- [x] 3.7 Revalidate failed-signing upstream isolation after the Go signer replacement
  - Run the existing failing-signature fixture through the public Go signer and confirm mcpproxy plus the independent sibling upstream remain available.
  - Complete when the replacement changes no failure-isolation behavior outside the Git request.
  - _Requirements: 6.7, 6.8, 6.9, 9.3, 9.5_
  - _Boundary: Test Harness_
  - _Depends: 1.1, 1.2, 2.8, 2.9_

- [x] 3.8 Wire and run the native contract suites
  - Add the Go toolchain to the existing `git-mcp` flake-check runtime and run the Go signer tests before the separate Node suites.
  - Preserve independent Node process boundaries and prevent fixtures from invoking host CTK or Keychain paths.
  - Complete when the existing git-mcp check runs deterministic Go supervisor coverage plus every current render, lifecycle, signer, and upstream-isolation suite.
  - _Requirements: 9.3, 9.5, 9.7_
  - _Boundary: Test Harness_
  - _Depends: 2.9, 3.2, 3.6, 3.7_
  - _Accepted risk: The static source guard does not evaluate Nix interpolation output. An interpolation embedded in apparent source-comment text can synthesize shell heredoc control syntax and suppress a required Go suite. The canonical flake check remains required; the user accepted this residual static-analysis gap._

- [ ] 4. Integrate signing into Home Manager
- [x] 4.1 Revalidate enrollment options, tools, and the active marker
  - Preserve the existing typed enablement, state, metadata, registration-attestation, active-marker, and disabled-signing option surface.
  - Revalidate the fixture-injected default Go signer package through the existing `signerPackage` option without changing lifecycle or configuration ownership.
  - Complete when the admin CLI remains runnable before enrollment, the Go package is installable through `signerPackage`, disabled signing leaves the server environment unchanged, and existing partial-enablement evaluation failures remain intact.
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 7.3, 8.2, 8.3, 8.5, 9.1_
  - _Boundary: Signing Configuration_
  - _Depends: 2.8, 2.9, 2.7, 3.8_

- [x] 4.2 Merge signing environment only into git-mcp
  - Revalidate the existing four indexed Git config pairs, explicit upstream signing flag, native provider/selector, and expected public metadata against the Go signer package.
  - Preserve stateless/in-memory values, author identity, `SSH_AUTH_SOCK`, other upstream environments, and the single server registration. Add nothing to `IdentityFile`, `IdentityAgent`, `ssh-agent`, or `authorized_keys`.
  - Complete when enablement selects the Go adapter and resident stub only for `git-mcp`, and disablement preserves current rendering.
  - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 5.3, 6.1, 9.1, 9.5_
  - _Boundary: Signing Configuration_
  - _Depends: 2.8, 3.2, 4.1_

- [ ] 5. Implement the versioned operator interface
- [x] 5.1 Add enrollment and acceptance procedures
  - Cover bootstrap output, registration through GitHub's signing-key surface only, registration before selection, activation as test setup, rollback, and evidence recording.
  - Define unlocked, locked-without-approval, post-sleep, post-reboot, and GitHub `Verified` probes.
  - State the public/non-secret state model, prohibited private-material paths, and accepted same-user authorization boundary.
  - Complete when a new host can follow the procedure without Secretive, SOPS, generic-password items, authentication registration, `authorized_keys`, or an agent.
  - _Requirements: 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.4_
  - _Boundary: Runbook_
  - _Depends: 2.7, 4.2_

- [x] 5.2 Add lifecycle and diagnostic procedures
  - Cover additive rotation, registration-before-switch, lost-stub recovery, lost identity or host, and decommission ordering.
  - Map missing provider/identity/stub, mismatch, ambiguous export, first unlock, provider rejection, and timeout to safe recovery steps.
  - Preserve explicit global Git and 1Password SSH behavior throughout every procedure.
  - Complete when every lifecycle and error path in the design has one actionable procedure.
  - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 11.1, 11.2, 11.3, 11.4_
  - _Boundary: Runbook_

- [ ] 6. Enroll dedicated host identities
- [ ] 6.1 Bootstrap and register the personal-host candidate
  - Build or activate the admin package while signing remains disabled on `Brandons-MacBook-Pro`.
  - Bootstrap and locally verify the candidate; capture its label, hash, public key, and fingerprint.
  - Complete GitHub signing-key registration without changing authentication keys or the existing global signing key.
  - Complete when one verified candidate has completed registration through GitHub's signing-key surface only and is ready for declaration.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 10.1_
  - _Boundary: Physical Host Enrollment Personal_
  - _Depends: 2.2, 4.1, 5.1_

- [ ] 6.2 Bootstrap and register the Shopify-host candidate
  - Build or activate the disabled-state admin package on `ShopifyLaptop` and create a distinct candidate.
  - Complete local verification and registration through GitHub's signing-key surface only while preserving Shopify's external Git include and global authentication/signing keys.
  - Complete when registration is finished and no candidate public identifier matches the personal identity.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.3, 3.4, 3.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 10.1_
  - _Boundary: Physical Host Enrollment Shopify_
  - _Depends: 2.2, 4.1, 5.1, 6.1_

- [ ] 7. Declare and verify both host enrollments
- [ ] 7.1 (P) Add the personal enrollment declaration
  - Add only the generated public metadata, enablement, and explicit registration attestation under the personal MCP configuration.
  - Leave the personal global signing public key unchanged.
  - Complete when host evaluation derives the personal candidate's stub path and active marker.
  - _Requirements: 1.1, 1.2, 1.3, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 5.3, 7.5, 7.6, 7.7, 8.2_
  - _Boundary: Signing Configuration Personal_
  - _Depends: 4.2, 6.1_

- [ ] 7.2 (P) Add the Shopify enrollment declaration
  - Add only the distinct Shopify public metadata, enablement, and registration attestation under its MCP configuration.
  - Leave the Shopify global signing key and external Git include unchanged.
  - Complete when host evaluation derives only the Shopify candidate's stub path and active marker.
  - _Requirements: 1.1, 1.2, 1.3, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 5.3, 7.5, 7.6, 7.7, 8.2_
  - _Boundary: Signing Configuration Shopify_
  - _Depends: 4.2, 6.2_

- [ ] 7.3 Extend dual-host render and isolation coverage
  - Assert exact Git config indexing, provider, hash-keyed paths, distinct metadata, registration markers, packages, and preserved hardening on both hosts.
  - Assert global 1Password signer, current public keys, `IdentityAgent`, and unrelated upstreams remain unchanged.
  - Complete when the dual-host suite proves one scoped signer per host and no adjacent configuration drift.
  - _Requirements: 1.4, 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 9.1, 9.2, 9.4, 9.5_
  - _Boundary: Test Harness, Signing Configuration Integration_
  - _Depends: 7.1, 7.2_

- [ ] 7.4 Add persistent repository key-use policy coverage
  - Scan implementation and configuration for private keys, signing secrets, GitHub authentication registration, SSH `IdentityFile`/`IdentityAgent` additions, `ssh-agent` loading, and `authorized_keys` installation.
  - Exclude prose and negative fixtures while validating executable outputs and preserving existing global Git/SSH files.
  - Complete when repository checks enforce the configured-and-registered-for-commit-signing-only boundary without claiming platform exclusivity.
  - _Requirements: 1.4, 1.5, 3.3, 3.4, 3.5, 5.1, 5.2, 5.3, 9.6_
  - _Boundary: Test Harness_
  - _Depends: 7.3_

- [ ] 8. Complete external-platform integration validation
- [ ] 8.1 Validate personal lock and sleep behavior
  - Activate the personal declaration as test setup, restart mcpproxy, and verify unrelated upstream health.
  - Create and inspect actual `git-mcp` commits unlocked, screen-locked without approval, and after sleep.
  - Verify one dedicated key signs every commit while global interactive Git and SSH still select 1Password; rollback on any failure.
  - Complete when all three probes pass without private material or unrelated upstream interruption.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.7, 6.8, 10.1, 10.2, 10.3_
  - _Boundary: Physical Host Acceptance Personal_
  - _Depends: 5.1, 7.1, 7.3_

- [ ] 8.2 Complete personal reboot and GitHub acceptance
  - Reboot the personal host, complete the first unlock, and prove the same enrolled identity signs without rotation or re-registration.
  - Push an operator-selected probe commit, confirm GitHub marks it `Verified`, and record complete acceptance evidence.
  - Complete when the personal acceptance record passes every state and GitHub result.
  - _Requirements: 4.4, 4.5, 10.4, 10.5, 10.6_
  - _Boundary: Physical Host Acceptance Personal_
  - _Depends: 8.1_

- [ ] 8.3 Validate Shopify lock and sleep behavior
  - Activate the Shopify declaration as test setup only after personal acceptance is complete, then repeat the unlocked, locked, sleep, upstream-health, and global-compatibility probes with its distinct identity.
  - Preserve Shopify-specific Git behavior and rollback on any mandatory failure.
  - Complete when all probes use the Shopify key and every unrelated upstream remains available.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.7, 6.8, 10.1, 10.2, 10.3_
  - _Boundary: Physical Host Acceptance Shopify_
  - _Depends: 5.1, 7.2, 7.3, 8.2_

- [ ] 8.4 Complete Shopify reboot and GitHub acceptance
  - Reboot the Shopify host, complete the first unlock, and verify the same distinct identity.
  - Confirm a pushed probe is `Verified` and record the complete Shopify acceptance evidence.
  - Complete when the Shopify record passes every state and key match.
  - _Requirements: 4.4, 4.5, 10.4, 10.5, 10.6_
  - _Boundary: Physical Host Acceptance Shopify_
  - _Depends: 8.3_

- [ ] 8.5 Run final repository and boundary verification
  - Run the git-mcp flake check and both host evaluations from the final tree.
  - Inspect source and rendered output for private material, secret/authentication/`authorized_keys` use, duplicate server entries, global key changes, and signing environment leakage.
  - Verify the runbook and both acceptance records cover every lifecycle and empirical gate.
  - Complete when all automated checks pass, both hosts have accepted evidence, and only design-listed source files changed.
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.8, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.3, 11.4_
  - _Boundary: Cross-component Validation_
  - _Depends: 3.8, 7.4, 8.2, 8.4_

## Implementation Notes

- Task 2.1 revision: The signer runtime, worker, supervisor, and signer-specific process-control helpers are Go. Node remains the outer integration-test runner and fake native tool harness only.
- Task 2.8: Work, TERM, cleanup, and total-attempt limits are immutable monotonic deadlines. Every `EINTR` retry checks its passed deadline and pending signal before retrying.
- Task 2.8: The signer reaps only its direct worker. It keeps that PID unreaped while signaling and observing its process group, then treats any remaining `pbi_pgid` member, including `SZOMB`, as cleanup uncertainty.
- Task 3.2: Deterministic Go tests prove deadline transitions. Git integration tests retain a 22-second observed ceiling but do not use elapsed time as the sole proof of deadline logic.
- Task 3.2: Fixture finalizers must reap fixture-owned processes after any assertion failure; fixture startup failures must not bypass cleanup verification.
- Task 3.3: Lifecycle refusal tests snapshot the complete managed-state tree, including entry type, mode, bytes, and symlink target; CTK fixtures preserve each identity's declared key type so incompatible identities cannot masquerade as `p-256-ne`.
- Task 3.4: Atomic recovery needs distinct fixtures for install-only rename failure versus install-and-rollback failure; selector, exported key, complete state tree, and retained backup are verified independently.
- Task 3.5: Mutable CTK fixtures must filter exact deletions within raw SHA1/SSH listings rather than regenerate structured tables, or unrelated native identities disappear and target-only deletion tests become false positives.
- Task 3.6: Generated-output policy is fail-closed: only anchored whole-clause prohibition templates exempt otherwise prohibited actions; broad natural-language negation lets unrelated guidance mask active key/secret commands.
- Task 4.1: Force every enabled signing option outside the parent MCP gate; parse SSH-SK metadata with bounded, constant-stack pure Nix decoding that rejects NULs and noncanonical Base64 while accepting valid large application fields.
- Task 3.8 accepted risk: Raw flake-source checks do not account for Nix interpolation output, so comment stripping can hide runtime heredoc syntax. The canonical flake check remains required evidence.
- Task 3.2 reopened: Go cleanup must be followed by `waitForChildExit(child, 2_000)` before the final worker-group state query; `SZOMB` remains cleanup uncertainty until reaped.
- Task 1.1 reopened: Hang-fixture parent and descendant startup must be gated by a Go-published worker-group readiness marker before either enters its hang state.
- Task 1.1 reopened: Fake-agent startup needs a Go-owned lifecycle barrier before socket readiness; Task 3.2 must clean and await the child on every startup failure.
