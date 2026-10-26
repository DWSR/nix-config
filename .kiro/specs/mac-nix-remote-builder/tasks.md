# Implementation Plan

- [ ] 1. Provision the builder-host secret identity and store

- [x] 1.1 Provision the builder age identity and add its sops rule
  - Generate the builder age keypair; store the private key in 1Password and capture the public recipient (operator action, mirrors the existing per-host bootstrap).
  - Add the `&host_mac_builder` anchor and a `secrets/remote-builder\.mac-builder\.yaml$` creation rule with exactly that one recipient to `.sops.yaml`.
  - Document the builder age-key item, the age-key-before-first-switch bootstrap order, and authorized-key rotation in `secrets/README.md`.
  - Done when `.sops.yaml` parses with the anchor and its rule, `secrets/README.md` names the builder store, and the recipient round-trips from the stored private key.
  - _Requirements: 4.2, 4.6_

- [x] 1.2 Author the encrypted builder secret store
  - Create `secrets/remote-builder.mac-builder.yaml` with a `builder-authorized-keys` entry holding the newline-separated client public keys, encrypted to `&host_mac_builder`.
  - Confirm the encrypted file lists only the builder recipient and `sops -d` yields only `builder-authorized-keys`.
  - Done when the store decrypts to the declared key set and its plaintext contains no personal-host secret.
  - _Depends: 1.1_
  - _Requirements: 2.4, 4.1_

- [ ] 2. Build the portable nix-darwin builder host configuration

- [x] 2.1 Scaffold the host configuration with packages, daemon trust, and GC
  - Create `configurations/mac-builder/default.nix` as a standalone nix-darwin module with `nixpkgs.hostPlatform = "aarch64-darwin"`, `nixpkgs.config.allowUnfree = true`, and an explicit `system.stateVersion`.
  - Set `nix.enable = true` (its launchd daemon serves builds without an interactive login), `nix.settings.trusted-users = [ "nix-builder" ]`, and `nix.settings.experimental-features = [ "nix-command" "flakes" ]`.
  - Declare no `extra-platforms`, so the daemon serves only `aarch64-darwin` and rejects foreign-system requests.
  - Declare `nix.gc.automatic = true` with a calendar interval and `options = "--delete-older-than 7d"`, plus `nix.optimise.automatic = true`.
  - Enable `services.openssh` and supply the host packages (`git`, `curl`, `cacert`, `coreutils`, `bash`, `gzip`, `xz`, `zstd`) through `environment.systemPackages`.
  - Do not import `configurations/common-darwin`; add no Lima image, provisioning, boot, or FRE reference.
  - Done when the configuration evaluates for `aarch64-darwin` and its rendered settings show the trusted user, the GC schedule, and OpenSSH enabled.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.1, 3.5, 3.6_

