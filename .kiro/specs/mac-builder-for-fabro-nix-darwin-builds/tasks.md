# Implementation Plan

- [ ] 1. Provision the tailnet registration and trust material

- [ ] 1.1 Create the builder OAuth client and authorize its tag
  - In the Tailscale console, add `tag:mac-builder` to `tagOwners` under an admin owner and create an OAuth client authorized to grant exactly that tag; keep MagicDNS enabled for the tailnet (the guest resolves `mac-builder.tuxedo-musical.ts.net`).
  - Store the client secret (`tskey-client-…`) in the 1Password item `Mac Builder Tailscale Credentials`; do not create a second credential for `tag:fabro`.
  - Done when the tag has an owner, the OAuth client is authorized for `tag:mac-builder` only, and the client secret reads back from the item.
  - _Requirements: 4.3, 4.4_

- [ ] 1.2 Generate the build client keypair and add its private half to the fabro store
  - Create a passphrase-free Ed25519 keypair for the guest daemon; store the private key in 1Password and add it to `secrets/fabro.fabro.yaml` as the `nix-builder-client-key` value, re-encrypted to `&host_fabro`.
  - Keep the public half (one line, `ssh-ed25519 …`) available for task 1.3; do not place either half in a Nix expression or the sandbox image.
  - Done when `sops -d secrets/fabro.fabro.yaml` yields `nix-builder-client-key` and the encrypted file lists only the `&host_fabro` recipient.
  - _Requirements: 6.1, 6.6, 6.7, 6.9_

- [ ] 1.3 Add the OAuth secret and the authorized client key to the builder store
  - Add `tailscale-oauth-secret` holding the client secret, and append the `nix-builder-client-key` public half to the existing `builder-authorized-keys` entry in `secrets/remote-builder.mac-builder.yaml`; re-encrypt to `&host_mac_builder`.
  - Leave the file with exactly two keys (`tailscale-oauth-secret`, `builder-authorized-keys`) and no other host recipient.
  - Done when `sops -d` on the builder store yields both keys and the authorized-keys line matches the public half from task 1.2.
  - _Depends: 1.2_
  - _Requirements: 6.2, 6.8, 6.10_

- [ ] 2. Add the builder's tailnet membership

- [ ] 2.1 Enable the open-source tailscaled and declare the OAuth secret
  - Create `configurations/mac-builder/tailscale.nix` with `services.tailscale.enable = true` (launchd `tailscaled`, `RunAtLoad`, MagicDNS resolver) and leave `services.tailscale.overrideLocalDns` at its `false` default so public DNS still reaches the caches.
  - Declare `sops.secrets."tailscale-oauth-secret" = { mode = "0400"; owner = "root"; group = "wheel"; }` against the existing `sops.defaultSopsFile`.
  - Use the open-source `tailscale` package only; no macOS app, no Home Manager module, no `configurations/common-darwin` import.
  - Done when the evaluated builder shows the `tailscaled` daemon, the `ts.net` resolver, and the secret at `0400 root:wheel`.
  - _Requirements: 4.1, 4.2, 4.9, 6.10_

- [ ] 2.2 Add the login-free OAuth authentication daemon
  - Register `launchd.daemons.mac-builder-tailscale-auth` with `path = [ tailscale jq coreutils bash ]`, `environment = { TS_AUTH_KEY_FILE = "/run/secrets/tailscale-oauth-secret"; TS_TAG = "tag:mac-builder"; TS_HOSTNAME = "mac-builder"; }`, `RunAtLoad`, `StartInterval = 300`, and log paths under `/var/log`.
  - Script steps: exit nonzero naming `TS_AUTH_KEY_FILE` when it is missing or empty; bounded wait for `tailscale status --json`; exit 0 when `.BackendState == "Running"`; otherwise write a `0600` derived key inside a `0700` root-only runtime directory, append `?ephemeral=false&preauthorized=true`, run `tailscale up --auth-key=file:<derived> --advertise-tags=$TS_TAG --hostname=$TS_HOSTNAME --timeout=60s`, delete the derived file, and propagate the status.
  - Keep the secret value out of argv, the plist, and any log line.
  - Done when a stubbed run no-ops for `Running`, re-runs `tailscale up` for `NeedsLogin`, and fails naming the secret path when the file is absent.
  - _Depends: 2.1_
  - _Requirements: 4.3, 4.4, 4.5, 4.6_

