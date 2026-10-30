# Research: install-rex-in-fabro-vm

External findings and repository facts behind `design.md`. Online sources were
read on 2026-10-30.

## Sources

| Ref | Source | Used for |
|-----|--------|----------|
| R1 | <https://www.superlogical.com/rex/docs/linux/installation> (2026-10-30) | Beta status, channels, flake URL, netrc requirement, architecture, NixOS module modes |
| R2 | <https://www.superlogical.com/rex/docs/linux/login-server> (2026-10-30) | Login-server behavior, accounts schema, principals, defaults, account selection, PAM, reload, session survival |
| R3 | <https://www.superlogical.com/rex/docs/linux/remote-access> (2026-10-30) | Listener matrix, tailnet-address listener, tagged-device Serve limitation, built-in Tailscale, NixOS listener options |
| R4 | sops-nix `modules/sops/default.nix` and `modules/sops/templates/default.nix` at rev `a1438ca` (the locked input) | `sops.secrets`, `sops.templates`, placeholder, mode, `restartUnits`, default paths |
| R5 | `nix config show netrc-file` on Nix 2.34.8 (2026-10-30) | `netrc-file` default is `/etc/nix/netrc` |
| R6 | nixpkgs `nixos/modules/services/system/nix-daemon.nix` and `nixos/modules/services/networking/tailscale.nix` (the locked `nixpkgs-26.05` rev) | Daemon restart on `nix.conf` change; `services.tailscale.interfaceName`; `openFirewall` opens only UDP |
| R7 | `curl https://pkgs.superlogical.com/rex/nix/preview.tar.gz` (2026-10-30) | Unauthenticated fetch returns HTTP 401 |
| R8 | `secrets/README.md`, `scripts/fabro-sync-from-1password.nix`, `configurations/fabro-vm/default.nix` | Guest sops store, sync helper ordering, secret declaration convention |
| R9 | nixpkgs `nixos-rebuild-ng` man page `--sudo` and `src/nixos_rebuild` (2026-10-30) | `--sudo` prefixes activation commands only; build, evaluation, and flake fetch run as the invoking user |

## Rex release and flake facts

- Rex on Linux is in testing and tester-gated; install commands appear only
  after login (R1).
- Channels: `stable` (no tagged release yet), `preview` (tagged previews of the
  next release), `snapshot` (frequent, likely unstable) (R1).
- One flake per channel at
  `https://pkgs.superlogical.com/rex/nix/<channel>.tar.gz`. It packages the
  release binary, not source, for x86-64 and ARM64 Linux (R1).
- The channel URL always serves the newest release on that channel; `flake.lock`
  records the exact release and `nix flake update rex` moves it (R1).
- Nix from nixos.org and NixOS read `/etc/nix/netrc` for the package token;
  Determinate Nix ignores that file and uses its own merged netrc (R1). Both
  hosts in this repo run nixos.org Nix (brief constraints).
- The documented install script authenticates the same host with HTTP basic
  auth as `rex:<token>` (`curl -fsSL -u "rex:$REX_PACKAGE_TOKEN" …`) (R1). The
  netrc line therefore uses `machine pkgs.superlogical.com`, `login rex`,
  `password <token>`. The first authenticated fetch during implementation is the
  check on that inference.
- The flake exports `nixosModules.default`, which runs Rex as a systemd service
  in one of two mutually exclusive modes: the shared server
  (`services.rex.enable`, runs as the `rex` account) or the login server
  (`services.rex.loginServer.enable`, runs as root and starts a server per
  account). Either mode installs Rex for every user (R1).

## Login server facts

- The unit is `rex-login-server.service`; it runs as root and starts one server
  per account as that account (R1, R2).
- `/etc/rex/accounts.jsonc` is JSON with comments and trailing commas. Top-level
  keys: `version` (1), `accounts`, `defaults` (R2).
- `accounts.<name>.principals` lists the callers allowed to use the account.
  Principal forms: `tailscale:alice@example.com` (person), `tailscale:tag:ci`
  (tagged device), `tailscale:*` (any person), `tailscale:tag:*` (any tagged
  device), `peer:<uid>` (local user), `identified`, `anonymous` (R2).
- A tagged device never matches a person's login or `tailscale:*` (R2, R3).
- The special account `"*"` lets its callers use any regular account (uid >=
  1000); root and system accounts must always be listed by name (R2).
- `defaults` maps a principal to an account used when the caller names none. A
  default only selects an account; the caller must still be allowed to use it.
  Most-specific match wins; ties follow file order. With no matching default, a
  caller allowed exactly one account gets it; otherwise the caller must name one
  (R2).
