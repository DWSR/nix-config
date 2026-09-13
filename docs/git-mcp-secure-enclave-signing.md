# Git MCP Secure Enclave Signing Lifecycle Runbook

This runbook covers lifecycle and diagnostic recovery for an existing
enrollment. Initial enrollment and physical-host acceptance are Task 5.1 work
and are intentionally forthcoming. Do not treat this document as an
activation or initial-acceptance procedure. Configuration-test wiring also
remains blocked by Task 3.8, so do not claim that signing configuration is
ready from these instructions alone.

## Scope and safety boundary

The active enrollment marker is Home Manager-generated public metadata at:

```text
$XDG_CONFIG_HOME/git-mcp-secure-enclave-signing/active.json
```

The matching host-local state is:

```text
$XDG_STATE_HOME/git-mcp-secure-enclave-signing/
├── identities/<ctk-hash>/id_ecdsa_sk_rk
├── identities/<ctk-hash>/id_ecdsa_sk_rk.pub
└── acceptance/<ctk-hash>.json
```

The resident stub is a non-secret provider handle, not private key material.
The marker, public key, fingerprint, hash, stub, and acceptance JSON are
non-secret state. Do not export, copy, persist, or request private material.

This feature changes only Git commands descended from `git-mcp`. Global
interactive Git signing remains on its existing 1Password signer, and existing
1Password SSH authentication remains unchanged. This runbook makes no SSH
authentication or agent configuration changes.

The Go public signer and its private worker manage their own bounded process
handling internally. A same-user process can invoke the native provider with a
readable resident stub. The feature does not provide process-level
authorization or exclusive access, and no procedure here should claim that it
does.

## Command reference

For `doctor`, `probe`, and `recover-stub`, use `ctkPublicKeyHash` from the
active marker. For decommission, use the inactive target's recorded public
hash and fingerprint. These are the supported lifecycle diagnostic forms:

```sh
git-mcp-secure-enclave-admin doctor --hash <hash>
git-mcp-secure-enclave-admin probe --hash <hash>
git-mcp-secure-enclave-admin recover-stub --hash <hash>
git-mcp-secure-enclave-admin rotate --label <label>
git-mcp-secure-enclave-admin decommission --hash <hash> --fingerprint <fingerprint>
```

`doctor` validates the active marker, platform paths, CTK identity, resident
stub, public key, fingerprint, and a disposable local sign/verify operation.
`probe` performs the same disposable local signing check. Neither command
changes the selected declaration. The CLI never edits repository configuration
or calls GitHub APIs.

Every procedure below preserves global interactive Git signing and 1Password
SSH authentication; no lifecycle step changes either behavior.

## Additive rotation

1. Read the current hash from `active.json` and run:

   ```sh
   git-mcp-secure-enclave-admin doctor --hash <active-hash>
   ```

   Stop if it is not healthy. Rotation must not start from unverified active
   state.

2. Choose a distinct label and create a candidate:

   ```sh
   git-mcp-secure-enclave-admin rotate --label <new-label>
   ```

   The command creates and locally verifies a separate candidate, prints its
   public metadata, and leaves the active marker and active identity unchanged.
   Its emitted `githubSigningKeyRegistered` value is `false`, so it is not
   selected by this command.

3. Register the candidate public key through GitHub's signing-key surface only.
   Do this before changing the host declaration. Keep the previous enrollment
   selected and usable if registration or local validation fails.

4. After registration is confirmed, follow the forthcoming Task 5.1
   declaration and acceptance procedure to select the candidate. Do not claim
   configuration readiness while Task 3.8 is blocked. Once the active marker
   selects the candidate, run `doctor --hash <candidate-hash>` and
   `probe --hash <candidate-hash>` before considering old-key cleanup.

5. Keep the old identity, its local state, and its GitHub signing key until the
   replacement is registered, selected, and has completed the forthcoming
   acceptance procedure. Then use the inactive-only decommission procedure.

## Lost resident stub

Use this only when the active marker still selects the identity and the CTK
identity remains present. Do not create or copy a stub by hand.

```sh
git-mcp-secure-enclave-admin recover-stub --hash <hash>
```

