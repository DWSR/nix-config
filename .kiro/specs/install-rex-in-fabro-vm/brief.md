# Brief: install-rex-in-fabro-vm

## Problem

> As a Rex user, I want Rex to be installed on the Fabro VM so that I can run
> terminal sessions using the Rex protocol rather than needing to use SSH so
> that I can avoid hosting applications like OpenCode which are basically just
> web-based terminals to enable mobile access.
>
> Requirements:
>
> * Rex must be installed using Nix Flakes
> * Rex should be installed as a login service for other users rather than
>   running purely as a dedicated user
> * Rex should be exposed using open source tailscale only, not the built-in
>   tailscale functionality

The operator uses Rex on the Mac and reaches Fabro's agent workloads from mobile by hosting OpenCode, a web terminal.
SSH offers no persistent, resumable sessions over flaky mobile links, and the VM has no Rex server to act as a remote host.

## Current State

- `nixosConfigurations.fabro-vm` (`flake.nix:3106`) composes the guest modules in
  `configurations/fabro-vm/`: fabro, litellm, opencode, api-bridge, sandbox, and tailscale.
  `lima-vm-deploy` (`home-manager/common/lima-vm.nix:214`) streams the tree into the running Lima
  instance and lets the guest's own Nix run `nixos-rebuild switch`; the Mac is not a Linux builder.
- `configurations/fabro-vm/tailscale.nix` joins the tailnet with OAuth credentials as a tag-owned
  node (`tag:fabro`) and advertises `svc:fabro`, `svc:litellm`, and `svc:opencode` through a
  `tailscale serve --service=...` oneshot. The node's own tailnet address is unused.
- No Rex package, module, flake input, or service exists in the repo. The only Rex reference is
  the `REX_SESSION` guard at `home-manager/common/zsh.nix:123`, which disables zellij
  auto-attach inside Rex sessions.
- The guest boots the pinned nixos-lima v0.2.2 release image; config changes ride
  `nixos-rebuild`, not an image rebuild. Its interactive account is Lima's cidata user
  (UID 501, `brandonmcnama`), created imperatively by lima-init; `users.mutableUsers` stays
  true and modules must not declare the user.
- Upstream Rex ships one flake per channel
  (`https://pkgs.superlogical.com/rex/nix/<channel>.tar.gz`; stable, preview, snapshot) with
  `nixosModules.default`. The login server is `services.rex.loginServer`; remote access supports both
  a Serve socket (`tailnet-serve://`) and a direct tailnet-address listener (`--extra-listen tailnet://:7297`).

## Desired Outcome

- `nixos-rebuild switch` on the guest installs Rex from a `flake.lock`-pinned input and runs
  `rex-login-server.service` at boot.
- From Rex for Mac or the `rex` CLI, the operator connects to `http://<node>.<tailnet>.ts.net:7297`
  as their own Linux account and runs persistent sessions without SSH or a web terminal.
- Additional local accounts can be granted access declaratively; each gets its own Rex server, and
  sessions survive a login-server restart.
- Exposure uses the guest's open-source `tailscaled` tailnet-address listener only; `nix flake check`
  asserts the listener, accounts, and the absence of Serve and tsnet.

## Approach

Adopt upstream's flake and NixOS module instead of packaging Rex.

- Add a `rex` flake input from the pinned channel tarball; `flake.lock` pins the release and
  bumps are `nix flake update rex`.
- Add `configurations/fabro-vm/rex.nix`, imported from `configurations/fabro-vm/default.nix`,
  and thread `inputs.rex` through the fabro-vm `specialArgs` (`flake.nix:3133`).
- Enable `services.rex.loginServer` with an accounts map and `defaults`. The login server is the
  only mode that satisfies "login service for other users": shared-server mode runs one server
  as the dedicated `rex` account.
- Expose it through the tailnet-address listener: add `--extra-listen tailnet://:7297` to the
  module-owned `rex-login-server.service` command line, keeping the module's `--listen`,
  `--accounts`, `--runtime-root`, and `--pam-service` arguments. Leave
  `services.rex.loginServer.tailscaleServe.enable` off and `services.rex.tailscale.*` unset.
- Leave the existing `svc:*` Serve oneshot untouched; Rex uses the node's own tailnet address,
  not a new service name.
- Extend the `fabro-vm-guest-eval` assertion chain (`flake.nix:1985`).

