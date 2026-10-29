# Requirements Document

## Introduction

This document specifies the required behavior for installing Rex on the Fabro
VM guest, mapping it to existing local accounts, and exposing it over the
tailnet. See `brief.md` for the problem statement, approach, and scope.

## Boundary Context

- **In scope**: the guest node's own tailnet HTTPS endpoint as the Rex exposure
  path (not a new Tailscale Service), the account map limited to accounts that
  already exist on the guest, the gated-release credential path on every host
  that evaluates the guest configuration, and fail-closed behavior for unmapped
  principals and unavailable gated releases.
- **Out of scope**: Rex shared-server mode, Rex's built-in Tailscale support,
  plain or anonymous listeners, OpenCode decommissioning, tailnet ACL or
  Tailscale Service edits, OAuth and tag ownership, admin-console changes,
  creating or modifying local accounts, PAM policy beyond the module default,
  Rex Lua customization, agents and MCP features, session recording, resource
  limit tuning, macOS client setup, image rebuilds, and automatic channel
  upgrades.
- **Adjacent expectations**: the guest's Tailscale daemon is running, joined to
  the tailnet, and permitted to serve HTTPS on the node's own name; tailnet ACLs
  admit the operator's device; the cidata account is created by the guest image
  and its user manager stays running; the gated Rex release credential is
  configured on the host that evaluates checks and on the guest.

## Requirements

### Requirement 1: Declarative Rex installation

**Objective:** As the operator, I want Rex installed on the guest through the
repository's declarative flake configuration, so that guest rebuilds install a
known Rex release without manual steps.

#### Acceptance Criteria

1. The Rex installation shall source Rex from the upstream Rex flake rather than
   a hand-packaged binary or an imperative install.
2. The Rex installation shall record the Rex release identity in
   repository-managed dependency state.
3. While the recorded Rex pin is unchanged, repeated guest rebuilds shall install
   the same Rex release.
4. When the operator applies a guest rebuild, the guest shall install and enable
   Rex without a separate bootstrap command.
5. When the operator updates the Rex pin and applies a guest rebuild, the guest
   shall run the updated Rex release.
6. If the pinned Rex release cannot be fetched or verified, then the guest
   rebuild shall fail rather than activate a different Rex release.

### Requirement 2: Login server sessions

**Objective:** As the operator, I want the Rex login server running on the guest,
so that I can open and keep persistent terminal sessions on Fabro from a Rex
client without SSH.

#### Acceptance Criteria

1. When the guest boots, the guest shall start the Rex login server.
2. When the operator connects from a Rex client over the tailnet, the Rex login
   server shall start or resume a Rex session as the operator's mapped account.
3. When a Rex client disconnects or loses connectivity, the Rex session shall
   keep running on the guest.
4. When the operator reconnects from a Rex client, the Rex login server shall
   make the existing Rex session for the mapped account available to resume.
5. When the Rex login server restarts, existing Rex sessions shall keep running.
6. The Rex configuration shall document the guest's connect endpoint and how
   accounts are selected for connections.

### Requirement 3: Account mapping and isolation

**Objective:** As the guest administrator, I want existing local accounts mapped
to Tailscale principals, so that each operator reaches only their own account's
sessions.

#### Acceptance Criteria

1. The Rex configuration shall map the cidata account (`brandonmcnama`) to at
   least one declared Tailscale principal.
2. While the cidata account is created by the guest image, the Rex configuration
   shall reference that account by name without declaring, modifying, or
   removing it.
3. When a connection presents a Tailscale principal with no mapped account, the
   Rex login server shall refuse to start a Rex session for that connection.
4. The default account map shall not grant access to the root account or to
   system accounts.
5. Where an additional existing local account is declared with a Tailscale
   principal, the Rex login server shall serve that account's Rex sessions under
   that account's own identity.
6. When a mapped account starts a Rex session, the Rex login server shall not
   expose another mapped account's Rex sessions to that connection.
7. A mapped account shall not need a password, an SSH key, or an interactive
   login on the guest to start a Rex session.
8. If a mapped account is absent from the guest at connection time, then the Rex
   login server shall refuse to start the session rather than run it under
   another account.
9. The Rex configuration shall apply one declared set of defaults to every
   mapped account's per-account Rex server.
10. Where account-specific settings are declared, the Rex login server shall
    apply them instead of the defaults for that account.

### Requirement 4: Tailnet exposure through the guest's Tailscale daemon

**Objective:** As the operator, I want the Rex login server reachable over the
tailnet through the guest's own Tailscale daemon, so that exposure follows the
open-source Tailscale path the guest already runs.

#### Acceptance Criteria

1. The Rex login server shall expose its endpoint through Tailscale Serve on the
   guest's own Tailscale daemon.
2. The Rex endpoint shall be reachable at the guest node's own tailnet HTTPS
   name rather than a Tailscale Service hostname.
3. The Rex installation shall not use Rex's built-in Tailscale support or start
   its own Tailscale node.
4. The Rex installation shall not listen on a plain or anonymous endpoint.
5. The Rex exposure shall be reachable only by devices on the tailnet.
6. The Rex exposure shall not be reachable from the public internet.
7. If a connection arrives from a tagged device, then the Rex login server shall
   not attribute that connection to any mapped account's Tailscale principal.
8. The Rex installation shall not change the guest's existing Tailscale Service
   advertisements (`svc:fabro`, `svc:litellm`, and `svc:opencode`).

### Requirement 5: Configuration verification

**Objective:** As the repository maintainer, I want automated checks over the
guest's Rex configuration, so that account mapping and exposure cannot regress
silently.

#### Acceptance Criteria

1. When the guest configuration is evaluated, the repository checks shall verify
   that the Rex login server is enabled.
2. When the guest configuration is evaluated, the repository checks shall verify
   that the cidata account and its declared Tailscale principal appear in the
   account map.
3. When the guest configuration is evaluated, the repository checks shall verify
   that Tailscale Serve exposure is enabled for the Rex login server.
4. When the guest configuration is evaluated, the repository checks shall verify
   that Rex's built-in Tailscale support is not in use.
5. When the guest configuration is evaluated, the repository checks shall verify
   that the Rex server components resolve from the pinned upstream Rex release.
6. If shared-server mode or Rex's built-in Tailscale support is configured for
   the guest, then the repository checks shall fail with a message naming the
   unsupported mode.

### Requirement 6: Gated release credential path

**Objective:** As the repository maintainer, I want the gated Rex release
credential available on every host that evaluates the guest, so that both the
Mac checks and the guest rebuild can fetch the pinned release.

#### Acceptance Criteria

1. The Rex installation shall obtain the gated Rex release through a credential
   configured on each host that evaluates the guest configuration.
2. When the Mac host evaluates the guest configuration with the credential
   configured, the pinned Rex release shall be available to the evaluation.
3. When the guest applies a rebuild with the credential configured, the pinned
   Rex release shall be available to the rebuild.
4. If the credential is absent or rejected on an evaluating host, then fetching
   the pinned Rex release shall fail with an authentication error that names the
   missing or rejected credential instead of substituting another source.
5. The Rex installation shall not commit the credential to the repository or
   place it in the Nix store.
6. The credential path shall work on a host that does not mount the guest's
   encrypted secret store.
