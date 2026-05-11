# Requirements Document

## Introduction

The `nix-config` repository deploys MCP (Model Context Protocol)
secrets to two macOS hosts (ShopifyLaptop and Brandons-MacBook-Pro)
through an imperative bridge: a `mcp-sync-secrets` shell script
reads secrets from 1Password via `op` and writes them into the
macOS Keychain. The script is installed by home-manager but is NOT
invoked at activation; `darwin-rebuild switch` only prints a
reminder for the maintainer to run it. Secret rotation, host
addition, and stale-entry cleanup are all manual. The `gh` CLI
authentication token follows a similarly imperative bootstrap
(one-time `gh auth login` per laptop), with state stored in
`~/.config/gh/hosts.yml` outside any management.

This feature replaces the imperative bridge with a declarative
deployment pipeline. 1Password remains the canonical place where
the maintainer edits secret values. An encrypted store committed
to the repository serves as the deployable cache: on
`darwin-rebuild switch`, the host decrypts its own scoped portion
of the store using a per-host decryption key, and the resulting
plaintext is written into the same macOS Keychain layout existing
consumers already rely on. A separate sync tool, run on demand by
the maintainer, refreshes the encrypted store from 1Password. The
`gh` CLI authentication token is folded into the same pipeline so
that a freshly bootstrapped laptop has a working `gh` without any
manual `gh auth login`.

The migration is gated: the legacy `mcp-sync-secrets` script and
its activation reminder remain in place until parity with the new
pipeline is verified on both hosts, after which they are removed.
Operator-facing documentation captures the per-host bootstrap
procedure, the recipient-enrollment workflow for adding a third
host, the secret-rotation workflow, and the rationale for what is
deliberately NOT folded into this pipeline.

## Boundary Context

- **In scope**: deployment of the 14 declared MCP keychain
  secrets (6 on ShopifyLaptop, 8 on Brandons-MacBook-Pro) plus the
  `gh` CLI authentication token, on both hosts, via a declarative
  encrypted store with per-host decryption keys sourced from
  1Password. Includes the on-demand sync tool, the activation
  pipeline, stale-entry cleanup, decommissioning of the legacy
  `mcp-sync-secrets` bridge, and operator documentation.
- **Out of scope**: OpenCode `OPENCODE_API_KEY` (minted per
  invocation by `devx llm-gateway`); the `~/.cache/tool-gateway-token`
  file (populated by external Shopify tooling); 1Password SSH
  commit signing; the Atuin sync key; AWS credentials; SSH host
  and user keys; reclassification of `mcp-fastmail-username` as a
  non-secret. A future migration that bypasses the macOS Keychain
  in favor of direct file consumption is explicitly deferred to a
  separate spec.
- **Adjacent expectations**: mcphub MCP servers continue to read
  secrets via the existing `${cmd: security find-generic-password
  -s '<service>' -a mcp-hub -w}` placeholder pattern. The
  `home.mcp.keychainSecrets` consumer attrset and the
  `readKeychainSecret` helper signature remain unchanged. 1Password
  remains the canonical place for the maintainer to edit secret
  values; the encrypted store is treated as a deployable cache and
  must never be edited directly.

## Requirements

### Requirement 1: Declarative deployment of MCP secrets at activation

**Objective:** As the maintainer of nix-config, I want every
declared MCP secret to be populated by `darwin-rebuild switch`
without any manual follow-up, so that activation alone leaves the
host operational.

#### Acceptance Criteria

1. When `darwin-rebuild switch` completes successfully on a host, the system shall ensure every secret declared for that host is present in the macOS Keychain with the value sourced from the host's encrypted secrets store.
2. The system shall NOT require any post-activation manual command to populate, refresh, or finalize secrets.
3. When `darwin-rebuild switch` runs while 1Password CLI is not authenticated, signed out, or unreachable, the system shall still successfully populate every declared secret using only the host's local decryption key and the encrypted store committed to the repository.
4. While 1Password is unavailable to the host (offline, vault locked, or CLI not installed), the system shall complete activation of declared secrets without error.
5. When `darwin-rebuild switch` runs repeatedly with no change to declared secrets and no change to the encrypted store, the system shall make no Keychain modifications beyond updating the value of any entry that has drifted from its declared value.

