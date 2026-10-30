# Research: install-rex-in-fabro-vm

External findings and repository facts behind `design.md`. Dates are the access
date for online sources.

## Sources

| Ref | Source | Used for |
|-----|--------|----------|
| R1 | <https://www.superlogical.com/rex/docs/linux/installation> (2026-10-30) | Beta status, channels, flake URL, token/netrc, architecture, NixOS module modes |
| R2 | <https://www.superlogical.com/rex/docs/linux/login-server> (2026-10-30) | Login-server behavior, accounts file schema, principals, defaults, account selection, PAM, reload, persistence |
| R3 | <https://www.superlogical.com/rex/docs/linux/remote-access> (2026-10-30) | Listener matrix, tailnet-address listener, Serve/tagged-node limitation, built-in Tailscale, NixOS listener options |
| R4 | <https://www.superlogical.com/rex/docs/linux/server-modes> (2026-10-30) | Mode incompatibility, per-account server lifetime, reload effects |
| R5 | <https://nix.dev/manual/nix/latest/command-ref/conf-file#conf-netrc-file> (2026-10-30) | `netrc-file` default `$NIX_CONF_DIR/netrc` |
| R6 | `NixOS/nixpkgs` `nixos/modules/services/networking/tailscale.nix` (`nixos-26.05`, 2026-10-30) | `services.tailscale.openFirewall` only opens UDP 41641 |
| R7 | `curl https://pkgs.superlogical.com/rex/nix/snapshot.tar.gz` (2026-10-30) | Unauthenticated fetch returns HTTP 401 `Rex packages require a token` |

## Rex release and flake facts

- Rex on Linux is in testing and tester-gated: install commands are visible only
  after login. This is not a blocker for evaluation, but the flake tarball needs
  the package token (R1, R7).
- Channels: `stable` (no tagged release yet), `preview` (tagged previews of the
  next release), `snapshot` (frequent, likely unstable) (R1).
- One flake per channel at
  `https://pkgs.superlogical.com/rex/nix/<channel>.tar.gz`. It packages the
  release binary, not source, for x86-64 and ARM64 Linux (R1).
- The channel URL always serves the newest release on that channel; `flake.lock`
  records the exact release and `nix flake update rex` moves it (R1).
- Nix needs the token in a netrc file until the first release. Nix from nixos.org
  and NixOS read `/etc/nix/netrc`; Determinate Nix ignores it. Both hosts in this
  repo run nixos.org Nix per the brief (R1).
- The flake exports `nixosModules.default`, which runs Rex as a systemd service in
  one of two mutually exclusive modes: the shared server (`services.rex.enable`,
  runs as the `rex` account) or the login server
  (`services.rex.loginServer.enable`, runs as root and starts a server per
  account). Either mode installs Rex for every user (R1).

## Login server behavior

- `/etc/rex/accounts.jsonc` is JSON with comments and trailing commas allowed.
  Top-level keys: `version` (1), `accounts`, `defaults` (R2).
- `accounts.<name>.principals` lists the callers allowed to use the account.
  Principal forms: `tailscale:alice@example.com` (person), `tailscale:tag:ci`
  (tagged device), `tailscale:*` (any person), `tailscale:tag:*` (any tagged
  device), `peer:<uid>` (local user), `identified`, `anonymous` (R2).
- A tagged device never matches a person's login or `tailscale:*` (R2, R3).
- The special account `"*"` lets its callers use any regular account (uid >=
  1000); root and system accounts must always be listed by name. Anonymous
  callers can never use root (R2).
- `defaults` maps a principal to an account used when the caller names none. A
  default only selects an account; the caller must still be allowed to use it.
  Most-specific match wins; ties follow file order. With no matching default, a
  caller allowed exactly one account gets that account; otherwise the caller
  must name one (R2).
- A specific account is chosen by putting it before the host in an
  `http://`/`https://` address (e.g. `http://alice@host:7297`). Accounts can only
  be chosen through a network listener (R2).
- Each account's server survives a login-server stop, restart, or upgrade.
  Account servers keep their old version until their sessions end (R2, R4).
- Reloading after an accounts change does not drop still-allowed connections; it
  closes connections whose access was removed and leaves every account's server
  running (R2, R4).
- The login server opens each login through PAM (`--pam-service
  rex-login-server`), which decides whether the account may log in and sets up
  limits, environment, and a systemd-logind session. The Rex package installs
  `/etc/pam.d/rex-login-server` (R2).
