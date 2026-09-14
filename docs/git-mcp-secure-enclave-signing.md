# Git MCP Secure Enclave Signing Runbook

This runbook covers per-host enrollment, activation as a test setup, physical
acceptance, lifecycle changes, and diagnostic recovery. Run it separately on
each physical host. A host is not accepted until its unlocked, locked-screen,
post-sleep, post-reboot, and GitHub `Verified` probes all pass.

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
The marker, public key, fingerprint, CTK hash selector, stub, and acceptance
JSON are non-secret host-local state. `active.json` is a Home Manager-generated
projection of the host declaration, not independently managed lifecycle state.
The acceptance record contains only public identifiers, commit references,
verification results, host and macOS metadata, and timestamps.

The Secure Enclave private key must never enter a Nix expression or store,
SOPS data, a generic-password Keychain item, mcpproxy configuration or
environment, logs, or a disk file. Do not export it, copy it between hosts, or
put it in Secretive. Do not add it to SSH authentication configuration,
`authorized_keys`, or a persistent `ssh-agent`. The resident stub and its
`.pub` file are the deliberate exception: they contain a provider handle and
public key, not private key material.

This feature changes only Git commands descended from `git-mcp`. Global
interactive Git signing remains on its existing 1Password signer, and existing
1Password SSH authentication remains unchanged. This runbook makes no SSH
authentication, `IdentityFile`, `IdentityAgent`, `authorized_keys`, or agent
configuration changes. No Secretive, SOPS, generic-password signing item,
authentication-key registration, or signing agent is needed.

The Go public signer and its private worker manage their own bounded process
handling internally. A same-user process can invoke the native provider with a
readable resident stub. The feature does not provide process-level
authorization or exclusive access, and no procedure here should claim that it
does. Hardware-backed non-exportability protects the private key from export;
it does not prevent another process running as the logged-in user from
requesting a signature.

## Command reference

For `doctor`, `probe`, and `recover-stub`, use `ctkPublicKeyHash` from the
active marker. For decommission, use the inactive target's recorded public
hash and fingerprint. Bootstrap is run before an active marker exists. These
are the supported lifecycle forms:

```sh
git-mcp-secure-enclave-admin bootstrap --label <label>
git-mcp-secure-enclave-admin doctor --hash <hash>
git-mcp-secure-enclave-admin probe --hash <hash>
git-mcp-secure-enclave-admin recover-stub --hash <hash>
git-mcp-secure-enclave-admin rotate --label <label>
git-mcp-secure-enclave-admin record-acceptance --hash <hash> --unlocked-commit <sha> --locked-commit <sha> --sleep-commit <sha> --reboot-commit <sha> --github-commit <sha> --github-verified
git-mcp-secure-enclave-admin decommission --hash <hash> --fingerprint <fingerprint>
```

`doctor` validates the active marker, platform paths, CTK identity, resident
stub, public key, fingerprint, and a disposable local sign/verify operation.
`probe` performs the same disposable local signing check. Neither command
changes the selected declaration. The CLI never edits repository configuration
or calls GitHub APIs. `bootstrap`, `rotate`, and `record-acceptance` likewise
require the operator to handle GitHub registration and repository selection
outside the CLI.

Every procedure below preserves global interactive Git signing and 1Password
SSH authentication; no lifecycle step changes either behavior.

## Initial enrollment

### Preconditions and host identity

1. Run this procedure on the physical host being enrolled, from the checked-out
   configuration repository. Use a label unique to that host, such as
   `git-mcp-<host>`.
2. Create the identity on this host. Never copy another host's CTK hash,
   resident stub, public key, or fingerprint.
3. Complete the logged-in user's first unlock after boot before bootstrap or
   local verification. The provider may be unavailable before that unlock.
4. Keep signing disabled while installing the admin package. The package is
   installed whenever `home.mcp.enable` is enabled, so the host declaration
   must not contain a partial active signing configuration:

   ```nix
   home.mcp.gitMcpSigning.enable = false;
   ```

   Activate that disabled state with the host's normal rebuild command:

   ```sh
   sudo darwin-rebuild switch --flake .#<host>
   ```

   Confirm that `git-mcp-secure-enclave-admin` is on `PATH`. Do not create an
   active marker or manually create an identity artifact. Bootstrap requires no
   active marker and an empty managed `identities` directory; an existing marker
   or any managed identity entry means use diagnosis, recovery, rotation, or
   explicit decommission instead of overwriting state.