### Requirement 2: Per-host secret isolation

**Objective:** As the maintainer, I want each host's secrets
encrypted such that only that host can decrypt them, so that
compromise of one host's decryption key does not expose any other
host's secrets.

#### Acceptance Criteria

1. The system shall ensure that ShopifyLaptop's portion of the encrypted store cannot be decrypted using Brandons-MacBook-Pro's decryption key.
2. The system shall ensure that Brandons-MacBook-Pro's portion of the encrypted store cannot be decrypted using ShopifyLaptop's decryption key.
3. When a host attempts decryption with a key that is not in the encrypted file's recipient list, the system shall fail decryption with an operator-visible diagnostic that names the host, the file, and the missing recipient relationship.
4. When the maintainer adds a secret to one host's declared set, the system shall NOT cause that secret to become readable by any other host without an explicit recipient-enrollment step.

### Requirement 3: Per-host bootstrap workflow

**Objective:** As the maintainer setting up a new laptop or
restoring an existing one, I want the decryption-key bootstrap to
be a single documented command, so that the host can complete
`darwin-rebuild switch` without bespoke ceremony.

#### Acceptance Criteria

1. The system shall provide a documented bootstrap procedure that consists of fetching one secret from 1Password and writing it to a known on-disk location dedicated to this pipeline.
2. When the bootstrap procedure has been completed successfully on a host, the system shall successfully decrypt that host's secrets at every subsequent `darwin-rebuild switch` without any further 1Password involvement.
3. While the bootstrap procedure has NOT been completed on a host, the system shall fail activation of declared secrets with an operator-visible diagnostic that names the missing decryption-key location and points to the bootstrap documentation.
4. When the maintainer adds a third host to the configuration, the system shall require an existing host (already enrolled as a recipient) to enroll the new host before the new host can decrypt its own secrets, and the system shall document this enrollment workflow in the operator documentation.

### Requirement 4: On-demand sync from 1Password to the encrypted store

**Objective:** As the maintainer, I want a single command to
refresh the encrypted store from 1Password, so that adding,
rotating, or removing a secret is a low-ceremony operation.

#### Acceptance Criteria

1. The system shall provide a sync tool that, when invoked, reads each currently-declared secret from 1Password and writes the resulting values into the host-appropriate encrypted store committed to the repository.
2. When the sync tool runs without an authenticated 1Password CLI session, the system shall fail with an operator-visible diagnostic that explicitly states 1Password authentication is required.
3. When a 1Password URI declared in configuration cannot be resolved (item missing, field renamed, vault inaccessible), the sync tool shall fail with a diagnostic that names the failing URI before any partial result is written to the encrypted store.
4. When the sync tool succeeds and no underlying secret value has changed in 1Password since the previous successful sync, the system shall produce no value-level change to the encrypted store (no added, removed, or modified entries when the encrypted store is decrypted and compared).
5. If the sync tool fails partway through, the system shall leave the encrypted store in its prior committed state — no partially-updated file is written.

### Requirement 5: Stale-entry cleanup at activation

**Objective:** As the maintainer, I want secrets removed from the
configuration to disappear from the macOS Keychain on the next
activation, so that decommissioned tokens do not linger indefinitely
on disk.

#### Acceptance Criteria

1. When a Keychain entry was installed by this pipeline at a previous activation but is absent from the current activation's declared set, the system shall remove that entry from the macOS Keychain.
2. When a Keychain entry was NOT installed by this pipeline (an entry created by another tool or manually), the system shall NOT remove or modify that entry, even if its service or account name resembles a managed entry.
3. The system shall produce an operator-visible log line for each Keychain entry it adds, updates, or removes during activation, including the service name and the operation performed.