Rejected: Tailscale Serve (`tailnet-serve://`) — the guest is a tag-owned node and Serve does not
authenticate tagged nodes, so the intended clients would be refused (PR #166 review); built-in
Tailscale (`--tailscale`, tsnet) — the issue requires the open-source tailscaled; shared-server
mode — one dedicated account; hand-packaging the release binary — drops upstream PAM,
accounts-file, and listener wiring, and the requirement names Nix Flakes.

## Scope

- **In**:
  - Rex flake input and lock pin, plus the package-token/netrc access path the gated flake
    requires on each evaluating host.
  - `configurations/fabro-vm/rex.nix`: login server, accounts map with the cidata user and its
    Tailscale principal(s), defaults, the `tailnet://:7297` listener, its unit wiring, the
    `tailscale0` firewall opening for TCP 7297, and header notes for the endpoint and account selection.
  - Import and `specialArgs` wiring, plus `fabro-vm-guest-eval` assertions for the Rex settings,
    the tailnet listener, and the built-in-Tailscale and Serve exclusions.
- **Out**:
  - Removing or reconfiguring OpenCode, or decommissioning any tailnet service.
  - Shared-server mode, home-manager personal servers, built-in Tailscale (`--tailscale`, tsnet),
    Serve exposure for Rex, and plain/anonymous listeners.
  - Tailnet ACL, Service, OAuth/tag, or admin-console changes, and new accounts; only existing
    accounts are mapped.
  - Rex client/app setup on macOS, Rex Lua customization, image rebuilds, and automatic channel
    upgrades.

## Boundary Candidates

- Flake dependency and credential path (input, lock, netrc/token plumbing).
- Guest module: login-server config, accounts/principals, tailnet-listener wiring (extra-listen
  flag, port, unit ordering), and the guest eval assertions or render tests under `tests/`.

## Out of Boundary

- Rex's shared server, agent/MCP features, Lua config, session recording, and resource-limit
  tuning beyond module defaults.
- PAM policy customization beyond the module's NixOS default, and account lifecycle (creating
  users, shells, passwords) outside mapping existing accounts.

## Upstream / Downstream

- **Upstream**: Rex flake and NixOS module (channel tarball and tester token), the guest's
  tag-owned `tailscaled` node and its tailnet DNS name, the nixos-lima v0.2.2 guest image,
  `lima-vm-deploy`, and sops-nix for any secret.
- **Downstream**: OpenCode removal from the tailnet if Rex covers mobile access; Rex personal
  servers on the Macs; Tailscale ACL tightening for the Rex endpoint; Rex agent workflows on the
  guest.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `personal-tailscale-service` (macOS Serve conventions; Rex on the guest does not
  use Serve), the in-tree fabro-vm `tailscale.nix`/`opencode.nix` service set, and the fabro-vm
  eval-check chain in `flake.nix`.

## Constraints

- Rex on Linux is beta, tester-gated (token in `/etc/nix/netrc`), and ARM64-only; the guest is
  `aarch64-linux` and Rex needs glibc 2.28+ plus systemd, all satisfied. Both the Mac
  (`nix flake check`) and the guest (`nixos-rebuild`) fetch the input, so the token cannot live only
  in the guest's sops store. Determinate Nix ignores that file; both hosts run nixos.org Nix.
- `users.mutableUsers` stays true and the cidata user stays undeclared; the login server
  references the runtime account by name.
- The guest is a tag-owned node (`tag:fabro`). Tailscale Serve does not identify tagged devices,
  which is why exposure uses the tailnet-address listener: it asks the node's own `tailscaled`
  who each caller is.
- The tailnet listener requires an explicit port (`7297`) and a `tailscale0` firewall opening, and
  speaks plain HTTP encrypted by Tailscale: clients use `http://<node>.<tailnet>.ts.net:7297`, and
  account selection needs an `http://`/`https://` URL with the account before the host.
- The login server has no passwords or keys: identity is the Tailscale principal
  (`tailscale:<login>`), and access is only as good as the tailnet ACL. Tagged devices match
  `tailscale:tag:*`, never a person's login. The accounts file is rendered from Nix; root and
  system accounts must be named explicitly, so the default map grants no root access.
- The upstream module documents Serve and anonymous options but no tailnet-listener option; the
  listener flag and port are added without disturbing the module's PAM, accounts, or unit
  lifecycle wiring.
- Sessions are per-account systemd-logind services; the guest's linger and `user@501` wiring
  (`fabro-lima-user-manager`) must keep working because the login server starts servers as that
  user.