Recovery exports into disposable state, accepts exactly one fingerprint-matched
stub/public-key pair, locally signs and verifies it, then installs the pair
atomically. If it reports zero or multiple matching exports, a mismatch, or a
filesystem failure before installation starts, it leaves the unchanged state in
place. That state is not necessarily a valid signing state: it can still have a
missing, malformed, or rejected stub. Do not choose an artifact by filename or
export order. Resolve an export or identity diagnosis before retrying recovery.

### Failed install-and-rollback

If `recover-stub` reports that pre-recovery resident state was retained at a
reported `.recover-backup.*` path, the verified replacement installation and
its rollback both failed. The canonical active identity path is absent. The
backup is unchanged or restored state, not known-valid state: it can retain a
missing, malformed, or otherwise invalid stub.

1. Preserve the reported backup. Do not delete it, choose an export, or rerun
   recovery while the canonical path is absent.
2. Repair the filesystem condition that caused the failed rename. If a new
   canonical path appeared, stop rather than overwrite it.
3. Restore exactly the reported backup to the reported normal identity path.
   Move the complete backup directory without copying or merging artifacts
   from another identity.
4. To diagnose the restored artifact, run:

   ```sh
   git-mcp-secure-enclave-admin doctor --hash <hash>
   git-mcp-secure-enclave-admin probe --hash <hash>
   ```

   Doctor and probe are diagnostic tools, not a gate. `recover-stub` may be
   retried even when the restored stub remains missing, malformed, or otherwise
   invalid. It independently validates the CTK identity and replaces an allowed
   restored artifact only with a fingerprint-matched, locally verified export.

After successful recovery, run:

```sh
git-mcp-secure-enclave-admin doctor --hash <hash>
git-mcp-secure-enclave-admin probe --hash <hash>
```

## Lost identity or replacement host

First rule out the post-reboot precondition: complete the logged-in user's
first unlock, then run `doctor --hash <hash>` again. If the CTK identity is
still absent, a resident-stub recovery cannot recreate its non-exportable
identity.

Treat a lost identity or replacement host as a new per-host enrollment. Do not
copy an identity, stub, or public metadata from another host. The forthcoming
Task 5.1 enrollment procedure begins with:

```sh
git-mcp-secure-enclave-admin bootstrap --label <new-label>
```

That deferred procedure owns all initial enrollment, registration, and
acceptance steps; they are not included in this runbook. The command refuses an
active marker or non-empty managed identities directory, so do not run it to
overwrite lost state. If the old host is unavailable, do not claim its platform
identity was removed; remove its GitHub signing key only after the replacement
has completed that procedure. If the old host returns, decommission its old
identity only after it is inactive.

## Inactive-only decommission

1. Confirm that `active.json` is absent or selects a replacement hash. The CLI
   refuses a target selected by the active marker. Do not remove an active
   identity to make a rotation proceed.

2. Use the old public hash and fingerprint together:

   ```sh
   git-mcp-secure-enclave-admin decommission --hash <old-hash> --fingerprint <old-fingerprint>
   ```

   The command requires one exact `p-256-ne`/`none` identity and matching SSH
   fingerprint, deletes only that CTK identity, and removes only its
   `identities/<old-hash>/` and `acceptance/<old-hash>.json` state. It never
   performs a delete-all operation.

3. After successful local decommission, remove the corresponding public key
   from GitHub's signing-key settings only. If decommission refuses the target,
   reports an ambiguous identity, or cannot delete the CTK identity, preserve
   the local state and resolve that condition before retrying.

If decommission returns nonzero after reporting that `CTK identity <hash> was
deleted`, the platform identity is already gone. Do not rerun decommission or
retry native deletion.

### Identity-directory removal failure

If the diagnostic names `identities/<hash>`, the CLI exits before attempting
acceptance-record removal. Repair the filesystem condition, then remove only
the target's exact `identities/<hash>` and `acceptance/<hash>.json` artifacts
that remain. Do not remove or recreate any other hash's artifacts.

### Acceptance-record removal failure

If the diagnostic names `acceptance/<hash>.json`, the target identity directory
was already removed before the CLI failed. Repair the filesystem condition, then
remove only the target's exact `acceptance/<hash>.json` artifact if it remains.
Do not recreate the identity directory or retry native deletion.