- Default command line for the login server (packaged service, and the documented
  manual unit): `rex login-server --listen
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
  cannot connect through Serve. This is why the PR #166 review selected the
  tailnet address for this guest (R3; brief).
- The login server admits everyone Tailscale can identify; its accounts file
  decides which account each caller gets (R3).
- The NixOS module documents listener options
  `services.rex.tailscale.enable`, `services.rex.tailscaleServe.enable`,
  `services.rex.loginServer.tailscaleServe.enable`,
  `services.rex.allowAnonymous`, and
  `services.rex.loginServer.allowAnonymous`. It documents no tailnet-address
  option for the login server, so the listener flag must be added to the
  module-owned unit (R3; brief).
- The module writes the accounts file from `services.rex.loginServer.accounts`
  and `services.rex.loginServer.defaults`; `accountsFile` replaces the rendered
  file. The module does not create Linux accounts (R2).

## Nix facts

- `netrc-file` defaults to `$NIX_CONF_DIR/netrc` (`/etc/nix/netrc` on NixOS and
  the standard nixos.org install). The file is the documented place for HTTP(S)
  credentials used during flake fetches (R5).
- The Rex tarball returns HTTP 401 without the token; there is no anonymous or
  alternative mirror to fall back to (R7).

## nixpkgs facts

- `services.tailscale.openFirewall = true` adds only
  `networking.firewall.allowedUDPPorts = [ cfg.port ]` (default UDP 41641); it
  does not trust `tailscale0` or open TCP ports (R6). A tailnet listener on TCP
  7297 therefore needs an explicit firewall rule for the tailscale interface.

## Repository facts

- `nixosConfigurations.fabro-vm` (`flake.nix`) composes `configurations/fabro-vm/`
  modules, evaluates on `aarch64-linux`, and threads external flakes through
  `specialArgs` (`rsync34`, `nixSnapshotter`, `imageNixpkgs`,
  `limaVirtiofsTags`). The guest shares the flake's nixpkgs and overlays.
- `configurations/fabro-vm/default.nix` sets `networking.hostName = "fabro"`,
  `users.mutableUsers = true`, and does not declare the cidata user. The
  `fabro-lima-user-manager` oneshot enables linger for `brandonmcnama`, starts
  `user@<uid>.service`, and `Upholds` `user@501.service`.
- `configurations/fabro-vm/tailscale.nix` registers the node with the OAuth
  secret, `--advertise-tags=tag:fabro`, `ephemeral = false`, `preauthorized =
  true`, and runs the `tailscale-serve` oneshot for `svc:fabro`,
  `svc:litellm`, and `svc:opencode`.
- `fabro-vm-guest-eval` (`flake.nix`) is a pure-eval assertion chain over
  `self.nixosConfigurations.fabro-vm.config` plus a trivial `runCommand`. It is
  the established place for guest wiring checks and requires no Linux builder.
- Repo convention for Nix credentials is an out-of-band file rendered from
  1Password: `scripts/bootstrap-nix-github-token.sh` and
  `/etc/nix/nix.conf.d/github-access-token.conf`; `secrets/README.md` documents
  bootstrap, steady state, verification, and disable steps.
- No Rex package, module, input, or service exists in the repo today. The only
  Rex reference is the `REX_SESSION` guard in `home-manager/common/zsh.nix`.

## Decisions derived from this research

| Decision | Constraint |
|----------|------------|
| Pin the `preview` channel | `stable` has no tagged release yet; `snapshot` is explicitly unstable. `preview` is tagged and lockable. |
| Map `tailscale:brandonmcnama@outlook.com` to `brandonmcnama` | Operator confirmation; it is the repo's git identity. One principal, no wildcard. |
| Add `--extra-listen tailnet://:7297` by overriding the unit's `ExecStart` | The module has no tailnet-address option for the login server; Serve is unusable for tagged nodes. |
| Open TCP 7297 only on the tailscale interface | `services.tailscale.openFirewall` opens UDP 41641 only; the listener binds the tailnet address. |
| Keep the token in `/etc/nix/netrc`, out of sops and the Nix store | The credential is needed before the flake (and therefore sops activation) can evaluate. |

## Risks and open items

- The published documentation does not enumerate every upstream module option
  (for example the exact package option and the unit's rendered `ExecStart`
  shape). The implementation must read the pinned input's `nixos-module.nix`
  when wiring the override; the eval checks assert all four documented login
  server arguments so a shape change fails loudly.
- The guest's hostname is `fabro`, while the `svc:fabro` Tailscale Service also
  publishes `fabro.<tailnet>.ts.net`. Tailscale may report the node under a
  different MagicDNS name (`fabro-1`, for example). The client endpoint is the
  node name from `tailscale status`, not a hardcoded hostname.
- The Rex flake is tester-gated; a missing or rotated token fails every
  evaluation on both hosts until `/etc/nix/netrc` is repaired.