- [ ] 2.3 Import the tailnet module into the builder host
  - Add `./tailscale.nix` to the imports of `configurations/mac-builder/default.nix`; leave the `nix-builder` user, OpenSSH settings, Nix daemon trust, and the `builder-authorized-keys` activation fragment unchanged.
  - Confirm the host declares no `nix.buildMachines`, no Home Manager configuration, no subnet router or proxy, and no path through the personal host's tailnet node.
  - Done when `nix eval .#darwinConfigurations.mac-builder.config.system.build.toplevel.drvPath` succeeds and the tailnet module is the only behavioral addition.
  - _Depends: 2.1, 2.2_
  - _Requirements: 4.7, 4.8, 4.9_

- [ ] 2.4 Deploy the builder and verify membership plus the stock endpoint
  - Run `mac-builder-deploy` over the existing LAN forward, then confirm `tailscale status` reports `Running`, hostname `mac-builder`, and `tag:mac-builder`; reboot the guest and force `tailscale down` to confirm the next interval re-registers with no interactive login.
  - Run `mac-builder-readiness` against the tailnet name: SSH as `nix-builder`, `builtins.currentSystem` reports `aarch64-darwin`, and `nix store ping` succeeds over `ssh-ng://`; submit one trivial `aarch64-darwin` derivation and confirm its output returns.
  - Confirm a foreign-system request is rejected and that a host with the guest's client key public half is the only new authorized key.
  - Done when membership survives reboot and forced disconnect and readiness passes against the tailnet name.
  - _Depends: 2.3, 1.3_
  - _Requirements: 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.12_

- [ ] 3. Restrict the builder to public caches

- [ ] 3.1 Declare public substituters and their trusted keys
  - In `configurations/mac-builder/default.nix`, set `nix.settings.substituters = lib.mkForce [ "https://cache.nixos.org/" "https://nix-community.cachix.org" ]` and `nix.settings.trusted-public-keys = lib.mkForce [ "cache.nixos.org-1:…" "nix-community.cachix.org-1:…" ]` with the exact public keys.
  - Keep `mkForce` so nix-darwin's `mkAfter` default does not widen the rendered list; add no `local-binary-cache` or Attic URL, cache credential, publisher, push hook, or cachix token.
  - Done when the evaluated `nix.settings` carries exactly those two substituters and two keys and a text scan of the rendered builder configuration finds no private cache reference.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.7_

- [ ] 4. Make the guest daemon the Darwin dispatch client

- [ ] 4.1 Author the `fabro.darwinBuilder` module and its derived daemon settings
  - Create `configurations/fabro-vm/darwin-builder.nix` with options `enable`, `hostName`, `sshUser`, `clientKeySecret`, `hostPublicKey`, `maxJobs`, `speedFactor`, `supportedFeatures`.
  - Under `mkIf cfg.enable` set `nix.distributedBuilds = true`, `nix.settings."builders-use-substitutes" = true`, and one `nix.buildMachines` entry: `protocol = "ssh-ng"`, `system = "aarch64-darwin"`, `sshUser = "nix-builder"`, `sshKey = config.sops.secrets.${cfg.clientKeySecret}.path`, `publicHostKey = cfg.hostPublicKey`, plus the job and feature limits.
  - Declare `sops.secrets.${cfg.clientKeySecret} = { mode = "0400"; owner = "root"; group = "root"; }` and reference it only by path; keep `trusted-users = [ "@wheel" ]` and touch no sandbox, image, or `containers.conf` key.
  - Done when `nixosConfigurations.fabro-vm.config.nix.buildMachines` holds exactly one `aarch64-darwin` entry whose key is the runtime path and the rendered `/etc/nix/machines` line reads `ssh-ng://nix-builder@<host> aarch64-darwin /run/secrets/nix-builder-client-key 2 1 benchmark,big-parallel - <key>`.
  - _Requirements: 1.1, 1.2, 1.3, 3.1, 3.2, 3.3, 6.1, 6.4, 6.6, 6.9, 7.5, 7.6_