### Requirement 6: `gh` CLI authentication token management

**Objective:** As the maintainer, I want `gh` CLI authentication
to come from the same declarative pipeline as MCP secrets, so that
a freshly bootstrapped laptop has a working `gh` without any
manual `gh auth login`.

#### Acceptance Criteria

1. When `darwin-rebuild switch` completes on a host that has the `gh` token declared, the system shall configure the `gh` CLI such that subsequent `gh` invocations are authenticated against GitHub for the maintainer's identity.
2. The `gh` token shall be sourced from the same encrypted store as MCP secrets, on the same per-host scoping basis described in Requirement 2.
3. When the `gh` token declaration is removed for a host, the system shall remove the host's `gh` authentication artifact from `~/.config/gh/hosts.yml` during the next activation.
4. When the maintainer rotates the `gh` token in 1Password and runs the sync tool followed by `darwin-rebuild switch`, the system shall update the host's `gh` authentication artifact such that subsequent `gh` invocations use the new token.

### Requirement 7: Backwards compatibility with existing MCP consumers

**Objective:** As the operator of running MCP servers, I want the
runtime contract for reading secrets to be unchanged, so that no
MCP server configuration or behavior changes during this migration.

#### Acceptance Criteria

1. The system shall preserve the macOS Keychain service-name and account-name layout that MCP servers currently rely on (service `mcp-<name>`, account `mcp-hub`, in `login.keychain-db`).
2. When an mcphub MCP server looks up a secret using the existing `${cmd: security find-generic-password -s '<service>' -a mcp-hub -w}` placeholder, the system shall return the same value the consumer would have read after a successful run of the legacy `mcp-sync-secrets` script.
3. The system shall NOT require any change to the `home.mcp.keychainSecrets` consumer attrset shape, the `readKeychainSecret` helper function signature, or any mcphub server's `${cmd: ...}` placeholder.

### Requirement 8: Decommissioning the imperative bridge

**Objective:** As the maintainer, I want the legacy
`mcp-sync-secrets` script and its activation reminder removed
once the new pipeline is verified, so that there is exactly one
sanctioned way to populate MCP secrets on a host.

#### Acceptance Criteria

1. While verification of the new pipeline is incomplete on either host, the system shall preserve the `mcp-sync-secrets` script and its `home.activation.mcpKeychainSecrets` reminder so the legacy fallback remains available to the maintainer.
2. When verification of the new pipeline is complete on both hosts, the system shall remove the `mcp-sync-secrets` script, its `home.activation.mcpKeychainSecrets` reminder, and any other artifacts of the legacy bridge from the codebase.
3. After decommissioning, the system shall NOT leave references to `mcp-sync-secrets` in user-facing documentation, AGENTS.md, steering files, or any other operator-visible surface.

### Requirement 9: Operator documentation

**Objective:** As a future-self adding a new laptop, rotating a
key, or onboarding the system months from now, I want the
bootstrap, sync, recovery, and out-of-scope rationale documented
in the repository, so that I do not have to reverse-engineer them
from the spec or the code.

#### Acceptance Criteria

1. The system shall include a `secrets/README.md` that documents the per-host bootstrap procedure (where to fetch the host's decryption key from 1Password, where to write it on disk, how to verify the host is enrolled).
2. The `secrets/README.md` shall document the workflow for adding a new host as a decryption recipient, including the chicken-and-egg constraint that an existing host must enroll the new host before the new host can decrypt its own secrets.
3. The `secrets/README.md` shall document the workflow for rotating a secret value (edit in 1Password → run the sync tool → commit → activate), including the verification step the maintainer should perform after rotation.
4. The `secrets/README.md` shall document why the OpenCode `OPENCODE_API_KEY` flow and the `~/.cache/tool-gateway-token` cache file are deliberately NOT in scope, so that a future-self does not try to fold them in prematurely.
5. The `secrets/README.md` shall document the recovery workflow for a host whose decryption key has been lost (re-enrollment via an existing host).