- A specific account is chosen by putting it before the host in an
  `http://`/`https://` address, e.g. `http://alice@host:7297`. Accounts can only
  be chosen through a network listener (R2).
- Each account's server survives a login-server stop, restart, or upgrade.
  Account servers keep their old version until their sessions end (R2).
- Reloading after an accounts change does not drop still-allowed connections; it
  closes connections whose access was removed and leaves account servers
  running (R2).
- The login server opens each login through PAM (`--pam-service
  rex-login-server`), which decides whether the account may log in and sets up
  limits, environment, and a systemd-logind session (R2).
- Documented command line: `rex login-server --listen
  unix:///run/rex/login-server.sock --accounts /etc/rex/accounts.jsonc
  --runtime-root /run/rex --log-format text --pam-service rex-login-server`
  (R2, R3).

## Remote access facts

Listener matrix (R3):

| Listener | Needs | Works with | Identifies callers |
|----------|-------|------------|--------------------|
| Built-in Tailscale (`--tailscale`, tsnet) | A Tailscale account | Personal and shared server | Yes |
| Tailscale Serve (`tailnet-serve://`) | Tailscale on the machine | Shared and login server | Yes, except tagged devices |
| Tailnet address (`tailnet://:PORT`) | Tailscale on the machine | Shared and login server | Yes |
| Plain HTTP (`--allow-anonymous`) | — | Every mode | No |

- The tailnet-address listener is `--extra-listen tailnet://:7297`; the port is
  required, the connection is plain HTTP encrypted by Tailscale, and clients use
  `http://<node>.<tailnet>.ts.net:7297` (R3).
- Tailscale Serve does not tell Rex who a tagged device is, so tagged devices
  cannot connect through Serve; use a tailnet address instead (R3). This guest
  is a tag-owned `tag:fabro` node, so Serve cannot carry the intended clients.
- The login server admits everyone Tailscale can identify; the accounts file
  decides which account each caller gets (R3).
- The NixOS module documents `services.rex.tailscale.enable`,
  `services.rex.tailscaleServe.enable`,
  `services.rex.loginServer.tailscaleServe.enable`,
  `services.rex.allowAnonymous`, and
  `services.rex.loginServer.allowAnonymous`, plus
  `services.rex.loginServer.accounts` and `.defaults`. It documents no
  tailnet-address option for the login server (R3), so the listener flag is
  added to the module-owned unit.
- The module writes the accounts file from the accounts/defaults options; it does
  not create Linux accounts (R2).

## Nix, sops-nix, and credential facts

- Rex tarball fetch without a token returns HTTP 401; there is no anonymous or
  alternative mirror (R7).
- Nix's `netrc-file` setting defaults to `$NIX_CONF_DIR/netrc`
  (`/etc/nix/netrc` on NixOS and the standard nixos.org install) and is the
  documented place for HTTP(S) credentials used by flake fetches (R5).
- `nix.settings` renders `/etc/nix/nix.conf`; the NixOS daemon unit has
  `restartTriggers = [ config.environment.etc."nix/nix.conf".source ]`, so a
  changed `netrc-file` restarts the daemon on activation (R6).
- sops-nix `sops.secrets.<name>` defaults to `/run/secrets/<name>`, mode `0400`,
  uid/gid 0 (R4).
- sops-nix `sops.templates.<name>` defaults to path
  `/run/secrets/rendered/<name>`, mode `0400`, uid/gid 0; it supports
  `restartUnits` and renders `${config.sops.placeholder.<name>}` into the
  decrypted value at activation (R4). The placeholder is a fixed token, so the
  template file in the Nix store never contains the credential.
- `fabro-sync-from-1password` reads `fabro.onePasswordSecrets` from the guest
  configuration, reads each URI with `op`, re-encrypts
  `secrets/fabro.fabro.yaml`, carries forward declared keys without a manifest
  URI, and aborts if a declared key would be dropped (R8). The README states the
  ordering rule: sync and commit the store before the switch that declares the
  secret (R8).
- The guest store's age key is `/var/lib/sops-nix/key.txt`; sops activation
  runs before normal units, so the rendered netrc exists before `nix-daemon`
  starts at boot (R8).
- `nixos-rebuild --sudo` only prefixes activation commands with sudo. The
  build, flake evaluation, and flake input fetch run as the invoking user (R9).
  `lima-vm-deploy` runs `nixos-rebuild switch --sudo` over SSH as the cidata
  user (`home-manager/common/lima-vm.nix:264`), so a `0400` root netrc would be
  unreadable by the fetch. The deploy must run the whole `nixos-rebuild` through
  sudo (an absolute `/run/current-system/sw/bin/nixos-rebuild` avoids sudo PATH
  surprises) for the root-only credential path to work.

## nixpkgs facts