- [ ] 4.2 Fail evaluation when the dispatch trust material is missing or malformed
  - Add assertions that fail with a message naming `fabro.darwinBuilder.hostPublicKey` when it is empty or whitespace, naming `fabro.darwinBuilder.hostName` when it is empty, an IPv4 literal, or carries a `:port` suffix, and naming `fabro.darwinBuilder.clientKeySecret` when no matching `config.sops.secrets` entry exists.
  - Keep the assertions on the enabled path only, so a disabled module evaluates cleanly.
  - Done when each malformed configuration fails `nix eval` naming its option and the valid configuration still evaluates.
  - _Depends: 4.1_
  - _Requirements: 6.11_

- [ ] 4.3 Enable the module on the guest with the pinned builder host key
  - On the builder, capture `base64 -b 0 -i /etc/ssh/ssh_host_ed25519_key.pub` from the deployed host; set `hostName = "mac-builder.tuxedo-musical.ts.net"`, `sshUser = "nix-builder"`, `hostPublicKey` to that value, `maxJobs = 2`, `speedFactor = 1`, `supportedFeatures = [ "benchmark" "big-parallel" ]`, and `clientKeySecret = "nix-builder-client-key"`.
  - Import `./darwin-builder.nix` from `configurations/fabro-vm/default.nix` and add the `nix-builder-client-key` entry to `fabro.onePasswordSecrets` so the existing undeclared-secret assertion keeps passing.
  - Done when the guest evaluates with dispatch enabled, the machines entry carries the captured host key and the tailnet name (not the LAN forward or a DHCP address), and no secret value appears in the evaluated configuration text.
  - _Depends: 2.4, 1.2, 4.1_
  - _Requirements: 1.5, 3.2, 3.3, 6.4, 6.5, 6.9_

- [ ] 5. Document the tailnet grant and secret rotation

- [ ] 5.1 Write `docs/mac-builder-tailnet.md`
  - Record the `tag:mac-builder` ownership, the builder's OAuth client authorization, and an ACL grant snippet allowing `tag:fabro` to `tag:mac-builder` on `tcp:22` (the only remote-builder port), noting that the LAN forward is not part of this path.
  - Add the MagicDNS prerequisite with the verification command `getent hosts mac-builder.tuxedo-musical.ts.net` on the guest, the failure signature when the grant is missing (build fails naming the tailnet name), and rotation of the OAuth secret with a `mac-builder-tailscale-auth` restart and `tailscale status` check.
  - Done when the snippets and commands match the configured host name, tag, and port and the doc names who owns the console policy.
  - _Requirements: 3.4, 3.5, 4.4_

- [ ] 5.2 Document both new secrets in `secrets/README.md`
  - Add `nix-builder-client-key` (fabro store, `&host_fabro`, `/run/secrets/nix-builder-client-key`, `0400 root:root`, rotation by regenerating the keypair and updating both stores) and `tailscale-oauth-secret` (builder store, `&host_mac_builder`, `0400 root:wheel`, source `Mac Builder Tailscale Credentials`).
  - Keep the existing per-host table conventions and state that neither value may enter the Nix store, the sandbox image, or a rendered file.
  - Done when the table and runbook name both secrets, their recipients, runtime paths, consumers, and rotation steps.
  - _Requirements: 6.6, 6.7, 6.10_

- [ ] 6. Add repository checks

