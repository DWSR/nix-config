# Implementation Plan

> **Two-phase landing** (design "Credential-first bootstrap"): Tasks 1.1-1.4 land the
> credential plumbing first. The guest evaluates a flake before activation, so the switch
> that first references `inputs.rex` cannot yet read the root-only netrc that the same
> switch would create. Task 2.1 adds the Rex input only after Task 1.4 verifies the
> rendered netrc on the guest.
>
> **Operator-gated tasks**: 1.2 (1Password sync and vault edit), 1.4 and Task 5 (deploy to
> the running Lima VM, real Rex client, guest shell) need interactive credentials and a
> guest; they cannot be executed agent-side. They are listed because the design's
> migration and runtime-verification sections require them.

- [ ] 1. Credential path through the guest sops store (Phase A)

- [x] 1.1 (P) Declare the Rex package credential, netrc template, and Nix netrc setting
  - Add `sops.secrets."rex-package-token" = { }` beside the existing guest secrets in `configurations/fabro-vm/default.nix`
  - Add `sops.templates."rex-netrc"` with `mode = "0400"`, `restartUnits = [ "nix-daemon.service" ]`, and one stanza: `machine pkgs.superlogical.com login rex password ${config.sops.placeholder."rex-package-token"}`
  - Set `nix.settings."netrc-file" = config.sops.templates."rex-netrc".path`; do not use `nix.settings.access-tokens` and do not add a second credential source
  - Add `"rex-package-token" = "op://Private/Rex/Package Token";` to `fabro.onePasswordSecrets` so the existing sync helper seeds and rotates it
  - Completed when the guest evaluation shows the secret declared, the template at mode `0400` outside the Nix store, and `netrc-file` equal to that template path
  - _Requirements: 2.1, 2.2, 2.4, 2.5_
  - _Boundary: configurations/fabro-vm/default.nix_

- [ ] 1.2 Seed the encrypted store and document the credential
  - Create the Rex package token in 1Password, run `nix run '.#fabro-sync-from-1password'`, and commit the re-encrypted `secrets/fabro.fabro.yaml`
  - Add the `rex-package-token` row, its 1Password source, and the HTTP 401 failure symptom to the Fabro host store section of `secrets/README.md`, with the rotate-then-switch ordering
  - Do not revoke any prior token in this task
  - Completed when `sops -d secrets/fabro.fabro.yaml` lists `rex-package-token` and the README documents its source, rotation, and failure symptom
  - _Requirements: 2.1, 2.5, 2.6_
  - _Depends: 1.1_

- [ ] 1.3 (P) Run the guest `nixos-rebuild` as root in `lima-vm-deploy`
  - Change the deploy command in `home-manager/common/lima-vm.nix` from `nixos-rebuild switch --sudo --flake '$scratch#$system'` to `sudo /run/current-system/sw/bin/nixos-rebuild switch --flake '$scratch#$system'`
  - Keep the tree streaming, ssh config, scratch dir, and system argument unchanged; `--sudo` escalates activation only, so it cannot make the root-only netrc readable during evaluation
  - Completed when the rendered deploy command runs the whole rebuild under sudo with the absolute `nixos-rebuild` path and no `--sudo` flag remains
  - _Requirements: 2.2, 2.3_
  - _Boundary: home-manager/common/lima-vm.nix_

- [ ] 1.4 Deploy Phase A and verify the rendered credential on the guest
  - Switch the Mac's home-manager so the new deploy command is in place, then run `lima-vm-deploy`
  - On the guest confirm `stat -c '%a %U' /run/secrets/rendered/rex-netrc` reports `400 root` and `nix config show netrc-file` names the same path
  - Confirm the switch performs no Rex fetch (the input does not exist yet) and that the netrc holds exactly one `pkgs.superlogical.com` stanza
  - Completed when the root-only netrc and the guest netrc setting are verified on the running guest
  - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - _Depends: 1.1, 1.2, 1.3_

- [ ] 2. Rex flake input

- [ ] 2.1 Add and lock the Rex flake input, and thread it into the guest
  - Declare `rex = { url = "https://pkgs.superlogical.com/rex/nix/preview.tar.gz"; }` beside the other inputs in `flake.nix`, with a comment naming the `preview` channel, `nix flake update rex` as the bump path, and the package-token requirement
  - Run `nix flake lock` on the Mac so `flake.lock` records the tarball URL and `narHash`; the Mac fetch uses the operator's local Nix credential configuration, not the guest's secret
  - Add `rex = inputs.rex;` to the `nixosConfigurations.fabro-vm` `specialArgs` block, not to the top-level module list
  - Add no `follows` override, alternate URL, mirror, vendored binary, overlay, or fallback input for Rex
  - Completed when `nix flake metadata --json | jq '.locks.nodes.rex'` shows the preview tarball with a non-empty `narHash` and the guest evaluation still succeeds
  - _Requirements: 1.1, 1.4, 2.7_
  - _Depends: 1.4_

- [ ] 3. Rex guest module

