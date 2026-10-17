# Research & Design Decisions

## Summary

- **Feature**: `mac-nix-remote-builder`
- **Discovery Scope**: New Feature (new nix-darwin host + new personal-host Lima guest + deploy/bootstrap tooling).
- **Key Findings**:
  - Lima supports macOS guests experimentally since v2.1 (`os: Darwin`, `vmType: vz` only,
    `arch: aarch64`, Apple CDN `.ipsw` images). Stable Lima is v2.2.1; the repo's
    `pkgs.unstable.lima` resolves to 2.2.0.
  - The First-Run-Experience skip (`osOpts.Darwin.suppressFirstLoginSetup`) landed in
    commit `c700cfd61f` (2026-07-24) and ships only in **Lima >= 2.3** (currently
    `v2.3.0-beta.1`); it is absent from v2.2.0 and v2.2.1, and nixpkgs (even `master`)
    still packages 2.2.0. Using it requires a pinned Lima 2.3 source.
  - macOS guests get **no automatic host port-forwarding** and no custom CA certs;
    Lima documents `ssh -L` or the `vzNAT` network as the reachability paths.
  - The macOS cidata user is created **admin** with a generated password written to
    `~/password` (mode 0400); password-less sudo is otherwise disabled.
  - The repo's nix-darwin (`nix-darwin-26.05`) `users.users.<name>` has no
    `openssh.authorizedKeys`; `services.openssh` only manages the server, host keys,
    and `extraConfig`. Authorized keys must be installed by activation.
  - The removed `shopify-remote-builder` spec established the Nix remote-builder
    facts reused here: direct `ssh-ng://` (worker protocol over `nix-daemon --stdio`),
    the connecting account must be a `trusted-users` member of the builder daemon,
    and host-key pinning is a client concern.

## Research Log

### Lima macOS guest support

- **Context**: The issue asks for a Lima macOS guest with the latest released macOS,
  and a host config not coupled to Lima FRE internals.
- **Sources Consulted**:
  - <https://lima-vm.io/docs/usage/guests/macos/> (`website/content/en/docs/usage/guests/macos.md`)
  - `templates/macos.yaml`, `templates/macos-26.yaml`, `templates/macos-27.yaml`,
    `templates/_images/macos-26.yaml`, `templates/_images/macos-27.yaml`
  - <https://lima-vm.io/docs/config/network/vmnet/>
- **Findings**:
  - Requirement: Lima >= 2.1, macOS (host) same or newer, ARM. `vmType: vz` is the
    only supported type; `os: Darwin`; images are Apple `UniversalMac_*_Restore.ipsw`.
  - `templates/macos-27.yaml` requires `minimumLimaVersion: 2.1.0`, sets
    `video.display: "default"` (the installer requires a display device), and bases
    on `_images/macos-27` + `_default/mounts` (which mounts `~`).
  - Differences from Linux guests: password login enabled; password-less sudo
    disabled except `/sbin/shutdown -h now`; **no automatic port forwarding** (use
    `ssh -L` or `vzNAT`); no custom CA certs.
  - `networks: [{ vzNAT: true }]` (Lima >= 0.14, macOS >= 13) gives the guest a
    "real" IP reachable from the host, with an unspecifiable range.
- **Implications**: The guest must be rendered with an explicit pinned image,
  `video.display`, `mounts: []`, and no containerd; reachability needs an explicit
  host-side mechanism because macOS guests have no automatic forwarding.

### Suppressing the macOS first-login setup wizard

- **Context**: The issue calls out "how it skips First Run Experience" as a Lima
  detail the builder host config must not encode.