- [ ] 6.1 Add the test helpers and the guest dispatch suite
  - Create `tests/fabro-darwin-builder/helpers.js` with the `nixEvalJson`/`nixEvalFailure` shape from `tests/mac-nix-remote-builder/helpers.js`, a `package.json`, and `guest-dispatch.test.js` evaluating `nixosConfigurations.fabro-vm.config`.
  - Assert `nix.distributedBuilds`, `builders-use-substitutes`, exactly one build machine with `protocol = "ssh-ng"`, `system = "aarch64-darwin"`, `sshUser = "nix-builder"`, `sshKey` equal to the sops path, a non-empty `publicHostKey`, the rendered `/etc/nix/machines` field order, and the secret's `0400` root mode; assert no Linux system is listed and no private-key material appears.
  - Done when `node --test tests/fabro-darwin-builder/guest-dispatch.test.js` passes and fails when any asserted element is removed.
  - _Depends: 4.1_
  - _Requirements: 1.1, 1.2, 3.2, 6.4, 6.6, 6.9, 7.5, 8.1_

- [ ] 6.2 (P) Add the builder membership, endpoint, and cache suite
  - Add `tests/fabro-darwin-builder/builder-membership.test.js` evaluating `darwinConfigurations.mac-builder.config`: `services.tailscale.enable` plus the `tailscaled` daemon, the auth daemon's `RunAtLoad`/`StartInterval`, the `tag:mac-builder` tag and hostname in its script, the OAuth secret mode, `trusted-users` membership, absence of `extra-platforms` or a foreign `systems` list, key-only sshd with the fails-closed authorized-keys fragment, and the exact `substituters`/`trusted-public-keys` lists.
  - Assert the rendered builder configuration text contains no `local-binary-cache` or Attic reference and no build scheduler or queue service.
  - Done when the suite passes and each assertion fails when its element is removed.
  - _Depends: 2.3, 3.1, 6.1_
  - _Boundary: Builder Membership Checks_
  - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.7, 6.10, 6.12, 7.1, 7.2, 7.3, 7.4, 8.2_

- [ ] 6.3 (P) Add the one-Nix-per-sandbox invariants suite
  - Add `tests/fabro-darwin-builder/sandbox-invariants.test.js` evaluating the guest: the engine-level mount list is exactly the store, daemon-socket, and `/tmp` entries, and the sandbox image `Env` still carries `NIX_REMOTE=daemon` and `NIX_CONFIG`.
  - Assert the image declares no client key, no tailscale package, no build-machine or substituter setting, and that the guest adds no per-environment builder wiring.
  - Done when the suite passes on the current tree and fails when a mount or image environment entry is added.
  - _Depends: 4.1, 6.1_
  - _Boundary: Sandbox Invariants Checks_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 6.8, 8.4_

- [ ] 6.4 (P) Add the poisoned-secret render suite
  - Add `tests/fabro-darwin-builder/secret-absence.test.js` rendering the machines file, the auth daemon script and plist, and the guest module text with poisoned secret values.
  - Assert only the paths (`/run/secrets/nix-builder-client-key`, `/run/secrets/tailscale-oauth-secret`) appear, and no poisoned value, argv fragment, or log line does.
  - Done when the suite fails when a value is substituted for a path and passes on the real configuration.
  - _Depends: 4.1, 6.1_
  - _Boundary: Secret-Value Checks_
  - _Requirements: 6.6, 6.7, 6.9, 6.10, 8.3_

- [ ] 6.5 (P) Add the dispatch evaluation-failure cases
  - Extend `tests/fabro-darwin-builder/guest-dispatch.test.js` with `lib.evalModules` cases over `configurations/fabro-vm/darwin-builder.nix` feeding an empty and a whitespace `hostPublicKey`, an IPv4 `hostName`, a `hostName` with a `:port`, and a `clientKeySecret` with no sops entry.
  - Assert each failure message names the offending option and that the disabled module evaluates without error.
  - Done when every malformed case fails for its own reason and the valid module still evaluates.
  - _Depends: 4.2, 6.1_
  - _Boundary: Dispatch Assertion Checks_
  - _Requirements: 6.11, 8.1_