- [x] 2.2 Define the dedicated non-privileged builder user
  - Declare `users.users.nix-builder` with a fixed non-system UID, primary `gid = 20` (`staff`), `isHidden = true`, `home = "/Users/nix-builder"`, `createHome = true`, and `shell = "/bin/bash"`.
  - Keep the account out of the `admin` group so it holds no administrative or root privileges.
  - Done when the evaluated user has the `staff` group, is absent from `admin`, and no other account is added to `nix.settings.trusted-users`.
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 2.3 Wire the builder secret store and authorized-keys activation
  - Import `inputs.sops-nix.darwinModules.default` directly; set `sops.age.keyFile = "/var/lib/sops-nix/key.txt"`, `sops.age.sshKeyPaths = []`, `sops.gnupg.sshKeyPaths = []`, and `sops.defaultSopsFile = ../../secrets/remote-builder.mac-builder.yaml`.
  - Declare `sops.secrets."builder-authorized-keys"` and install it to `~nix-builder/.ssh/authorized_keys` (`0600`, owned by `nix-builder`, dir `0700`) from a `system.activationScripts.postActivation.text = lib.mkOrder 9999` fragment ordered after decryption.
  - Make the fragment fail loudly, naming the secret, when the file is missing or empty; set `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, and `PermitRootLogin no`.
  - Host identity is the nix-darwin-managed `services.openssh.hostKeys`; clients verify it out of band.
  - Done when the evaluated activation text references the secret path and `nix-builder`, no secret value appears in a store path, and a missing-secret fixture fails activation.
  - _Depends: 1.2_
  - _Requirements: 2.4, 2.5, 2.6, 2.7, 4.1, 4.3, 4.4, 4.5_

- [x] 2.4 Register the builder host in the flake
  - Add `darwinConfigurations.mac-builder` to `flake.nix` via `inputs.darwin.lib.darwinSystem`, following the existing `Brandons-MacBook-Pro` entry, with `inputs`/`outputs` specialArgs and the `./configurations/mac-builder` module.
  - Done when `nix eval .#darwinConfigurations.mac-builder.config.nixpkgs.hostPlatform` reports `aarch64-darwin` and the host's `system.build.toplevel` evaluates.
  - _Depends: 2.1, 2.2, 2.3_
  - _Requirements: 1.5, 3.1_

- [ ] 3. Add the personal-host Lima macOS guest adapter

- [x] 3.1 Define the limaMacGuest option surface and register the module
  - Create `home-manager/common/lima-mac-guest.nix` exposing `virtualisation.limaMacGuest` with `enable`, `name` (default `"mac-builder"`), `package`, `limaHome`, `image.{location,digest,arch}`, `cpus`, `memory`, `disk`, `suppressFirstLoginSetup` (default `true`), `extraLimaConfig`, `forward.{enable,bindAddress,port}`, `deploy.{enable,hostName,ageKeySecretRef}`, and internal `_configYaml`/`_supervisor`/`_forward`/`_deploy` read-only paths.
  - Add assertions for a native-architecture VZ guest and a valid Lima instance name, and import the module from `home-manager/common/default.nix` beside `./lima-vm.nix`.
  - Never read or write `virtualisation.limaVM`; keep the module disabled by default.
  - Done when a standalone Home Manager evaluation reads the option namespace, renders nothing while disabled, and the personal host's `virtualisation.limaVM` render is unchanged.
  - _Requirements: 5.1, 5.7_

- [x] 3.2 Render the macOS Lima guest YAML
  - Render `_configYaml` with `minimumLimaVersion >= 2.3.0`, `os: Darwin`, `vmType: vz`, `arch: aarch64`, the pinned Apple `.ipsw` `images[0].location` + `digest`, `video.display: default`, `mounts: []`, and no `containerd`.
  - Set `osOpts.Darwin.suppressFirstLoginSetup = true` (the FRE skip) and take `cpus`, `memory`, and `disk` from options.
  - Done when the rendered YAML passes `limactl validate` and contains the pinned image, the FRE-skip key, and `mounts: []`.
  - _Requirements: 5.1, 5.6_

- [x] 3.3 Add the launchd VM supervisor
  - Render the supervisor that creates the instance from `_configYaml` when missing, then `exec limactl --tty=false start --foreground <name>` with `LIMA_HOME` exported.
  - Register `launchd.agents.dev.dwsr.lima-mac-builder` with `RunAtLoad = true`, `KeepAlive.SuccessfulExit = false`, `ProcessType = "Background"`, `LIMA_HOME` in the environment, and logs under `~/Library/Logs/lima-vm/`.
  - Done when the rendered agent starts the guest on load, restarts it after a nonzero exit, and leaves it stopped after a clean `limactl stop`.
  - _Requirements: 5.2, 5.3, 5.4, 5.5_