- **Sources Consulted**: macOS guest docs; commit `c700cfd61f`; `pkg/guestagent/fakecloudinit/fakecloudinit_darwin.go`; `pkg/limatype/lima_yaml.go` at tags.
- **Findings**:
  - `osOpts.Darwin.suppressFirstLoginSetup: true` (Lima >= 2.3, macOS >= 13) has Lima
    pre-populate `com.apple.SetupAssistant.plist` and `com.apple.SoftwareUpdate`
    preferences as root before first login. A custom plist is accepted verbatim.
  - The implementation (`suppressFirstLoginScreens`) runs during guest user creation
    via `fakecloudinit`, chowns the plist to the user, and uses `defaults write` so
    `cfprefsd` owns the domain.
  - Availability: v2.2.0/v2.2.1 → absent; v2.3.0-beta.1 → present. Latest stable
    release is v2.2.1 (2026-10-03); latest tag is v2.3.0-beta.1 (2026-10-03).
  - nixpkgs `pkgs/by-name/li/lima/source.nix` pins version `2.2.0` on both the
    repo's `nixpkgs-unstable` rev (`c27cdad491a9`, 2026-08-27) and nixpkgs `master`.
- **Implications**: Satisfying the FRE requirement without coupling the guest config
  requires pinning a Lima >= 2.3 build (decision below).

### Lima macOS user creation, password, and sudo

- **Context**: The one-touch deploy needs root in the guest.
- **Sources Consulted**: `pkg/guestagent/fakecloudinit/fakecloudinit_darwin.go`.
- **Findings**:
  - Users are created with `sysadminctl -addUser <name> -UID <uid> -password - -home
    <home> -admin` (the cidata user is an admin).
  - The generated password is written to `<home>/password` (mode 0400).
  - `writeSudoers` writes `/etc/sudoers.d/90-cloud-init-users` only when the cidata
    entry carries a `sudo` field; the documented macOS behavior keeps password-less
    sudo off otherwise.
  - `templates/homebrew-macos.yaml` installs `/usr/local/bin/lima-sudo-askpass.sh`
    (`cat "$HOME/password"`) and drives `sudo` with `SUDO_ASKPASS` for its `mode: user`
    provisioning.
- **Implications**: The deploy performs root steps with `sudo -A` and an askpass
  helper that reads the guest's `~/password`; no sudoers change is required.

### Nix remote-builder protocol

- **Context**: The builder must expose a standard Nix remote-builder endpoint.
- **Sources Consulted**: Removed `shopify-remote-builder` spec (research.md/design.md);
  Nix distributed-builds and ssh-store docs.
- **Findings**:
  - A direct `ssh-ng://<user>@<host>` store runs `nix-daemon --stdio` on the remote and
    negotiates the worker protocol; it needs no client-side builder registration.
  - The connecting account must be a `trusted-users` member of the remote daemon for
    the client to set build options; a nix-darwin host trusts the login user by default.
  - Foreign-system derivations fail on the builder because the daemon declares only
    its own system (`aarch64-darwin`) and no `extra-platforms`.
  - Host-key pinning (`base64-ssh-public-host-key`) and `nix.buildMachines` are
    client-side concerns.
- **Implications**: The builder needs OpenSSH, the non-privileged builder user in
  `nix.settings.trusted-users`, and no extra platforms; client wiring stays downstream.

### nix-darwin user and OpenSSH modules (26.05)

- **Context**: The builder host is a new nix-darwin configuration.
- **Sources Consulted**: `LnL7/nix-darwin` tag `nix-darwin-26.05`, files
  `modules/users/user.nix`, `modules/services/openssh.nix`.