After either partial failure, verify that both `identities/<hash>` and
`acceptance/<hash>.json` are absent before GitHub signing-key cleanup. Preserve
every `identities/<other-hash>` and `acceptance/<other-hash>.json` path. Only
then remove the corresponding public key from GitHub's signing-key settings.

## Diagnostics and safe recovery

| Condition | Safe response |
| --- | --- |
| Provider missing or unreadable | The signer names `/usr/lib/ssh-keychain.dylib`. Do not fall back to global signing. Restore the supported Apple provider or macOS signing tools, then run `doctor --hash <hash>`. |
| First unlock after reboot | Complete the logged-in user's first unlock, then run `doctor --hash <hash>` followed by `probe --hash <hash>`. A screen lock after that is not a request to change authentication configuration. |
| Configured identity missing or not exactly one resident identity | First apply the first-unlock check. If the identity remains absent or ambiguous, stop signing and use the lost-identity or replacement-host path. `recover-stub` cannot recreate a missing CTK identity. |
| Stub or `.pub` file missing, unreadable, malformed, or rejected | Run `recover-stub --hash <hash>`. Do not substitute a file from another host or edit the active marker to fit a file. Validate with `doctor` and `probe` after recovery. |
| Stub, public key, fingerprint, marker, or CTK identity mismatch | Stop before signing. Preserve the active state and run `doctor --hash <hash>`. If the selected CTK identity is still valid, use `recover-stub --hash <hash>`; otherwise retain the current declaration until a separately registered replacement can be selected. |
| Zero or multiple fingerprint-matched exports | Install nothing and keep prior state. Inspect only the host-local identity listings with `/usr/sbin/sc_auth list-ctk-identities -t sha1 -e hex` and `/usr/sbin/sc_auth list-ctk-identities -t ssh`; do not select an export arbitrarily. Resolve the export or identity condition, then retry `recover-stub --hash <hash>`. |
| Apple provider rejects signing | Preserve the provider stderr. Complete first unlock if this followed a reboot; otherwise leave the current Git command failed, run `doctor` and `probe`, and repair the reported platform condition. Do not use an unsigned retry or a global-signer fallback. |
| Exit `124` | The immutable 20-second work deadline expired, but bounded cleanup completed. Treat the Git command as failed and do not assume a commit was made. Diagnose with `doctor` and `probe` before one deliberate retry. |
| Exit `125` | Cleanup could not be established by its immutable deadline. Stop automatic retries and do not claim the worker group or descendants were reaped. Preserve the exit diagnostic and public marker identifiers for maintenance; do not signal guessed processes manually. |
| Exit `128 + signal` | The parent was interrupted and the signer performed bounded cleanup before returning. Treat the Git command as failed, do not infer success from partial output, and run `doctor` and `probe` before retrying. |

## Runbook coverage audit

Before applying a lifecycle command, read this document against this checklist:

| Audit item | Required location |
| --- | --- |
| Exact `doctor`, `probe`, `recover-stub`, `rotate`, and `decommission` forms | Command reference |
| Additive candidate, GitHub signing-key registration before declaration switch, and old-key retention | Additive rotation |
| Fingerprint-matched atomic stub restoration and ambiguous-export refusal | Lost resident stub and Diagnostics |
| Retained recovery backup, diagnostic-only doctor/probe, and retry for an invalid restored stub | Failed install-and-rollback |
| New per-host identity for a lost identity or host, without copying material | Lost identity or replacement host |
| Replacement-or-absent marker before exact inactive decommission | Inactive-only decommission |
| Identity-directory or acceptance-record cleanup failure, both target paths absent before GitHub cleanup, and no second native deletion | Identity-directory removal failure and Acceptance-record removal failure |
| Provider, identity, stub/key/fingerprint mismatch, export ambiguity, first unlock, provider rejection, `124`, `125`, and `128 + signal` | Diagnostics and safe recovery |
| Global Git and 1Password SSH preservation, no private material, and no process-authorization claim | Scope and safety boundary |

If any item is absent or contradicts current CLI output, stop and reconcile the
runbook with the implementation before performing the affected operation.