- [x] 3.4 Add the launchd host-side SSH forward
  - Render the forward as `ssh -F <LIMA_HOME>/<name>/ssh.config -o ExitOnForwardFailure=yes -N -L <bindAddress>:<port>:127.0.0.1:22 lima-<name>` with a server-alive interval.
  - Register `launchd.agents.dev.dwsr.lima-mac-builder-forward` with `RunAtLoad` and `KeepAlive` so it retries until the instance exists and recovers when the tunnel drops.
  - Done when the rendered agent binds the configured address and exposes the guest sshd without guest IP discovery.
  - _Requirements: 3.2, 5.2_

- [x] 3.5 Enable the guest on the personal host
  - Enable `virtualisation.limaMacGuest` in `configurations/personal/home-manager/default.nix` with the pinned latest macOS image and digest, resource sizes, `suppressFirstLoginSetup = true`, and the forward `bindAddress`/`port`.
  - Confirm the existing `virtualisation.limaVM` fabro instance stays enabled and unchanged.
  - Done when the personal host evaluates with both the fabro NixOS instance and the macOS builder guest declared, and the rendered guest YAML carries the FRE skip and `mounts: []`.
  - _Depends: 3.1, 3.2, 3.3, 3.4_
  - _Requirements: 5.1, 5.6, 5.7_

- [ ] 4. Ship the one-touch deploy command

