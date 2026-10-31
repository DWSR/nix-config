# Research & Design Decisions

## Summary

- **Feature**: `mac-builder-for-fabro-nix-darwin-builds`
- **Discovery scope**: extension of two existing hosts (`nixosConfigurations.fabro-vm`,
  `darwinConfigurations.mac-builder`) plus one new runtime smoke check; no new service.
- **Key findings**:
  - nix-darwin's `services.tailscale` is a launchd `tailscaled` wrapper with only
    `enable`, `package`, and `overrideLocalDns`; it has no auth-key or `tailscale up`
    handling, so OAuth login must be driven by a separate launchd daemon.
  - `tailscale up --auth-key` accepts a `file:` prefix, so a key can be read without
    appearing in argv. OAuth-client registrations default to ephemeral nodes; the
    nixpkgs NixOS tailscale module appends `?ephemeral=false&preauthorized=true` to the
    key string to override that.
  - NixOS `nix.buildMachines` emits one `/etc/nix/machines` line per machine; `sshKey`
    is a *string path* that must not point into the Nix store, and `publicHostKey` is
    the base64-encoded public host key, which Nix pins through a private known-hosts
    file.
  - `nix.distributedBuilds = false` sets `nix.settings.builders = null`, so the daemon
    ignores `/etc/nix/machines`; the option must be enabled for dispatch to happen.
  - The NixOS `nix-daemon` unit already carries the SSH package and a CA bundle on its
    path/environment, so the root daemon can open `ssh-ng` connections without extra
    packaging.
  - nix-darwin does not implement `nix.settings.system-features`, so the builder
    advertises Nix's built-in feature set (`benchmark`, `big-parallel`, `nixos-test`).

## Research Log

### nix-darwin Tailscale module (pinned revision)

- **Context**: The builder must join the tailnet with the open-source client and an
  OAuth credential, and must survive reboots and lost membership without a login.
- **Sources consulted**: `LnL7/nix-darwin` at `4459544d8296fa2cca7168de1e54a6691ec48a17`
  (`flake.lock` records this as `nix-darwin-26.05`), file `modules/services/tailscale.nix`.
- **Findings**:
  - Options: `enable`, `package` (default `pkgs.tailscale`), `overrideLocalDns`.
  - Enabling creates `launchd.daemons.tailscaled` (`Label = com.tailscale.tailscaled`,
    `RunAtLoad = true`) running `tailscaled` with no flags, adds the package to
    `environment.systemPackages`, and writes `/etc/resolver/ts.net` pointing at
    `100.100.100.100` so MagicDNS works without changing the host's DNS servers.
  - There is no auth key, no `tailscale up`, no tag handling, and no re-auth timer.
- **Implications**: Membership = the nix-darwin daemon plus our own launchd daemon that
  runs `tailscale up` on boot and periodically; the tag must be passed on the command
  line because the module has no option for it.

### `tailscale up` auth-key forms and OAuth registration parameters

- **Context**: The OAuth client secret is used as the auth key; it must not leak into
  argv or the Nix store, and the node must not be ephemeral.
- **Sources consulted**:
  - <https://tailscale.com/docs/reference/tailscale-cli/up> (validated 2026-01-26):
    `--auth-key=<key>` — "if it begins with `file:`, then it's a path to a file
    containing the auth key"; `--advertise-tags`, `--hostname`, `--timeout`,
    `--reset`, `--force-reauth` exist; `--client-secret` also supports `file:`.
  - `NixOS/nixpkgs` `nixos-26.05`, `nixos/modules/services/networking/tailscale.nix`:
    the module builds `--auth-key "$(cat <keyFile>)<params>"` where `<params>` is
    `?ephemeral=false&preauthorized=true&…` from `authKeyParameters`, citing
    `tailscale.com/kb/1215` ("Register new nodes using OAuth credentials").
- **Findings**:
  - OAuth-credential registrations are ephemeral by default and tag-owned; the
    `?ephemeral=false&preauthorized=true` query string is the supported override.
  - `file:` is supported for the auth key itself, but query parameters must be part of
    the key string, not of the file path.
- **Implications**: The auth daemon materializes a root-only derived key file
  (secret value + `?ephemeral=false&preauthorized=true`) and passes
  `--auth-key=file:<derived>`; the derived file is removed after `tailscale up`. This
  keeps the secret out of argv (`ps` is world-readable on macOS) while preserving
  non-ephemeral, pre-approved registration.

### NixOS remote-build configuration (nixpkgs `nixos-26.05`)

- **Context**: The guest's daemon must dispatch only `aarch64-darwin` builds and keep
  Linux builds local.
- **Sources consulted**: `nixos/modules/config/nix-remote-build.nix`,
  `nixos/modules/config/nix.nix`, `nixos/modules/services/system/nix-daemon.nix`.