### Bootstrap and local verification

Run the exact command below with the new host-specific label:

```sh
git-mcp-secure-enclave-admin bootstrap --label <label>
```

Bootstrap creates one CTK identity with `p-256-ne` and `-t none`, compares the
identity sets before and after creation, exports the resident key into an empty
temporary directory, selects exactly one export by SSH fingerprint, and locally
signs and verifies a disposable test. It atomically installs:

```text
$XDG_STATE_HOME/git-mcp-secure-enclave-signing/identities/<hash>/
├── id_ecdsa_sk_rk
└── id_ecdsa_sk_rk.pub
```

The first file is a provider handle; it is not an exported private key. On
success, stdout is only this public enrollment declaration shape:

```json
{
  "identityLabel": "<label>",
  "ctkPublicKeyHash": "<40 lowercase hex characters>",
  "sshPublicKey": "sk-ecdsa-sha2-nistp256@openssh.com <public-data>",
  "sshFingerprint": "SHA256:<base64>",
  "githubSigningKeyRegistered": false
}
```

Record the label, hash, complete public key, and fingerprint. Bootstrap does
not create `active.json`, select the identity for Git, register anything with
GitHub, or edit repository configuration. The `false` registration value is
intentional: registration must happen before selection.

Bootstrap refuses an existing active marker, non-empty managed identity state,
duplicate label, unsafe CTK identity-set change, wrong key type or protection,
ambiguous export, or failed local sign/verify. If creation succeeds but a later
step fails, stderr reports the created orphan hash, or reports that the orphan
could not be confirmed. Preserve that diagnostic, inspect public CTK listings,
and do not rerun bootstrap, select an export by filename/order, or use a
delete-all operation:

```sh
/usr/sbin/sc_auth list-ctk-identities -t sha1 -e hex
/usr/sbin/sc_auth list-ctk-identities -t ssh
```

Resolve the exact orphan through the inactive identity cleanup path before
retrying. With no active marker, obtain the orphan's exact SSH fingerprint from
the public listing and use the inactive-only decommission procedure. A partial
bootstrap normally leaves no acceptance directory; if so, create only that
empty non-secret directory before decommissioning:

```sh
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/git-mcp-secure-enclave-signing"
mkdir -p "$state_dir/acceptance"
chmod 700 "$state_dir/acceptance"
git-mcp-secure-enclave-admin decommission --hash <orphan-hash> --fingerprint <orphan-fingerprint>
```

Do not create an identity artifact, choose an export by filename/order, or use
a delete-all operation. If the local state is not in the form required by that
path, stop and repair only the named state rather than deleting another
identity. No local enrollment was installed when bootstrap reports an orphan.

### Register before selecting

1. In the GitHub account's **Settings > SSH and GPG keys**, choose **New SSH
   key**, set the key type to **Signing Key**, and paste the exact
   `sshPublicKey` emitted by bootstrap. Use the host label as the title.
2. Confirm that the registered key is the same public key and fingerprint. Use
   GitHub's signing-key surface only, and complete this step before changing
   the host declaration.
3. Do not register the key as an authentication key. Do not add it to
   `authorized_keys`, SSH `IdentityFile` or `IdentityAgent`, Secretive, SOPS,
   a generic-password Keychain item, or an `ssh-agent`.

GitHub registration is an operator action; the lifecycle CLI does not call the
GitHub API. Do not declare or activate an identity while its registration is
unconfirmed.

### Declare and activate as test setup

After GitHub confirms the exact signing key, add only the public enrollment
metadata to the target host's `home.mcp` declaration. Set the registration
attestation to `true` only for the key just registered:

```nix
home.mcp.gitMcpSigning = {
  enable = true;
  identityLabel = "<identityLabel>";
  ctkPublicKeyHash = "<ctkPublicKeyHash>";
  sshPublicKey = "<sshPublicKey>";
  sshFingerprint = "<sshFingerprint>";
  githubSigningKeyRegistered = true;
};
```

Leave the default `stateDir` and derived `stubPath` in place. Do not add
private material, a custom agent, authentication settings, or signing data to
the mcpproxy secret configuration. Enable one host at a time, then activate
and restart mcpproxy as test setup, not as a separate deployment workstream:

```sh
sudo darwin-rebuild switch --flake .#<host>
restart-mcpproxy
# Equivalent explicit launchd command:
launchctl kickstart -k "gui/$(id -u)/com.smart-mcp-proxy.mcpproxy"
```

Verify that Home Manager generated the marker and that its hash selects the
hash-keyed local state:

```sh
hash="<ctkPublicKeyHash>"
active_marker="${XDG_CONFIG_HOME:-$HOME/.config}/git-mcp-secure-enclave-signing/active.json"
jq -e --arg hash "$hash" '
  .ctkPublicKeyHash == $hash
  and .githubSigningKeyRegistered == true
  and (.stateDir | type == "string")
  and (.identityLabel | type == "string")
  and (.sshPublicKey | type == "string")
  and (.sshFingerprint | type == "string")
' "$active_marker"
state_dir="$(jq -r .stateDir "$active_marker")"
test -f "$state_dir/identities/$hash/id_ecdsa_sk_rk"
test -f "$state_dir/identities/$hash/id_ecdsa_sk_rk.pub"
git-mcp-secure-enclave-admin doctor --hash "$hash"
```

The active marker is the only activation signal. `doctor` must report matching
CTK, provider, stub, public key, fingerprint, and local sign/verify state before
physical acceptance begins.

## Physical acceptance

The deterministic fixtures and repository checks cannot prove macOS lock,
sleep, first-unlock, or GitHub behavior. Run these probes on the physical host
with the active declaration. Use a disposable branch or operator-selected
acceptance repository, and send every commit request through the existing
`git-mcp` upstream rather than local interactive Git. Make a new content change
for every row and capture the complete 40-character commit SHA.

Before the first probe, record the existing host author identity:

```sh
git config user.name
git config user.email
```

For every probe commit, verify all of the following before moving to the next
state:

```sh
allowed_signers="$(mktemp)"
printf '%s namespaces="git" %s\n' "<identityLabel>" "<sshPublicKey>" > "$allowed_signers"
git -c gpg.format=ssh \
  -c gpg.ssh.program=/usr/bin/ssh-keygen \
  -c gpg.ssh.allowedSignersFile="$allowed_signers" \
  verify-commit --raw <commit-sha>
git show -s --format='%an <%ae>' <commit-sha>
curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null
rm -f "$allowed_signers"
```

The verification must report a good `git` SSH signature from the enrolled
public key, the author output must match the baseline, and mcpproxy health must
remain successful. Also run one known non-`git-mcp` upstream operation through
the existing client after each probe and confirm that it remains available.

Run five distinct probes and retain their five distinct SHAs:

| State | Procedure and required result |
| --- | --- |
| Unlocked | After first unlock with the screen unlocked, send commit 1 through `git-mcp`. It signs with the enrolled key without a signing prompt. |
| Locked without approval | Lock the screen, send commit 2 through the already running `git-mcp` path, and do not approve biometric or other user presence. A successful signed commit is required while the screen remains locked. |
| Post-sleep | Put the host to sleep after first unlock, wake it, and send commit 3 through `git-mcp`. Verify the same enrolled key and no signing prompt. |
| Post-reboot | Reboot the host. An attempt before the first user unlock must fail closed with a first-unlock diagnostic and is not an acceptance commit. Complete the first unlock, do not rotate or re-register, then send commit 4 and verify the same hash, key, and fingerprint. |
| GitHub `Verified` | Send a fifth distinct signed commit through `git-mcp` to an operator-selected repository, verify it locally, push it, and confirm that GitHub visibly marks that commit `Verified` under the registered signing key. |

`p-256-ne -t none` is deliberate: after the first user unlock following boot,
signing is expected to work without a biometric prompt or other user-presence
approval, including while locked and after sleep. The first-unlock precondition
still applies after every reboot. These lock and sleep results are empirical
acceptance gates, not claims established by deterministic fixtures or by an
Apple-documented guarantee.

If the locked-screen or GitHub probe fails, rollout is incomplete. Disable the
host option and follow rollback; do not record acceptance as passed.

## Acceptance evidence

Run `record-acceptance` inside the Git repository containing all five probe
commits. The command rechecks the active marker and verifies each exact commit
against the active public key. It rejects missing, unsigned, mismatched,
ambiguous, or duplicate references and requires the explicit GitHub attestation:

