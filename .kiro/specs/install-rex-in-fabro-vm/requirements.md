# Requirements Document

## Introduction

This feature installs Rex on the fabro Lima guest as a multi-user login service reachable over the tailnet, with the Rex package credential delivered to the guest through its sops-nix secret store. See `brief.md` for the problem statement, approach, and scope constraints.

## Boundary Context

- **In scope**: the Rex flake dependency and the gated package credential, delivered to the Fabro VM through the guest's sops-nix store and consumed by guest-side fetches while the Mac keeps using its own local Nix credential configuration; the fabro-vm Rex module with a login server, an accounts map over existing accounts, and defaults; the tailnet-address listener on port 7297 with tailnet reachability; import and argument wiring into the fabro-vm configuration; and `fabro-vm-guest-eval` assertions for the login server, listener, accounts, credential wiring, and the Serve/tsnet/anonymous exclusions.
- **Out of scope**: the shared-server mode, Rex personal servers on any host, built-in Tailscale and Serve exposure for Rex, anonymous or plain listeners, and hand-packaged Rex binaries; deploying or managing the Mac's Nix credential configuration as a secret; removing or reconfiguring OpenCode and decommissioning tailnet services; tailnet ACL, Service, OAuth/tag, or admin-console changes and new accounts; PAM policy customization, account lifecycle, image rebuilds, automatic channel upgrades, Rex Lua customization, and resource-limit tuning.
- **Adjacent expectations**: the guest already has its sops-nix store, age key, and secret sync path working; the guest is already registered as a tag-owned `tag:fabro` node with a resolvable `*.ts.net` name and a running open-source `tailscaled`; the operator's clients are user-owned tailnet devices; the operator's Mac already carries the Rex package credential in its local Nix credential configuration; the Lima cidata account exists imperatively and stays undeclared with `users.mutableUsers` true; the existing `svc:*` Serve advertisement remains untouched.

## Requirements

### Requirement 1: Declarative Rex installation

**Objective:** As the repo maintainer, I want Rex obtained from a pinned upstream flake input, so that the guest runs a reproducible, upgrade-explicit Rex release.

#### Acceptance Criteria

1. The fabro-vm configuration shall obtain Rex from a Rex flake input whose exact release is recorded in the repository's `flake.lock`.
2. When the guest configuration is evaluated, the Rex NixOS module from that input shall be imported into the fabro-vm configuration.
3. The guest configuration shall expose the Rex CLI to every local account after the switch.
4. While the configured Rex input release is unchanged, the guest configuration shall install no other Rex derivation or hand-packaged Rex binary.

### Requirement 2: Rex package credential

**Objective:** As the repo maintainer, I want the Rex tester credential to come from the guest's encrypted secrets store, so that the gated flake fetches on the guest without hand-placed or committed secrets.

#### Acceptance Criteria

1. The Fabro VM shall take the Rex package credential from its sops-nix secret store rather than from a hand-placed file on the guest.
2. When system activation decrypts the guest's secrets, the guest shall write the Rex package credential to a root-only-readable path outside the Nix store.
3. When the guest fetches the Rex flake input, the fetch shall authenticate with the credential decrypted from the guest's sops-nix store.
4. If the decrypted Rex package credential is missing or empty, then the guest's Rex flake fetch shall fail instead of resolving Rex from an alternative source.
5. The repository, the Nix store, and the rendered guest configuration shall contain no plaintext Rex package credential.
6. When the maintainer rotates the credential through the guest's existing secret sync path and switches the guest, subsequent Rex flake fetches on the guest shall use the rotated credential without manual file edits.
7. While the configuration is evaluated on the Mac, the Rex flake fetch shall authenticate through the operator's local Nix credential configuration and shall not require the guest's decrypted credential.

### Requirement 3: Rex login service at boot

**Objective:** As a Rex user, I want the Rex login server to run whenever the guest is up, so that remote sessions work without manual service management.

#### Acceptance Criteria

1. When the guest boots, the guest shall start the Rex login server and keep it enabled across reboots.
2. When the Rex login server exits unexpectedly, the guest shall restart it.
3. The Rex login server shall run as the privileged login service that identifies callers and starts a Rex server per account.
4. The guest configuration shall not enable Rex's shared-server mode alongside the login service.

### Requirement 4: Existing-account access

**Objective:** As the guest operator, I want existing Linux accounts mapped to tailnet identities, so that each caller works as their own account.