- `services.tailscale.interfaceName` defaults to `tailscale0` (R6).
- `services.tailscale.openFirewall = true` adds only
  `networking.firewall.allowedUDPPorts = [ cfg.port ]` (default UDP 41641); it
  does not trust the interface or open TCP ports (R6). The tailnet listener
  therefore needs an explicit per-interface TCP rule.

## Repository facts

- `nixosConfigurations.fabro-vm` (`flake.nix:3106`) composes modules under
  `configurations/fabro-vm/`, evaluates on `aarch64-linux`, and threads external
  flakes through `specialArgs` (`flake.nix:3133`: `rsync34`,
  `nixSnapshotter`, `imageNixpkgs`, `limaVirtiofsTags`).
- `configurations/fabro-vm/default.nix` imports the guest service modules
  (lines 45-68), owns the `sops` block (lines 154-265) and `nix.settings`
  (line 367), sets `users.mutableUsers = true`, and never declares the cidata
  user. `fabro-lima-user-manager` enables linger, starts `user@<uid>.service`,
  and upholds `user@501.service`.
- `configurations/fabro-vm/tailscale.nix` registers the node with the sops OAuth
  secret, `--advertise-tags=tag:fabro`, `ephemeral = false`, `preauthorized =
  true`, and advertises `svc:fabro`, `svc:litellm`, and `svc:opencode` through
  the `tailscale-serve` oneshot.
- `fabro-vm-guest-eval` (`flake.nix:1985`) is a pure-eval assertion chain over
  `self.nixosConfigurations.fabro-vm.config` plus a trivial `runCommand`; it is
  the established verification mechanism and needs no Linux builder.
- `home-manager/common/lima-vm.nix:209` streams the working tree into the guest
  and runs `nixos-rebuild switch --sudo --flake <scratch>#fabro-vm` there; the Mac
  is not a Linux builder and the guest does its own evaluation and fetching. The
  `--sudo` flag does not escalate the evaluation or fetch (R9).
- The operator identity used by the guest's git/OpenCode configuration is
  `brandonmcnama@outlook.com` (`configurations/fabro-vm/opencode.nix:174`,
  `configurations/personal/home-manager/git.nix:3`).
- No Rex package, module, input, or service exists in the repo. The only Rex
  reference is the `REX_SESSION` guard at `home-manager/common/zsh.nix:123`.

## Decisions derived from this research

| Decision | Constraint |
|----------|------------|
| Pin the `preview` channel | `stable` has no tagged release; `snapshot` is explicitly unstable; `preview` is tagged and lockable. |
| Map `tailscale:brandonmcnama@outlook.com` to `brandonmcnama` | Repo git/OpenCode identity; one person principal, no wildcard or tagged-device match. |
| Deliver the credential as a sops template rendered to a root-only netrc, referenced by `nix.settings.netrc-file` | The guest must fetch the gated flake itself; the credential must come from sops, not a hand-placed file, and must not appear in the store. |
| Run the guest `nixos-rebuild` as root in `lima-vm-deploy` | The netrc is root-only, and `nixos-rebuild --sudo` does not escalate the evaluation or fetch (R9). |
| Deploy the credential plumbing before the Rex input | On the guest, flake evaluation precedes activation, so the first switch that references the input cannot yet read the netrc it will create. |
| Add `--extra-listen tailnet://:7297` by overriding the unit's `ExecStart` | The module has no tailnet-address option for the login server, and Serve cannot identify tagged devices. |
| Open TCP 7297 only on the tailscale interface | `services.tailscale.openFirewall` opens UDP 41641 only. |

## Risks and open items

- The published docs do not enumerate every upstream module option (for example
  the exact package option and the rendered `ExecStart` shape). The
  implementation must read the pinned input's `nixos-module.nix` when wiring the
  override; the eval checks pin every documented login-server argument so a
  shape change fails evaluation.
- The netrc `login rex` value is inferred from the documented install script's
  basic-auth user. If the first authenticated fetch rejects it, only the
  template's login field changes; the credential path and checks do not.
- Nix matches netrc credentials by host. If the tarball host redirects the
  download to another host, the credential is not forwarded; the first
  authenticated fetch verifies that `pkgs.superlogical.com` serves the archive
  directly.
- The guest's hostname is `fabro`, while the `svc:fabro` Tailscale Service also
  publishes a `fabro` name. Tailscale may report the node under a different
  MagicDNS name; the client endpoint is the node name from `tailscale status`,
  not a hardcoded hostname.
- A token rotation that invalidates the old token before the guest has the
  locked Rex input in its store leaves no credential for that switch's fetch.
  Rotate independently of channel bumps, or refresh the input before revoking
  the old token.
