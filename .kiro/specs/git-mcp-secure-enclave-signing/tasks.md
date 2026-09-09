# Implementation Plan

- [ ] 1. Build the deterministic test foundation
- [x] 1.1 Create injectable native-signing fixtures
  - Model identity snapshots, zero/one/multiple resident exports, hangs in CTK listing and every preflight/provider phase, and worker-tree termination without touching host CTK state.
  - Expose signer and admin package builds whose native tool paths are replaced only at Nix build time.
  - Complete when every platform scenario runs in an isolated temporary directory with inspectable calls and results.
  - _Requirements: 6.3, 6.6, 6.7, 9.3_
  - _Boundary: Test Harness_

- [x] 1.2 Extend the existing git-mcp check runtime
  - Add Git, OpenSSH, mcpproxy, and process-control utilities to the existing check without creating another check.
  - Preserve the current dual-host render entry point.
  - Complete when the unchanged current git-mcp suite passes with the expanded runtime.
  - _Requirements: 9.7_
  - _Boundary: Test Harness_

- [ ] 2. Implement the native signing tools
- [x] 2.1 (P) Build the Git-compatible signer adapter
  - Start one bounded worker process group before validating the provider, selector, stub, CTK identity, public key, or fingerprint for signing operations.
  - Preserve non-signing SSH program operations, native output, and argument order.
  - Enclose all signing preflight native calls and Apple `ssh-keygen` in one 20-second deadline; terminate and reap the whole worker tree on timeout.
  - Complete when the packaged command satisfies the signer process contract, never invokes an agent or fallback signer, and no signing attempt can consume the upstream 60-second limit.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7_
  - _Boundary: Signer Adapter_
  - _Depends: 1.1_

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

- [ ] 3. Verify native tool contracts
- [x] 3.1 Test signer validation and passthrough
  - Cover signing success, non-sign passthrough, every preflight mismatch, missing state/provider/identity, provider rejection, first-unlock guidance, and no-agent execution.
  - Verify original arguments and native output remain intact for supported non-signing operations.
  - Complete when immediate signer paths pass without Secure Enclave access or 1Password fallback.
  - _Requirements: 2.1, 2.2, 2.4, 3.2, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 6.5, 9.3, 9.4_
  - _Boundary: Test Harness_
  - _Depends: 1.1, 1.2, 2.1_

- [x] 3.2 Test Git fail-closed and complete-worker timeout behavior
  - Use temporary repositories with conflicting global settings to prove both upstream attempts sign or fail without moving `HEAD`.
  - Hang CTK listing, each preflight native call, and provider signing across both attempts; verify each complete worker stays within 20 seconds and leaves no descendant.
  - Complete when timeout and rejection paths return nonzero diagnostics without an unsigned commit or upstream 60-second wait.
  - _Requirements: 2.3, 2.4, 4.4, 6.7, 9.3, 9.4_
  - _Boundary: Test Harness_
  - _Depends: 3.1_

- [ ] 3.3 Test bootstrap selection and refusal
  - Cover identity-set comparison, zero/one/multiple exports, fingerprint selection, atomic installation, active-marker refusal, and non-empty-state refusal.
  - Verify bootstrap reports a created orphan after later failure and emits only the expected public declaration.
  - Complete when every bootstrap outcome leaves an observable safe state.
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.7, 9.3_
  - _Boundary: Test Harness_
  - _Depends: 1.1, 1.2, 2.2_

- [ ] 3.4 Test diagnosis and recovery safety
  - Cover read-only diagnosis, temporary probes, active-marker matching, exact re-export, and recovery rollback.
  - Complete when failed recovery preserves prior state and successful recovery restores only a matching stub.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.4, 8.3, 8.5, 8.6, 9.3_
  - _Boundary: Test Harness_
  - _Depends: 2.3, 2.4, 3.3_

- [ ] 3.5 Test rotation and decommission safety
  - Cover additive candidates, registration-before-selection state, failed-rotation rollback, exact deletion, active-identity refusal, and delete-all prohibition.
  - Complete when rotation never changes the active declaration and decommission removes only a confirmed inactive target.
  - _Requirements: 7.3, 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 9.3_
  - _Boundary: Test Harness_
  - _Depends: 2.5, 2.6, 3.4_

- [ ] 3.6 Test acceptance evidence and generated-output policy
  - Validate registration ordering, evidence schema, active-identity matching, and rejection of incomplete, unsigned, or mismatched commits.
  - Assert generated outputs contain no private key, GitHub authentication registration, SSH client/agent/server key addition, or secret-pipeline material.
  - Complete when accepted evidence is revalidatable and every rejected input leaves prior evidence unchanged.
  - _Requirements: 1.4, 1.5, 5.1, 5.2, 5.3, 9.3, 9.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - _Boundary: Test Harness_
  - _Depends: 2.7, 3.5_

- [ ] 3.7 Test failed-signing upstream isolation
  - Start a local mcpproxy fixture with a failing signing-backed Git upstream and an independent sibling upstream.
  - Trigger signing failure, then prove mcpproxy remains healthy and the sibling still answers.
  - Complete when the regression test observes a Git error without daemon or sibling interruption.
  - _Requirements: 6.7, 6.8, 9.3, 9.5_
  - _Boundary: Test Harness_
  - _Depends: 1.1, 1.2, 2.1_

