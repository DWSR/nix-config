# Research: install-rex-in-fabro-vm (design stage)

Background only. The design decisions live in `design.md`; this file records what
was checked, what could not be reached, and the consequences for implementers.

## Upstream Rex artifacts

| Check | Result |
|-------|--------|
| `https://pkgs.superlogical.com/rex` | `200` — page reads "Rex Linux packages / Access requires a token from Superlogical." |
| `https://pkgs.superlogical.com/rex/nix/stable.tar.gz` (no credential) | `401` — the channel tarball is gated, matching the brief's tester-token constraint. |
| `https://docs.rex.sh/` | DNS does not resolve from this sandbox. |
| Public GitHub org/user `superlogical` repository listing | Empty; no public mirror of the NixOS module or its option declarations. |

Consequence: the flake URL, `nixosModules.default`, `services.rex.loginServer`,
`services.rex.loginServer.tailscaleServe.enable`, `services.rex.tailscale.*`, the
accounts/defaults shape, PAM default, and the `tailscale:<login>` principal form
are taken from the locked `brief.md` (which cites the Rex docs "Installing on
Linux", "Login Server", and "Remote Access"). The exact attribute name inside a
`services.rex.loginServer.accounts.<name>` entry could not be read here.

Consequence for implementation: that attribute name appears in exactly one place
in `configurations/fabro-vm/rex.nix` (the helper that turns the repo's
`account -> [principals]` map into module entries). The guest eval assertions are
written so they do not depend on it (they inspect the rendered account map as
data), so a rename upstream is a one-line fix, not a design change.

## Repository facts confirmed by reading the source

- `flake.nix:2` is the input block; `flake.nix:3082` is
  `nixosConfigurations.fabro-vm`; `flake.nix:3109` is its `specialArgs`
  (`rsync34`, `nixSnapshotter`, `imageNixpkgs`, `limaVirtiofsTags`).
- `flake.nix:1985` is `fabro-vm-guest-eval`, a `pkgs.runCommand` whose `guestReport`
  is a chain of `assert pkgs.lib.assertMsg ...` expressions over
  `self.nixosConfigurations.fabro-vm.config`; it evaluates on the Mac without a
  Linux builder.
- `flake.nix:342` is `checks = forAllSystems (...)`; there is no GitHub Actions
  `nix flake check`, so checks run on the operator's host.
- `configurations/fabro-vm/default.nix:45` imports the guest modules and
  `:344` defines `fabro-lima-user-manager` (linger + `user@501` +
  `Upholds`); `:335` keeps `users.mutableUsers = true`.
- `configurations/fabro-vm/tailscale.nix:59` registers the guest as
  `--advertise-tags=tag:fabro`; `:85` advertises `svc:fabro`, `svc:litellm`, and
  `svc:opencode` with `tailscale serve --service=... --https=443`.
- `home-manager/common/lima-vm.nix:209` (`limaVmDeploy`) streams the tree and runs
  `nixos-rebuild switch --sudo --flake ...` in the guest, so the guest's own Nix
  is what fetches the Rex input.
- Credential precedent: `scripts/bootstrap-nix-github-token.sh` seeds a
  user-owned `0600` token file for Nix before the config that reads it exists;
  `secrets/README.md` ("Nix GitHub access token") documents that flow. Nix's
  `access-tokens` setting is GitHub-oriented; the Rex tarball is a plain HTTPS
  host, which is what `netrc-file` (default `/etc/nix/netrc`) covers.

## Open items for the implementation stage

- The operator's tailnet login (`tailscale status` on the Mac) fills the single
  `tailscale:<login>` principal constant; the design deliberately does not
  hardcode it.
- The guest node's own tailnet DNS name is assigned at registration; the connect
  endpoint in the module header must be read from `tailscale status` on the guest
  after the first registration, not from the repo.
- The pinned module's account-entry attribute name, package option, and
  shared-server enable flag must be read from its option declarations when the
  input is first locked. The design keeps each in one place: the account helper,
  the package binding in `rex.nix`, and an assertion read with `or false`.