- **Findings**:
  - `users.users.<name>` supports `uid`, `gid` (default 20 `staff`), `isHidden`
    (default true), `home`, `createHome`, `shell`, `packages`; there is **no**
    `extraGroups` and **no** `openssh.authorizedKeys`.
  - `services.openssh` exposes `enable` (Apple's built-in sshd), `extraConfig`
    (`/etc/ssh/sshd_config.d/100-nix-darwin.conf`), and `hostKeys` (default
    rsa/ecdsa/ed25519 at `/etc/ssh/`).
  - Custom `system.activationScripts.<name>` entries are not invoked; ordering is
    controlled via known names such as `postActivation.text`.
- **Implications**: The builder user is created by `users.users`; its authorized keys
  are installed by a `postActivation` fragment that runs after sops decryption
  (`lib.mkOrder 9999`, mirroring `configurations/common-darwin/mcp-sops-bridge.nix`).

### sops-nix on nix-darwin and fresh-host bootstrap

- **Context**: The builder takes secrets from its own sops-nix store.
- **Sources Consulted**: `configurations/common-darwin/mcp-sops-bridge.nix`;
  `secrets/README.md` ("Bootstrap", "Adding a new host"); `scripts/bootstrap-nix-github-token.sh`.
- **Findings**:
  - sops-nix's darwin module decrypts to `/run/secrets/<name>` from the age key at
    `/var/lib/sops-nix/key.txt`; its install script runs in `postActivation.text` at
    `mkAfter` (order 1500).
  - The documented bootstrap reads the age private key from 1Password
    (`op read 'op://<vault>/sops-age-key-<host>/notesPlain'`) and installs it at
    `/var/lib/sops-nix/key.txt` **before** the first `darwin-rebuild switch`.
  - Per-host stores are `<feature>.<host-role>.yaml` with one recipient anchor each.
- **Implications**: The deploy installs the builder age key from 1Password before the
  first switch; the store is `secrets/remote-builder.mac-builder.yaml` owned by a new
  `&host_mac_builder` recipient.

## Design Decisions

### Decision: Host-side SSH port-forward for the builder endpoint

- **Context**: macOS guests have no automatic port-forwarding, so `ssh-ng://` clients
  cannot reach the guest's sshd through a Lima-managed TCP port.
- **Alternatives Considered**:
  1. Host launchd-managed SSH port-forward (`ssh -N -L` through the Lima SSH config).
  2. `vzNAT` guest IP (dynamic; needs discovery).
  3. `socket_vmnet` managed network with a fixed MAC (needs root install + sudoers).
  4. Lima SSH-config alias only (host-local; no LAN reachability).
- **Selected Approach**: A second launchd agent on the personal host runs
  `ssh -F <LIMA_HOME>/<name>/ssh.config -N -L <bind>:<port>:127.0.0.1:22 lima-<name>`,
  exposing the guest's sshd on a stable host address/port. The `-L` destination is
  resolved by the guest's sshd, so no guest IP discovery is needed.
- **Rationale**: Deterministic, Lima-supported, and reuses the existing launchd
  lifecycle pattern without adding root-level network helpers.
- **Trade-offs**: Adds a host service; LAN exposure depends on the configured bind
  address. Mitigated by key-only SSH auth to a non-privileged user.
- **Follow-up**: Confirm the bind address and port on the personal host; verify the
  tunnel survives VM restart.

### Decision: New sibling Home Manager module for the macOS guest

- **Context**: `home-manager/common/lima-vm.nix` (`virtualisation.limaVM`) is a
  single-instance, NixOS-specific module.
- **Alternatives Considered**:
  1. New sibling module `virtualisation.limaMacGuest`, reusing the launchd supervisor
     pattern; leave `virtualisation.limaVM` untouched.
  2. Generalize to `virtualisation.limaVMs.<name>` and migrate `fabro`.
  3. Nest the guest inside the existing `virtualisation.limaVM` module.
- **Selected Approach**: Option 1. The new module renders macOS-specific YAML
  (`os: Darwin`, `vz`, ipsw image, `osOpts`, `mounts: []`, no containerd) and its own
  supervisor + forward launchd agents, mirroring the existing supervisor flow.
- **Rationale**: Satisfies requirement 5.7 (independence) and keeps the existing
  NixOS module, its flake references, and its tests unchanged.
- **Trade-offs**: Some supervisor/limactl-wrapper logic is similar to `lima-vm.nix`;
  accepted to avoid refactoring a tested module.
- **Follow-up**: Factor the shared supervisor flow into a helper if a third instance
  is ever needed.

### Decision: Pin Lima 2.3 for the macOS guest

- **Context**: `osOpts.Darwin.suppressFirstLoginSetup` requires Lima >= 2.3, which is
  not in the pinned nixpkgs (2.2.0).
- **Alternatives Considered**:
  1. Pin a Lima 2.3 build (dedicated flake input or an overlay package from the
     v2.3.0-beta.1 source) and use the built-in FRE skip.
  2. Stay on stable Lima 2.2 and write the SetupAssistant plist from personal-host
     provisioning.
- **Selected Approach**: Option 1. Add a pinned Lima >= 2.3 package used only by
  `virtualisation.limaMacGuest.package`; render `minimumLimaVersion` >= 2.3 and
  `osOpts.Darwin.suppressFirstLoginSetup = true`.
- **Rationale**: Keeps the FRE skip a Lima concern (the issue's intent) and avoids
  re-implementing an OS-specific plist in repo code.
- **Trade-offs**: Depends on a Lima pre-release; the pinned package must track the
  first stable 2.3. Lima's own flake does not exist, so the package is built from
  source (overlay) or overridden from nixpkgs with the beta `src`/`vendorHash`.
- **Follow-up**: Capture the correct `vendorHash` when pinning; switch to stable 2.3
  when released (a revalidation trigger).

### Decision: Deploy installs the builder age key from 1Password

- **Context**: The builder's sops store needs its age private key before the first
  switch; the builder is a fresh macOS with no `op`.
- **Alternatives Considered**:
  1. Deploy reads the age key from 1Password on the operator host and streams it in.
  2. Manual operator prerequisite.
  3. Personal-host Lima provisioning injects the key.
- **Selected Approach**: Option 1, matching `secrets/README.md` and
  `scripts/bootstrap-nix-github-token.sh`.
- **Rationale**: Keeps the deploy a single invocation (requirement 6.1) while keeping
  the key out of the Nix store and out of the repo.
- **Trade-offs**: The operator host needs an authenticated `op`; the deploy exposes an
  override reference for rotation.
- **Follow-up**: Document the 1Password item and rotation in `secrets/README.md`.

## Risks & Mitigations

- Lima 2.3 beta pin breaks or the source hash drifts — pin the exact tag and
  `vendorHash`; record the first-stable-2.3 upgrade as a revalidation trigger.
- macOS image digest/URL changes with each Apple release — pin location + digest in
  one place and treat a bump as a deliberate change.
- Host port-forward exposure — bind address is an explicit option; SSH is key-only and
  the builder user is non-privileged.
- Password-less sudo is disabled on macOS guests — deploy uses `sudo -A` with an
  askpass helper reading the Lima-generated `~/password`.
- nix-darwin does not manage per-user authorized keys — keys are installed by a
  `postActivation` fragment ordered after sops decryption; activation fails if the
  secret is missing.

## References

- Lima macOS guests — <https://lima-vm.io/docs/usage/guests/macos/>
- Lima VMNet networks (vzNAT) — <https://lima-vm.io/docs/config/network/vmnet/>
- Lima templates — `templates/macos-27.yaml`, `templates/_images/macos-27.yaml`
  (<https://github.com/lima-vm/lima>)
- Lima `suppressFirstLoginSetup` commit — `c700cfd61f` (2026-07-24)
- nix-darwin 26.05 — `modules/users/user.nix`, `modules/services/openssh.nix`
  (<https://github.com/LnL7/nix-darwin/tree/nix-darwin-26.05>)
- Nix distributed builds / SSH store —
  <https://nix.dev/manual/nix/2.34/advanced-topics/distributed-builds>,
  <https://nix.dev/manual/nix/2.34/store/types/ssh-store>
- sops-nix — <https://github.com/Mic92/sops-nix>
- Removed `shopify-remote-builder` spec (git history, commit `d4bc402^`)