- [ ] 3.8 Wire and run the native contract suites
  - Register signer, lifecycle, and upstream-isolation suites through the existing git-mcp test entry point.
  - Prevent fixtures from invoking host CTK or Keychain paths.
  - Complete when the existing git-mcp check runs the current render test and all native contract suites successfully.
  - _Requirements: 9.3, 9.5, 9.7_
  - _Boundary: Test Harness_
  - _Depends: 3.2, 3.6, 3.7_

- [ ] 4. Integrate signing into Home Manager
- [ ] 4.1 Define enrollment options, tools, and the active marker
  - Add typed enable, state, identity, public metadata, registration-attestation, and package options with a disabled signing default.
  - Install signer and admin tools whenever MCP is enabled, derive the hash-keyed stub path, and render the active marker only for a complete enabled declaration.
  - Reject malformed metadata and enabled declarations without completed GitHub registration.
  - Complete when the admin CLI is runnable before enrollment, disabled signing leaves the server environment unchanged, and partial enablement fails evaluation.
  - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 7.3, 8.2, 8.3, 8.5, 9.1_
  - _Boundary: Signing Configuration_
  - _Depends: 2.1, 2.7_

- [ ] 4.2 Merge signing environment only into git-mcp
  - Add the four indexed Git config pairs, explicit upstream signing flag, native provider/selector, and expected public metadata to the existing server environment.
  - Preserve stateless/in-memory values, author identity, `SSH_AUTH_SOCK`, other upstream environments, and the single server registration; add nothing to `IdentityFile`, `IdentityAgent`, `ssh-agent`, or `authorized_keys`.
  - Complete when enablement selects the adapter and resident stub only for `git-mcp`, and disablement restores current rendering.
  - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 5.3, 6.1, 9.1, 9.5_
  - _Boundary: Signing Configuration_

- [ ] 5. Implement the versioned operator interface
- [ ] 5.1 Add enrollment and acceptance procedures
  - Cover bootstrap output, registration through GitHub's signing-key surface only, registration before selection, activation as test setup, rollback, and evidence recording.
  - Define unlocked, locked-without-approval, post-sleep, post-reboot, and GitHub `Verified` probes.
  - State the public/non-secret state model, prohibited private-material paths, and accepted same-user authorization boundary.
  - Complete when a new host can follow the procedure without Secretive, SOPS, generic-password items, authentication registration, `authorized_keys`, or an agent.
  - _Requirements: 1.3, 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.4_
  - _Boundary: Runbook_
  - _Depends: 2.7, 4.2_

- [ ] 5.2 Add lifecycle and diagnostic procedures
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

- [ ] 8.2 (P) Validate Shopify lock and sleep behavior
  - Activate the Shopify declaration as test setup and repeat the unlocked, locked, sleep, upstream-health, and global-compatibility probes with its distinct identity.
  - Preserve Shopify-specific Git behavior and rollback on any mandatory failure.
  - Complete when all probes use the Shopify key and every unrelated upstream remains available.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.7, 6.8, 10.1, 10.2, 10.3_
  - _Boundary: Physical Host Acceptance Shopify_
  - _Depends: 5.1, 7.2, 7.3_

- [ ] 8.3 (P) Complete personal reboot and GitHub acceptance
  - Reboot the personal host, complete the first unlock, and prove the same enrolled identity signs without rotation or re-registration.
  - Push an operator-selected probe commit, confirm GitHub marks it `Verified`, and record complete acceptance evidence.
  - Complete when the personal acceptance record passes every state and GitHub result.
  - _Requirements: 4.4, 4.5, 10.4, 10.5, 10.6_
  - _Boundary: Physical Host Acceptance Personal_
  - _Depends: 8.1_

- [ ] 8.4 (P) Complete Shopify reboot and GitHub acceptance
  - Reboot the Shopify host, complete the first unlock, and verify the same distinct identity.
  - Confirm a pushed probe is `Verified` and record the complete Shopify acceptance evidence.
  - Complete when the Shopify record passes every state and key match.
  - _Requirements: 4.4, 4.5, 10.4, 10.5, 10.6_
  - _Boundary: Physical Host Acceptance Shopify_
  - _Depends: 8.2_

- [ ] 8.5 Run final repository and boundary verification
  - Run the git-mcp flake check and both host evaluations from the final tree.
  - Inspect source and rendered output for private material, secret/authentication/`authorized_keys` use, duplicate server entries, global key changes, and signing environment leakage.
  - Verify the runbook and both acceptance records cover every lifecycle and empirical gate.
  - Complete when all automated checks pass, both hosts have accepted evidence, and only design-listed source files changed.
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.8, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.1, 11.2, 11.3, 11.4_
  - _Boundary: Cross-component Validation_
  - _Depends: 3.8, 7.4, 8.3, 8.4_

## Implementation Notes

- Task 3.2: Enforce timeout contracts with both an exact packaged `--kill-after=1s 20s` assertion and a 22-second wall-clock ceiling; timing tolerance alone cannot prove the configured deadline.