- **Findings**:
  - `nix.buildMachines.*` fields: `hostName`, `protocol` (`null|ssh|ssh-ng`),
    `system`/`systems`, `sshUser`, `sshKey` (`nullOr str` — the description states the
    path "must point to a file in the local filesystem, *not* to the nix store"),
    `maxJobs`, `speedFactor`, `supportedFeatures`, `mandatoryFeatures`,
    `publicHostKey` ("base64-encoded public host key … `base64 -w0
    /etc/ssh/ssh_host_type_key.pub`").
  - `/etc/nix/machines` line order: `<url> <system> <sshKey> <maxJobs>
    <speedFactor> <features> <mandatoryFeatures> [<publicHostKey>]`.
  - `nix.distributedBuilds = false` ⇒ `nix.settings.builders = null` (the file is still
    generated; the daemon just ignores it). Enabled ⇒ default `builders` behaviour
    reads `/etc/nix/machines`.
  - `nix-daemon.service` has `path = [ nixPackage config.programs.ssh.package … ]` and
    `environment.CURL_CA_BUNDLE = config.security.pki.caBundle`, so the root daemon can
    run `ssh` and fetch over TLS without extra packages.
- **Implications**: One machine entry with `system = "aarch64-darwin"` and `systems`
  left empty keeps `aarch64-linux` local by construction; `sshKey` carries the runtime
  path string, so no key material enters the Nix store; `publicHostKey` gives pinning
  with a public value.

### Nix SSH host-key pinning behaviour

- **Context**: Requirement 6.4/6.5 demand that the guest verifies the builder host key
  and refuses a mismatch before dispatching.
- **Sources consulted**: `NixOS/nix` `2.33.3`, `src/libstore/ssh.cc` and
  `src/libstore/ssh-store.cc`.
- **Findings**: With a non-empty `base64-ssh-public-host-key`, Nix base64-decodes the
  value, writes `<host> <key>` into a private temporary file, and passes
  `-oUserKnownHostsFile=<file>` to every `ssh` invocation; a host that presents a
  different key fails verification, and Nix surfaces
  `failed to start SSH connection to '<host>'`.
- **Implications**: Host-key pinning is stock behaviour; the design only has to supply
  the value and a non-empty assertion.

### nix-darwin `nix` module (pinned revision)

- **Context**: What the builder side already declares, and what a cache/substituter
  policy has to override.
- **Sources consulted**: `modules/nix/default.nix` at the pinned revision;
  `configurations/mac-builder/default.nix` in this repository.
- **Findings**:
  - `nix.buildMachines` and `nix.distributedBuilds` exist and `environment.etc."nix/machines"`
    is generated with the same field order as NixOS.
  - `nix.settings.system-features` is commented out ("Not implemented yet"), so the
    builder daemon advertises Nix's built-in features.
  - Defaults: `substituters = mkAfter [ "https://cache.nixos.org/" ]`,
    `trusted-public-keys = [ "cache.nixos.org-1:…" ]`, `trusted-users = [ "root" ]`;
    `!distributedBuilds` adds `builders = null`.
  - `nix.settings.sandbox` defaults to `false` on nix-darwin.
- **Implications**: Declaring the public substituter set must use `mkForce` to avoid the
  default `cache.nixos.org` being merged in twice, and the checks can assert an exact
  list. The builder keeps `distributedBuilds` at its default (false): it is a builder,
  not a client.

### nix-darwin launchd services

- **Context**: The builder needs a periodic, login-free authentication daemon.
- **Sources consulted**: `modules/launchd/default.nix` at the pinned revision.
- **Findings**: `launchd.daemons.<name>` accepts `command`/`script`, `path`,
  `environment`, and a freeform `serviceConfig` rendered to the plist (`RunAtLoad`,
  `StartInterval`, `StandardOutPath`, `StandardErrorPath`, `ProcessType`, …).
  A `script` is written to the store and executed through
  `/bin/sh -c "/bin/wait4path /nix/store && exec <script>"`; `path` entries are
  appended to `PATH`.
- **Implications**: `RunAtLoad` + `StartInterval` gives boot-time and periodic
  reauthentication with no user session, and the daemon can be given the tailscale,
  jq, and coreutils binaries explicitly.

### macOS host-key capture

- **Context**: The pinned value must be captured reproducibly on the builder.
- **Sources**: macOS `base64(1)` (`-b num` line break count, `-i input`, `-o output`).
- **Findings**: `base64 -b 0 -i /etc/ssh/ssh_host_ed25519_key.pub` prints the whole
  public-key line as one base64 string, which is exactly the
  `base64-ssh-public-host-key` form Nix expects.
- **Implications**: The runbook records that command rather than a hand-wrapped blob.

## Risks and Open Questions

- MagicDNS resolution on the guest depends on the guest's tailscaled DNS handling
  (`--accept-dns`, default true) and on the NixOS module adding the resolvconf package
  to `tailscaled`'s path when `networking.resolvconf.enable` is on (NixOS default). The
  design addresses this by verifying resolution manually and by keeping the builder
  address as a configurable option, not by adding DNS configuration the guest does not
  own.
- The builder's tailnet tag must be authorized for the builder's OAuth client in the
  Tailscale console; the repository can only document that step.
- nix-darwin leaves `sandbox = false` on the builder, so remote builds run outside a
  Nix sandbox. This matches the existing builder host and is unchanged by this spec;
  the trust boundary stays the client key plus the tailnet ACL.