#### Acceptance Criteria

1. The Rex login server's accounts map shall map the Lima cidata account `brandonmcnama` to its Tailscale principal or principals.
2. The accounts map shall set `brandonmcnama` as the default account for each mapped principal when a caller names no account.
3. The accounts map shall grant no access to `root` or any system account.
4. When a caller's tailnet principal matches an account in the accounts map, the Rex login server shall start a Rex server for that caller as that Linux account.
5. When a caller asks for an account before the host in the connection address, the Rex login server shall select that account if the caller's principal is allowed to use it.
6. If a caller's tailnet principal matches no account in the accounts map, then the Rex login server shall refuse the connection.
7. If a caller asks for an account its principal may not use, then the Rex login server shall refuse the connection.
8. The guest configuration shall not create, declare, or modify any Linux account.

### Requirement 5: Tailnet-address endpoint

**Objective:** As a Rex user, I want to reach the guest at its own tailnet address, so that clients connect without SSH or a web terminal.

#### Acceptance Criteria

1. When the guest is up and registered on the tailnet, the guest shall accept Rex client connections at `http://<node>.<tailnet>.ts.net:7297`.
2. The Rex login server shall identify each caller through the guest's own open-source `tailscaled` before granting access.
3. The guest shall accept inbound TCP connections on port 7297 over its tailnet interface while the Rex login server runs.
4. While a client connects to port 7297, the client shall be able to select an account with an `http://` address that names the account before the host.
5. The Rex login server shall not expose Rex through Tailscale Serve, the built-in Tailscale listener, an anonymous listener, or any non-loopback listener other than the tailnet-address listener.
6. The guest configuration shall leave the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` Serve advertisements unchanged and shall add no Serve configuration for Rex.
7. If the Rex login server cannot bind its tailnet-address listener, then the guest shall report the service as failed and record the bind error in the unit journal.

### Requirement 6: Session continuity and multiple accounts

**Objective:** As a Rex user, I want persistent sessions and per-account servers, so that mobile connections can resume work across service restarts.

#### Acceptance Criteria

1. When a caller connects while its account's Rex server is already running, the Rex login server shall reuse that server.
2. When the Rex login server stops, restarts, or is upgraded, each account's running Rex server and its sessions shall survive.
3. When the accounts map changes and the guest switches configuration, the Rex login server shall apply the new map without terminating sessions that remain allowed.
4. When the accounts map changes and a caller's access is removed, the Rex login server shall close that caller's connection while leaving the affected account's server running.
5. Where multiple accounts are mapped, each account shall have its own Rex server and its own sessions.

### Requirement 7: Login-session integration

**Objective:** As the guest operator, I want Rex sessions to behave like normal Linux logins, so that account permissions, environment, and limits follow the existing guest setup.

#### Acceptance Criteria

1. When the Rex login server starts a server for an account, the guest shall open the login session through the system's PAM login policy for that account.
2. When the Rex login server starts a server for the cidata account, the guest shall run it under that account's user manager and its logind wiring.
3. The guest configuration shall keep the cidata account's existing linger and user-manager behavior working.
4. While an account has no local interactive login, the guest shall keep that account's user manager available to the Rex login server.
5. If the PAM login policy refuses an account, then the guest shall refuse the Rex connection for that account.

### Requirement 8: Evaluated verification

**Objective:** As the repo maintainer, I want automated checks over the evaluated guest, so that future changes cannot silently alter Rex exposure, accounts, or credentials.

#### Acceptance Criteria

1. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that the Rex login server is enabled and starts at boot.
2. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that the login server's command line carries the tailnet-address listener on port 7297.
3. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that the accounts map maps `brandonmcnama` to its Tailscale principal and that `defaults` selects it.
4. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that root access is absent from the rendered accounts.
5. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that Rex Serve exposure, built-in Tailscale, shared-server mode, and anonymous listeners are absent.
6. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that the guest's package set exposes the Rex package from the Rex flake input and that the existing `svc:*` Serve advertisement is unchanged.
7. When `nix flake check` evaluates the fabro-vm guest, the checks shall verify that the Rex package credential is declared in the guest's sops-nix secret store and that the guest's Rex input fetch references its decrypted path rather than a literal credential.
8. While the checks run on a host without a Linux builder, the Rex checks shall complete through pure evaluation of the guest configuration.