- [ ] 6.6 Register the `fabro-darwin-builder` flake check
  - Add `checks.<system>.fabro-darwin-builder` as a `runCommand` with `nix` and `nodejs` native inputs that copies the source writable and runs `node --test tests/fabro-darwin-builder/`, mirroring the existing `mac-nix-remote-builder` check.
  - Keep the check offline and free of real tailnet, SSH, or builder calls.
  - Done when `nix build .#checks.$(nix eval --impure --raw --expr builtins.currentSystem).fabro-darwin-builder` runs the whole suite.
  - _Depends: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 7. Ship the Darwin build smoke check

- [ ] 7.1 Implement `scripts/fabro-darwin-build-smoke.nix`
  - Write a `writeShellApplication` named `fabro-darwin-build-smoke` taking `{ pkgs, name }` with `runtimeInputs = [ podman coreutils ]`, an optional `IMAGE_REF` argument defaulting to `<name>@$(cat /run/fabro-sandbox/digest)`, and a banner per step.
  - Steps: `reference` (digest readable), `dispatch` (`podman run --rm "$ref" /bin/bash -c` running `nix build --no-link --print-out-paths --impure --expr` over a trivial derivation with `system = "aarch64-darwin"`), `guest-store` (each printed path `test -e` under `/nix/store`).
  - Print the produced store paths on success and exit nonzero naming the failed step; keep the run read-only and download no flake.
  - Done when a stubbed dispatch prints a path that exists and each failing step exits nonzero with its name.
  - _Requirements: 1.3, 1.4, 8.5, 8.6, 8.7_

- [ ] 7.2 Expose the smoke command on the guest and as a flake package
  - Add `packages.aarch64-linux.fabro-darwin-build-smoke` bound to `self.nixosConfigurations.fabro-vm` pkgs and `fabro.sandboxImage.name`, following the existing `fabro-sandbox-smoke` binding.
  - Add the same derivation to the guest's `environment.systemPackages` in `configurations/fabro-vm/default.nix` so `fabro-darwin-build-smoke` is on the guest PATH.
  - Done when `nix eval .#packages.aarch64-linux.fabro-darwin-build-smoke.drvPath` resolves and the guest's `systemPackages` contains the command.
  - _Depends: 7.1_
  - _Requirements: 8.5_

- [ ] 8. Roll out and verify end to end

- [ ] 8.1 Rebuild the guest and run the Darwin build smoke
  - Rebuild the guest with the dispatch module, confirm `/etc/nix/machines` carries the pinned key and tailnet name, `getent hosts mac-builder.tuxedo-musical.ts.net` resolves, and root `ssh -i /run/secrets/nix-builder-client-key -o BatchMode=yes nix-builder@<name> true` succeeds.
  - Run `fabro-darwin-build-smoke` on the guest; confirm it prints an `aarch64-darwin` store path, that path exists in the guest `/nix/store`, and a sandbox can read it without any workflow change.
  - Also run an `aarch64-linux` build from a sandbox and confirm it still completes locally.
  - Done when the smoke exits 0 with the path and the Linux build path is unchanged.
  - _Depends: 2.4, 4.3, 7.2_
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 3.1, 3.2, 5.5, 7.5, 7.6, 8.5, 8.6_

- [ ] 8.2 Record the negative dispatch observations
  - Poison `hostPublicKey` on the guest: confirm the dispatch fails on host-key verification and names the builder. Stop the builder's `tailscaled` (or deny the ACL): confirm the build fails naming the tailnet FQDN and never falls back to a local build.
  - Remove `/run/secrets/nix-builder-client-key`: confirm the ssh error names that path. Confirm an unknown key is refused by the builder, and that the builder substitutes inputs itself rather than the guest uploading them.
  - Done when each observation is captured with the error text showing the builder's tailnet name or the missing material.
  - _Depends: 8.1_
  - _Requirements: 1.6, 1.7, 3.5, 3.6, 6.3, 6.5, 6.11, 7.6, 8.7_