- [ ] 3.1 Add the Rex guest module and import it
  - Create `configurations/fabro-vm/rex.nix` importing `rex.nixosModules.default` with `operatorPrincipal = "tailscale:brandonmcnama@outlook.com"`, `services.rex.loginServer.enable = true`, `accounts.brandonmcnama.principals = [ operatorPrincipal ]`, and `defaults.${operatorPrincipal} = "brandonmcnama"`
  - Keep `services.rex.enable = false`, `services.rex.tailscale.enable = false`, and `services.rex.loginServer.tailscaleServe.enable = false`; leave both `allowAnonymous` options unset
  - Declare no `users.users.*`, no `"*"` account, and no root or system-account entry; do not touch `configurations/fabro-vm/tailscale.nix` or the existing `svc:*` Serve oneshot
  - Import `./rex.nix` from `configurations/fabro-vm/default.nix` and add the header comment naming the endpoint shape, the `http://<account>@<host>:7297` selection form, that the endpoint name comes from `tailscale status`, and that the accounts file is module-rendered
  - Completed when the guest evaluation shows the login server enabled with the single account mapping, Rex in `environment.systemPackages`, and no shared-server mode
  - _Requirements: 1.2, 1.3, 3.1, 3.4, 4.1, 4.2, 4.3, 4.8, 5.6, 7.3, 7.4_
  - _Depends: 2.1_

- [ ] 3.2 Override the login-server command line with the tailnet listener
  - Build the argument list once in a `let` from `lib.getExe config.services.rex.package` and `lib.escapeShellArgs`: `--listen unix:///run/rex/login-server.sock`, `--accounts /etc/rex/accounts.jsonc`, `--runtime-root /run/rex`, `--log-format text`, `--pam-service rex-login-server`, plus exactly one `--extra-listen tailnet://:7297`
  - Assign it to `systemd.services.rex-login-server.serviceConfig.ExecStart` with `lib.mkForce` (a non-oneshot unit accepts one start command; the substitution must not add a second process)
  - Add `tailscaled.service` and `tailscaled-autoconnect.service` to `after`, `tailscaled-autoconnect.service` to `wants`, and `Restart`/`RestartSec` defaults of `on-failure` and `5`; leave the module's unit name, root identity, sockets, PAM argument, and reload behavior untouched
  - Confirm the package option name and the rendered `ExecStart` shape against the pinned input's `nixos-module.nix`; upstream documents no tailnet-address option
  - Completed when the evaluated unit has one `ExecStart` carrying all six arguments and no `tailnet-serve://`, `--tailscale`, anonymous flag, `--pam=false`, or second listener
  - _Requirements: 3.2, 3.3, 5.1, 5.2, 5.4, 5.5, 5.7, 6.2, 6.3, 6.4, 7.1_
  - _Depends: 3.1_

- [ ] 3.3 Open TCP 7297 on the tailscale interface only
  - Add `networking.firewall.interfaces.${config.services.tailscale.interfaceName}.allowedTCPPorts = [ 7297 ];` in `rex.nix`, referencing the interface-name option rather than a literal
  - Add no global `allowedTCPPorts` entry, no trusted interface, and no change to `services.tailscale.openFirewall` (it opens UDP 41641 only)
  - Completed when the evaluated firewall allows TCP 7297 on the tailscale interface and on no other interface
  - _Requirements: 5.3_
  - _Depends: 3.1_

- [ ] 4. Evaluated verification

- [ ] 4.1 Assert the pinned input and the installed package
  - Extend the `fabro-vm-guest-eval` chain in `flake.nix` with assertions over `builtins.fromJSON (builtins.readFile ./flake.lock)`: the `rex` node is the `pkgs.superlogical.com/rex/nix/preview.tar.gz` tarball with a non-empty `narHash`
  - Assert the upstream module is imported and the Rex package is present in `environment.systemPackages` using the existing `(p.pname or p.name or "") == "rex"` predicate shape
  - Reuse the lock file as the single source of truth; do not repeat the URL as a second literal
  - Completed when a floating or alternate Rex source fails `nix flake check` with a `fabro-vm:` message and the intended configuration passes
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 8.6_
  - _Depends: 2.1, 3.1_

- [ ] 4.2 Assert the login server, accounts, listener, firewall, and exclusions
  - Assert `rex-login-server` is enabled and wanted by `multi-user.target`, runs as root, is not a `DynamicUser`, and has an effective `Restart` in `{ on-failure, always }`
  - Normalize the unit's `ExecStart` (list or string) with a small helper, then assert the five module arguments plus exactly one `--extra-listen tailnet://:7297` and the absence of `tailnet-serve://`, `--tailscale`, anonymous flags, `--pam=false`, and any other listener
  - Assert the accounts map has exactly `brandonmcnama` with `tailscale:brandonmcnama@outlook.com`, the matching `defaults` entry, no `root` or `"*"` account, no `users.users.brandonmcnama`, and that the existing `fabro-lima-user-manager` assertions still pass
  - Assert the firewall rule allows TCP 7297 on `services.tailscale.interfaceName`, and that the existing `svc:fabro`/`svc:litellm`/`svc:opencode` Serve assertion still passes unchanged
  - Completed when each drift direction (new Serve, tsnet, anonymous access, root, wildcard, second listener, wider firewall) fails `nix flake check` with a named `fabro-vm:` message and the intended configuration passes
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5_
  - _Depends: 3.1, 3.2, 3.3_

