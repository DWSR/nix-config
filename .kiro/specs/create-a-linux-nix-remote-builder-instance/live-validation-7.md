# Task 7 Live Validation

Task 7 validates the provisioned Linux remote-builder behavior described in
the design's `## Operator Provisioning` section. The live observations require
the operator-provisioned builder, the Fabro guest, `Brandons-MacBook-Pro`, and
the tailnet grants. Those live systems are not available in the aarch64-linux
implementation sandbox, so this file records the environment-blocked status and
the operator action that completes the task. It does not claim a live PASS.

## Harness

The checked-in `scripts/linux-builder-live-validate.nix` harness performs the
sequence from `secrets/README.md` "Live acceptance after provisioning" and
appends its observations to this file. It is confirmation-gated, refuses to run
without an interactive TTY, and runs only on the personal Mac that manages the
Lima instances:

```sh
nix build --impure --no-link --print-out-paths --expr 'let
  flake = builtins.getFlake (toString ./.);
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
in import ./scripts/linux-builder-live-validate.nix { inherit pkgs; }'
# then run <result>/bin/linux-builder-live-validate --confirm-live-state-changes
```

The harness records these observations when it runs:

1. The `linux-builder` guest's Tailscale backend is `Running`, its MagicDNS
   identity starts with `linux-builder.`, and it carries
   `tag:linux-nix-remote-builder`.
2. The committed `certificates/linux-builder/ssh_host_ed25519_key.pub` pin
   matches the guest's persistent `/var/lib/ssh/ssh_host_ed25519_key.pub`.
3. The Fabro guest's `/run/fabro-darwin-builders/machines` is mode `0600 root
   root` and contains the unchanged Fabro Darwin record
   (`/run/secrets/build-client-key`, `4`, `2`) followed by the Linux
   `aarch64-linux` record with the runtime client-key path, `max-jobs = 4`, and
   speed factor `1`.
4. An `aarch64-linux` derivation from the Fabro guest returns a store path that
   exists in the Linux builder's store and contains `aarch64-linux`.
5. An `aarch64-linux` derivation from the personal Mac returns a store path that
   exists in the Linux builder's store and contains `aarch64-linux`.
6. An `aarch64-darwin` derivation from the Fabro guest still returns through
   the existing `mac-builder.tuxedo-musical.ts.net` endpoint.
7. An `x86_64-linux` derivation fails with a platform mismatch on both clients
   without printing an output path.
8. After the builder is stopped cleanly, an `aarch64-linux` derivation on Fabro
   fails on the builder transport, the precomputed output path stays absent
   from Fabro's store, and the diagnostic proves `max-jobs = 0`. The harness
   then restarts the launchd agent, waits for the builder to become usable, and
   repeats a Linux build to confirm recovery.

## Current status

`environment-blocked: secret-material-blocked linux-builder-host-key-pin (guest /var/lib/ssh/ssh_host_ed25519_key.pub; certificates/linux-builder/ssh_host_ed25519_key.pub is absent from this checkout)`

`environment-blocked: live-tailscale-lima (no lima-vmctl, running fabro or linux-builder Lima guests, or tailnet identity on the aarch64-linux implementation sandbox)`

No live observation has been recorded yet because none of the required live
systems can be reached from this sandbox. The harness's own offline suite is
validated directly:

```sh
nix develop --command node --test tests/linux-nix-remote-builder/live-validate.test.js
# 19 tests, 19 pass
```

## Operator action

1. Complete the design's `## Operator Provisioning` table, including the
   builder age key, both client keypairs, the builder authorized keys, the
   Tailscale OAuth credential, the tailnet tag/grants, and the persistent SSH
   host key.
2. Copy the guest's `/var/lib/ssh/ssh_host_ed25519_key.pub` to
   `certificates/linux-builder/ssh_host_ed25519_key.pub` and commit it before
   deploying either client.
3. Deploy the builder and switch both clients as described in
   `secrets/README.md`.
4. Run the harness on the personal Mac with `--confirm-live-state-changes` and
   keep the appended observations in this file. The harness fails closed on a
   missing pin, a host-key mismatch, a missing machine record, or any failed
   live check; do not weaken host-key checking or `max-jobs = 0` to make it
   pass.
