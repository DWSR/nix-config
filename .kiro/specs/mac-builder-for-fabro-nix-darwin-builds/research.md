# Research Notes: mac-builder-for-fabro-nix-darwin-builds

Facts the design depends on, with the source that was read. Versions are the
ones this repository pins (`flake.lock`): nixpkgs `36fd15bbb657`, nix-darwin
`4459544d8296`, sops-nix `a1438ca361b0`. The evaluated hosts run Nix 2.34.9
(guest) and 2.34.9+1 (builder); the authoring sandbox runs 2.34.8.

## Nix distributed builds

- `nix.buildMachines` is a NixOS module option
  (`nixos/modules/config/nix-remote-build.nix`) whose entries render one line of
  `/etc/nix/machines`: `[protocol://][user@]host system sshKeyOr- maxJobs
  speedFactor features mandatoryFeatures publicHostKeyOr-`. There is no port
  field. Source: nixpkgs `nixos/modules/config/nix-remote-build.nix`,
  `buildMachinesText`.
- `publicHostKey` is described as "the (base64-encoded) public host key of this
  builder … calculated via `base64 -w0 /etc/ssh/ssh_host_type_key.pub`"; when it
  is null, SSH falls back to its regular known-hosts file. It is a *value*, not
  a file path, in the generated machines line. Source: same file, option
  description.
- When `nix.distributedBuilds = false`, the module sets `nix.settings.builders =
  null`, which disables `/etc/nix/machines` entirely; `distributedBuilds = true`
  is therefore a precondition for consulting any machines file.
- Nix's `builders` setting accepts a file reference prefixed with `@`
  (`nix config show` on Nix 2.34.8 reports the default
  `builders = @/etc/nix/machines`). A different file can be selected without the
  `nix.buildMachines` option, so the machines file may live outside the store.
- `nix.conf` is parsed when the daemon starts: changing the machines file
  requires restarting `nix-daemon.service` for the daemon to pick it up.

## nix-darwin (pinned rev)

- `services.tailscale` exposes only `enable`, `package`, `overrideLocalDns`
  (option list read from the evaluated `darwinConfigurations.mac-builder`). There
  is no auth-key option and no tag option. Enabling it installs
  `pkgs.tailscale` and a LaunchDaemon labelled `com.tailscale.tailscaled`
  (`modules/services/tailscale.nix`).
- `services.openssh.enable` drives Apple's built-in sshd, and
  `services.openssh.hostKeys` generates any missing host key with `ssh-keygen`
  at activation (`keygenScript` skips a non-empty existing file). A host key
  installed from a secret would race that keygen step, so the design keeps
  macOS-generated host keys and pins the public half instead.
- `nix.settings` defaults on this host evaluate to `sandbox = false`,
  `build-users-group = nixbld`, `trusted-users = [ "nix-builder" "root" ]`.
  Remote builds therefore run unsandboxed as `nixbld`, and a derivation whose
  builder is an absolute system path (`/bin/sh`) is buildable.
- `launchd.daemons.<name>` accepts `command`, `path`, `environment`, and a
  `serviceConfig` that is rendered verbatim into the plist
  (`modules/launchd/default.nix`).

## sops-nix (pinned rev)

- `sops.secrets.<name>` has `path` (default `/run/secrets/<name>`), `mode`,
  `owner`, `group`, `restartUnits`, `reloadUnits`
  (`modules/sops/default.nix`). `restartUnits` is honoured by the systemd
  installer path; the darwin installer materialises files during activation and
  has no systemd to restart.
- On NixOS the secrets are installed by `sops-install-secrets.service`, ordered
  before `sysinit.target`, so units that need `/run/secrets` can order after it.

## Tailscale

- OAuth client registration: the client secret is passed as `--auth-key`; the
  documented form appends parameters
  (`--auth-key="${OAUTH_CLIENT_SECRET}?ephemeral=false&preauthorized=true"`).
  OAuth-registered nodes are **ephemeral by default**, tag-owned, and the client
  must have the `auth_keys` scope with the tag assigned; `--advertise-tags` must
  name one of those tags. Source: tailscale.com/kb/1215/oauth-clients.
- `tailscale up --auth-key` accepts a `file:` prefix ("if it begins with file:,
  then it's a path to a file containing the auth key"), but parameters can only
  be appended to the key string, and `--hostname` is the documented way to force
  the MagicDNS machine name. `--accept-dns` defaults to accepting DNS
  configuration. Source: tailscale.com/kb/1241/tailscale-up.
- MagicDNS FQDNs are `<machine-name>.<tailnet-dns-name>.ts.net`; this repository's
  tailnet DNS name is `tuxedo-musical.ts.net` (service URLs in
  `configurations/fabro-vm/tailscale.nix`). Source: tailscale.com/kb/1081/magicdns.
- Backend states used by the nixpkgs autoconnect loop are
  `NeedsLogin`, `NeedsMachineAuth`, `Stopped`, and `Running`
  (nixpkgs `nixos/modules/services/networking/tailscale.nix`).

## Public caches

- `cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=` is the
  current nixpkgs default trusted key (evaluated `mac-builder` config).
- `nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=` is
  the key this repository already pins for the nix-community upstream cache
  (`tests/local-binary-cache/system-render.test.js`).

## Conclusions forced by these facts

- The machines file is rendered at runtime from the fabro store and selected with
  `nix.settings.builders = "@<path>"`; the declarative `nix.buildMachines` option
  cannot carry a host key that only exists after the builder boots.
- The builder needs its own launchd authentication wrapper because nix-darwin
  exposes no auth-key option, and the wrapper must keep polling so a logged-out
  node re-registers without an operator.
- The Build Client Key stays the session authenticator; the tailnet ACL is
  reachability only, because sshd and the Nix daemon both authenticate/authorise
  on their own terms regardless of node identity.