- [ ] 4.3 Assert the credential wiring and the root deploy invocation
  - Assert `rex-package-token` is declared, the `rex-netrc` template references its placeholder, its mode is `0400`, its path is outside the Nix store, and its `restartUnits` include `nix-daemon.service`
  - Assert `nix.settings."netrc-file"` equals that template path and that `fabro.onePasswordSecrets` carries the matching entry; assert no rendered configuration carries a literal token
  - Assert the tracked `home-manager/common/lima-vm.nix` source contains `sudo /run/current-system/sw/bin/nixos-rebuild`, so the guest evaluation that reads the root-only netrc runs as root
  - Completed when removing the secret, the manifest entry, the netrc setting, or the root deploy invocation each fails `nix flake check` with a `fabro-vm:` message
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.7_
  - _Depends: 1.1, 1.3_

- [ ] 4.4 Update the guest report and confirm pure evaluation
  - Extend the `guestReport` string so the check output names the Rex service, the tailnet listener, the account, the credential path, and the firewall
  - Keep the check pure evaluation plus the trivial `runCommand`: no guest build, no `aarch64-linux` derivation, no network use beyond the flake fetch `nix flake check` already performs
  - Run `nix flake check` (or the `checks.<system>.fabro-vm-guest-eval` output) on the Mac, which authenticates with the operator's local Nix credential configuration
  - Completed when the check passes on the Mac without a Linux builder and its output text names the Rex service, listener, account, credential, and firewall
  - _Requirements: 2.7, 8.8_
  - _Depends: 4.1, 4.2, 4.3_

- [ ] 5. Guest runtime verification (after the checks pass)

- [ ] 5.1 (P) Verify boot, listener, firewall, and client endpoint on the guest
  - Switch the guest to Phase B and confirm `systemctl status rex-login-server` reports active and enabled, with `journalctl -u rex-login-server` showing the tailnet listener and no bind error
  - Confirm `ss -ltnp | grep 7297` shows the listener on the tailnet address only and that inbound TCP 7297 arrives over the tailnet interface
  - From the Mac, connect with `rex -S http://<node>.<tailnet>.ts.net:7297 ls`, using the node name from `tailscale status`
  - Confirm a failed bind (tailnet address absent or port taken) leaves the unit failed with the bind error in the journal
  - Completed when service state, listener socket, firewall reachability, and the client connection are all observed as described
  - _Requirements: 3.1, 5.1, 5.3, 5.7_
  - _Boundary: Guest runtime — service, listener, and endpoint_
  - _Depends: 4.4_

- [ ] 5.2 (P) Verify account mapping, refusals, PAM, and session continuity
  - Confirm `rex -S http://brandonmcnama@<node>.<tailnet>.ts.net:7297 ls` selects the account explicitly, while an unmapped principal and a tagged device are refused
  - Start a session, restart `rex-login-server`, and reconnect: the same account server and the same session are reused
  - Temporarily remove the principal from the accounts map, switch, and confirm allowed connections survive, removed access is closed, and the account server keeps running; restore and confirm re-allow
  - Confirm the session opens through the login PAM policy under the cidata user manager, with `journalctl --user -u rex` showing the account server
  - Completed when each observation matches, with the refusal and reload outcomes recorded from the journals
  - _Requirements: 4.4, 4.5, 4.6, 4.7, 5.2, 5.4, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5_
  - _Boundary: Guest runtime — accounts, PAM, and sessions_
  - _Depends: 4.4_

- [ ] 5.3 Verify credential rotation and the fail-closed path
  - Rotate the token in 1Password, run `fabro-sync-from-1password`, commit the store, and switch the guest; confirm `nix-daemon.service` restarted and that a later guest fetch (for example `nix flake update rex`) succeeds with the rotated value and no manual file edit
  - Confirm no fallback exists: an empty `rex-package-token` renders an empty netrc password and the fetch returns HTTP 401, and a missing store key fails sops activation before the netrc is updated
  - Restore the valid value and re-verify the netrc mode and stanza
  - Completed when the rotation cycle and both failure paths are observed as described
  - _Requirements: 2.4, 2.6_
  - _Depends: 5.1_

- [ ]* 5.4 Verify per-account isolation with a second mapped account
  - Deferred: a second account needs its own Linux account plus linger/user-manager wiring, which is account-lifecycle work outside this spec; the upstream per-account server model already provides the isolation
  - When such an account exists, map it in the accounts map and confirm each account gets its own Rex server and its own sessions
  - Completed when two mapped accounts show separate servers and separate session lists
  - _Requirements: 6.5_
  - _Depends: 5.2_