- [x] 4.1 Implement the deploy and bootstrap command
  - Create `scripts/mac-builder-deploy.nix` as a `writeShellApplication` taking `[REPO]` (defaulting to the cwd) and requiring `flake.nix` + `flake.lock`, failing before any host change when inputs are not locked.
  - Probe reachability through the instance's Lima SSH config and fail with the connection error otherwise; stream the repository tree (excluding `.git`, `.direnv`, `result*`) to a guest scratch dir over SSH.
  - Read the builder age key from 1Password and install `/var/lib/sops-nix/key.txt` (`0600`, root); bootstrap Nix with the pinned installer when absent; apply with `sudo -A nix run <pinned nix-darwin> -- switch --flake '<scratch>#mac-builder'` (later switches use `darwin-rebuild`).
  - Write the `SUDO_ASKPASS` helper into the guest (reading the guest's `~/password`) and mount or copy nothing from the personal host.
  - Done when stubbed `ssh`/`op` runs show the locked-flake guard, the unreachable error, the streamed tree, the age-key install, and the switch invocation.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

- [ ] 4.2 Wire the deploy command into the guest module and personal host
  - Build the module's internal `_deploy` from `scripts/mac-builder-deploy.nix` and add it to `home.packages`; set `deploy.{enable,hostName,ageKeySecretRef}` on the personal host.
  - Expose the deploy command as a flake app/package on `aarch64-darwin`, following the existing `scripts/*` app pattern.
  - Done when `mac-builder-deploy` is on the personal host's PATH and the flake app resolves to the script derivation.
  - _Depends: 3.5, 4.1_
  - _Requirements: 6.1, 6.3_

- [ ] 5. Add the runtime readiness check

- [ ] 5.1 Implement and expose the readiness check
  - Create `scripts/mac-builder-readiness.nix` as a `writeShellApplication` taking the endpoint (user, address, port) and an operator SSH identity.
  - Check that SSH as `nix-builder` succeeds, that the remote reports `builtins.currentSystem == "aarch64-darwin"`, and that `nix store ping` over the `ssh-ng://` endpoint succeeds; print a per-check report.
  - Exit nonzero naming the failing check; expose the command as a flake app/package on `aarch64-darwin`.
  - Done when a stubbed successful endpoint exits 0 and each failing check exits nonzero with its name.
  - _Depends: 2.4_
  - _Requirements: 7.4, 7.5_

- [ ] 6. Add repository checks and integration validation

- [ ] 6.1 Add the shared harness and builder-host render assertions
  - Create `tests/mac-nix-remote-builder/helpers.js` (the `nixEvalJson`/`nixEvalFailure` pattern from `tests/lima-vm/helpers.js`) and `builder-host-render.test.js`.
  - Assert the evaluated `darwinConfigurations.mac-builder`: the `nix-builder` user (non-admin, `staff` group), `services.openssh.enable`, `trusted-users` membership, the GC schedule, `hostPlatform == "aarch64-darwin"`, the `builder-authorized-keys` sops declaration, and the absence of any Lima image/provisioning/boot/FRE reference.
  - Done when `node --test tests/mac-nix-remote-builder/builder-host-render.test.js` passes and each assertion fails when its element is removed.
  - _Depends: 2.4_
  - _Requirements: 1.3, 1.4, 1.5, 2.2, 2.5, 3.1, 7.1, 7.3_

- [ ] 6.2 (P) Add personal-guest render assertions
  - Add `tests/mac-nix-remote-builder/personal-guest-render.test.js` evaluating `virtualisation.limaMacGuest` in a standalone fixture and on the personal host.
  - Assert the rendered YAML (`os: Darwin`, `vmType: vz`, pinned image + digest, `osOpts.Darwin.suppressFirstLoginSetup`, `mounts: []`, no containerd), both launchd agents (supervisor and forward), and that `virtualisation.limaVM` still renders unchanged.
  - Done when the suite passes and the fabro instance's render is unchanged from its pre-feature output.
  - _Depends: 3.5, 6.1_
  - _Boundary: Personal-Host Guest Render Tests_
  - _Requirements: 5.1, 5.6, 5.7, 7.2_

- [ ] 6.3 (P) Add poisoned-secret render assertions
  - Add `tests/mac-nix-remote-builder/secret-value.test.js` rendering the guest YAML, the activation fragment, and the deploy text with poisoned secret values.
  - Assert only the poisoned *paths* (`/var/lib/sops-nix/key.txt`, `/run/secrets/builder-authorized-keys`, `~nix-builder/.ssh/authorized_keys`) appear and no poisoned value does.
  - Done when the check fails when a value is substituted for a path and passes on the real configuration.
  - _Depends: 2.3, 4.1, 6.1_
  - _Boundary: Secret-Value Checks_
  - _Requirements: 4.3, 7.6_

- [ ] 6.4 (P) Add deploy behavior tests with stubs
  - Add `tests/mac-nix-remote-builder/deploy.test.js` driving the deploy against stubbed `ssh`/`op`.
  - Assert the locked-flake guard aborts before any host change, the unreachable host fails with the connection error, the tree is streamed as a tar over SSH with no mounts, the age key is installed, and the switch command runs.
  - Done when every guard/stream/install/switch case passes with the stubs.
  - _Depends: 4.1, 6.1_
  - _Boundary: Deploy Behavior Tests_
  - _Requirements: 6.4, 6.5, 6.6, 6.7_

- [ ] 6.5 Register the mac-nix-remote-builder flake check
  - Add `checks.<system>.mac-nix-remote-builder` as a `node --test tests/mac-nix-remote-builder/` `runCommand` following the existing `lima-vm-service` check (Nix + Node native inputs, copied writable source).
  - Done when `nix build .#checks.$(nix eval --impure --raw --expr builtins.currentSystem).mac-nix-remote-builder` runs the whole suite.
  - _Depends: 6.1, 6.2, 6.3, 6.4_
  - _Requirements: 7.1, 7.2, 7.3_

- [ ] 6.6 Run the integration smoke against a live guest
  - Create the guest, run `mac-builder-deploy`, and confirm the first switch activates; run `mac-builder-readiness` against the endpoint.
  - Submit an `aarch64-darwin` derivation through `ssh-ng://` and confirm the output returns; submit a foreign-system derivation and confirm rejection.
  - Reboot the personal host and confirm the guest starts and the forward comes up without login; kill the guest and confirm launchd restarts it; clean-stop and confirm it stays stopped.
  - Done when each observation above is captured.
  - _Depends: 4.2, 5.1, 6.5_
  - _Requirements: 3.3, 3.4, 3.5, 5.3, 5.4, 5.5_