```sh
git-mcp-secure-enclave-admin record-acceptance --hash <hash> --unlocked-commit <sha> --locked-commit <sha> --sleep-commit <sha> --reboot-commit <sha> --github-commit <sha> --github-verified
```

The five arguments must name five distinct signed commits: one for unlocked,
one for locked without approval, one for post-sleep, one for post-reboot after
first unlock, and one that GitHub visibly marks `Verified`. The resulting
`acceptance/<hash>.json` contains only these public fields:

```json
{
  "schemaVersion": 1,
  "host": "<host>",
  "macOSVersion": "<version>",
  "ctkPublicKeyHash": "<hash>",
  "sshFingerprint": "SHA256:<base64>",
  "probes": {
    "unlocked": {"commit": "<sha>", "result": "verified"},
    "locked": {"commit": "<sha>", "result": "verified"},
    "sleep": {"commit": "<sha>", "result": "verified"},
    "reboot": {"commit": "<sha>", "result": "verified"}
  },
  "github": {"commit": "<sha>", "verified": true, "result": "verified"},
  "result": "pass",
  "recordedAt": "<UTC timestamp>"
}
```

The CLI writes the record atomically only after all five references pass
verification. A failed rollout remains a failed operator result and must not be
represented as `result: "pass"`; preserve its public SHAs and diagnostics for
the next diagnosis or rollback. No acceptance field contains a private key,
resident handle contents, or secret material.

## Rollback

Rollback is required for any activation error or failed mandatory probe:

1. Set `home.mcp.gitMcpSigning.enable = false` in the host declaration. Do not
   change global Git or SSH configuration.
2. Activate the disabled host and restart mcpproxy:

   ```sh
   sudo darwin-rebuild switch --flake .#<host>
   restart-mcpproxy
   ```

3. Confirm mcpproxy health and the known non-`git-mcp` upstream operation. The
   active marker should disappear because signing is disabled.
4. Retain the CTK identity, resident stub, public key, fingerprint, and any
   acceptance evidence for diagnosis. Do not delete the identity or rebootstrap
   merely because a probe failed.

Global interactive Git remains the 1Password rollback path. Re-enable the same
hash only after repairing the reported condition and rerunning all five probes;
do not rotate or re-register an unchanged identity.

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

4. After registration is confirmed, use the **Declare and activate as test
   setup** and **Physical acceptance** procedures above to select the candidate.
   Set `githubSigningKeyRegistered = true` only for the registered replacement.
   Once the active marker selects the candidate, run `doctor --hash
   <candidate-hash>` and `probe --hash <candidate-hash>`, then repeat all five
   acceptance probes before considering old-key cleanup.

5. Keep the old identity, its local state, and its GitHub signing key until the
   replacement is registered, selected, and has completed the acceptance
   procedure. Then use the inactive-only decommission procedure.

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
copy an identity, stub, or public metadata from another host. The **Initial
enrollment** procedure above begins with:

```sh
git-mcp-secure-enclave-admin bootstrap --label <new-label>
```

That procedure owns initial enrollment, registration, and acceptance. The
command refuses an active marker or non-empty managed identities directory, so
do not run it to overwrite lost state. If the old host is unavailable, do not
claim its platform identity was removed; remove its GitHub signing key only
after the replacement has completed acceptance. If the old host returns,
decommission its old identity only after it is inactive.

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
| Exact `bootstrap`, `doctor`, `probe`, `recover-stub`, `rotate`, `record-acceptance`, and `decommission` forms | Command reference |
| Disabled-state package installation, host-specific identity, `p-256-ne -t none`, public bootstrap output, local verification, refusal, and orphan handling | Initial enrollment |
| GitHub signing-key-only registration before declaration selection | Register before selecting |
| Public declaration, `githubSigningKeyRegistered = true`, active marker, hash-keyed state, and activation/restart as test setup | Declare and activate as test setup |
| Unlocked, locked-without-approval, post-sleep, post-reboot, GitHub `Verified`, author, and upstream-health probes | Physical acceptance |
| Five distinct references and public-only acceptance JSON | Acceptance evidence |
| Rollback that disables only the host option and retains CTK/state | Rollback |
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
