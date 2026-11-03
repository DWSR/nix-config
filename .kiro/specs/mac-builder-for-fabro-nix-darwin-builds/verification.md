# Live Dispatch Path Verification

Task 5.6 of `mac-builder-for-fabro-nix-darwin-builds` asks for operator
observations on the deployed Builder Host and Fabro Guest. This record captures
every observation the implementation sandbox can produce and marks the rest
`environment-blocked`, with the exact command that produces each missing
observation.

Requirements in scope: 1.4, 1.5, 3.1, 3.2, 6.6, 8.6. Requirements 1.4 and 1.5
depend on the live sandbox observation recorded as environment-blocked in
[Observation 3](#observation-3-sandbox-smoke-and-store-resolution).

## Environment

| Property | Value |
| --- | --- |
| Implementation host | `aarch64-linux` sandbox container (Linux 7.2.9, Nix 2.34.9) |
| Baseline commit | `ee99f955663ae973befbe85aee0c1320551c5244` |
| Captured at | 2026-11-03T12:26Z |

Absent on this host, and the reason the live observations below are
environment-blocked:

- no `aarch64-darwin` builder and no tailnet data path: the DNS search domain
  is `tuxedo-musical.ts.net`, but neither `mac-builder.tuxedo-musical.ts.net`
  nor `fabro-vm.tuxedo-musical.ts.net` resolves, so no route can be selected;
- no Fabro Guest running the new generation: `/run/secrets`,
  `/run/fabro-darwin-builders`, and `/run/fabro-sandbox` do not exist;
- no `systemd`, no `launchctl`, no `podman`, no Lima instance, and no
  `/etc/passwd`, so the OpenSSH client cannot even resolve the local uid.

No observation below claims a tailnet join, an OAuth bring-up, a guest switch,
or sandbox store resolution. Those remain operator-gated; see
[Operator completion](#operator-completion).

## Observation 1: builder membership and readiness

Captured by evaluating the real host configuration
(`nix eval --json --impure --expr` over `darwinConfigurations."mac-builder".config`):

| Fact | Observed |
| --- | --- |
| `services.tailscale.enable` | `true` |
| Tailscale package | `tailscale-1.98.10` (open-source) |
| Auth `ProgramArguments` | `mac-builder-tailscale-auth --auth-key-file /run/secrets/builder-tailscale-oauth-secret --hostname mac-builder --tag tag:mac-builder --tailscale …/tailscale` |
| Auth daemon lifecycle | `RunAtLoad = true`, `KeepAlive = true`, `ThrottleInterval = 30`, `ProcessType = "Background"` |
| Auth daemon logs | `/var/log/mac-builder-tailscale-auth.log` and `.err.log` |
| OAuth secret | `/run/secrets/builder-tailscale-oauth-secret`, `0400 root:wheel` |
| Declared builder secrets | `builder-authorized-keys`, `builder-tailscale-oauth-secret` |
| Public substituters | `https://cache.nixos.org/`, `https://nix-community.cachix.org` (effective set; the evaluated list repeats the nixpkgs default `cache.nixos.org` entry) |
| Trusted public keys | the two matching cache keys after deduplication, no private-cache host |
| `nix.settings.trusted-users` | `root`, `nix-builder` |
| `services.openssh.extraConfig` | `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no` |

### environment-blocked: live builder observations

- **Registration under `tag:mac-builder` and OAuth bring-up without login** —
  needs the running host and its tailnet membership; nothing on this host can
  observe a node. Operator command is `mac-builder-deploy` followed by
  `tailscale status --json` and `launchctl print system/…` (see
  [Operator completion](#operator-completion)).
- **`mac-builder-readiness` over the LAN forward** — attempted with the
  command's own default endpoint, which is the LAN forward (`127.0.0.1:2222`),
  and failed at the first check because nothing is listening there:

  ```text
  $ nix run .#mac-builder-readiness
  mac-builder-readiness: endpoint ssh-ng://nix-builder@127.0.0.1:2222
  check 1/3: ssh (nix-builder@127.0.0.1:2222)
    FAIL
  mac-builder-readiness: FAILED: ssh
  exit 1
  ```

  A direct probe confirms the cause: `bash -c 'exec 3<>/dev/tcp/127.0.0.1/2222'`
  prints `Connection refused`.

  `environment-blocked: nix run .#mac-builder-readiness (default LAN forward 127.0.0.1:2222 is not listening: no Lima instance and no mac-builder guest on this sandbox host)`.

  Naming the tailnet FQDN directly is a different endpoint, not the LAN-forward
  observation, and also fails here. A successful LAN-forward run stays
  operator-gated; see [Operator completion](#operator-completion). The new
  dispatch path is exercised by the smoke below.

## Observation 2: guest machines file, daemon wiring, local Linux builds

Captured by evaluating `nixosConfigurations."fabro-vm".config`:

| Fact | Observed |
| --- | --- |
| `fabro.darwinBuilder.enable` | `true` |
| Machine entry | `mac-builder.tuxedo-musical.ts.net`, `nix-builder`, `aarch64-darwin`, 4 jobs, speed 2 |
| `nix.distributedBuilds` | `true` |
| `nix.settings.builders` | `@/run/fabro-darwin-builders/machines` (outside the store and `/etc`) |
| `nix.settings.builders-use-substitutes` | `true` |
| `nix.buildMachines` / `environment.etc."nix/machines"` | `[]` / absent |
| Renderer unit | `oneshot`, `RuntimeDirectory = fabro-darwin-builders`, `ExecStart` runs `fabro-darwin-machines` with the two secret paths |
| Renderer ordering | `wants`/`after` `sops-install-secrets.service`, `before` `nix-daemon.service` |
| `nix-daemon.service` | `wants` and `after` `fabro-darwin-builders.service`, not `requires` |
| Secrets | `build-client-key` and `build-host-key` at `0400 root:root`, restarting `fabro-darwin-builders.service` and `nix-daemon.service` |
| tmpfiles fallback | `f /run/fabro-darwin-builders/machines 0600 root root -` |

Captured by running the real renderer with fixture material (no secret value
was read or written; the fixture key contains a recognisable marker):

```text
$ fabro-darwin-machines --output /tmp/fabro-5.6-render/machines \
    --host-name mac-builder.tuxedo-musical.ts.net --ssh-user nix-builder \
    --system aarch64-darwin --max-jobs 4 --speed-factor 2 \
    --client-key /tmp/fabro-5.6-render/build-client-key \
    --host-key /tmp/fabro-5.6-render/build-host-key
$ stat -c 'mode=%a uid=%u gid=%g size=%s' /tmp/fabro-5.6-render/machines
mode=600 uid=0 gid=0 size=206
$ wc -l < /tmp/fabro-5.6-render/machines
1
$ awk '$2 == "aarch64-darwin" { n++ } END { print n+0 }' /tmp/fabro-5.6-render/machines
1
$ awk '$2 == "aarch64-linux" { n++ } END { print n+0 }' /tmp/fabro-5.6-render/machines
0
$ grep -c FIXTURE-CLIENT-KEY-CONTENT /tmp/fabro-5.6-render/machines
0
$ cat /tmp/fabro-5.6-render/machines
ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /tmp/fabro-5.6-render/build-client-key 4 2 - - c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSUZJWFRVUkVIT1NUS0VZIG1hYy1idWlsZGVyCg==
```

Captured by building on the same `aarch64-linux` host, proving a Linux
derivation still builds locally instead of being dispatched:

```text
$ nix build --no-link --print-out-paths --impure --expr \
    'derivation { name = "fabro-local-linux-check"; system = "aarch64-linux"; builder = "/bin/sh"; args = [ "-c" "echo local-aarch64-linux-build > $out" ]; }'
this derivation will be built:
  /nix/store/d9zpp3zjjqalv3zily813b4b5565zfi4-fabro-local-linux-check.drv
building '/nix/store/d9zpp3zjjqalv3zily813b4b5565zfi4-fabro-local-linux-check.drv'...
/nix/store/mly1y391zd32a3njs3gxxyck41gp6fm1-fabro-local-linux-check
$ cat /nix/store/mly1y391zd32a3njs3gxxyck41gp6fm1-fabro-local-linux-check
local-aarch64-linux-build
```

### environment-blocked: live guest switch

- **Switching the guest and confirming the systemd unit ran once, the file is
  `0600`, and `nix-daemon` restarted** — needs a running Fabro Guest.
  `environment-blocked: lima-vm-deploy / nixos-rebuild switch (no Fabro Guest in this sandbox)`.
  The renderer output and the unit ordering above are the offline equivalents;
  the switch itself has no substitute.

## Observation 3: sandbox smoke and store resolution

- `fabro-darwin-build-smoke` is installed in the guest's
  `environment.systemPackages` (evaluated: present).
- The real command fails its preflight on this host, naming the owning path:

  ```text
  $ fabro-darwin-build-smoke 'localhost/fabro-sandbox@sha256:fixture'
  fabro-darwin-build-smoke: [preflight] checking build-session material
  fabro-darwin-build-smoke: [preflight] Build Client Key is missing: /run/secrets/build-client-key
  exit 1
  ```

- The step banners and the successful store-path report are covered by
  `tests/fabro-darwin-builds/darwin-build-smoke.test.js`, which stubs `podman`
  and asserts the reported path is checked in the store.

### environment-blocked: live sandbox run and store resolution

- **Running the smoke from a sandbox, then confirming the reported store path
  exists in the guest store and resolves inside the sandbox** — needs the
  Guest's `podman`, the mounted store, and the builder endpoint.
  `environment-blocked: podman run from a Fabro sandbox (no podman, no /run/fabro-sandbox, no guest store, no builder)`.
  Requirement 1.4 (sandbox resolves guest-store output) and requirement 1.5 (no
  workflow change) therefore remain unobserved.

## Automated checks

| Command | Result |
| --- | --- |
| `node --test tests/fabro-darwin-builds/` | 141 tests, 141 pass |
| `nix develop --command prek run --all-files` | all hooks passed |
| `nix run .#mac-builder-readiness` (default LAN forward `127.0.0.1:2222`) | environment-blocked: connection refused at `check 1/3: ssh`; no Lima instance on this host |
| `nix flake check --show-trace` | environment-blocked: `checks.aarch64-linux.ast-grep-mcp` fails inside the Nix build sandbox with `Could not resolve host: github.com` (no network in the build sandbox); unrelated to this task |
| `nix build .#checks.aarch64-linux.fabro-darwin-builds` | environment-blocked: the same network isolation when `builtins.getFlake` refetches the locked nixpkgs inside the build sandbox |

The direct language-level suite runs with network access and is the evaluable
form of the `fabro-darwin-builds` check on this host.

## Operator completion

These are the observations this record cannot produce. Run them from a host
that can reach the tailnet and the Lima instances, in the apply order from
`configurations/mac-builder/README.md`.

1. **Builder** — `nix run '.#mac-builder-deploy'`, then on the builder confirm
   `tailscale status --json` lists `tag:mac-builder` and
   `launchctl print system/org.nixos.mac-builder-tailscale-auth` is loaded.
   Expected: the node joins from the OAuth credential with no interactive
   login.
2. **Endpoint** — `nix run '.#mac-builder-readiness'` (default `127.0.0.1:2222`
   LAN forward). Expected: three checks pass.
3. **Guest** — `lima-vm-deploy`, then confirm
   `sudo stat -c '%a %U %G' /run/fabro-darwin-builders/machines` is
   `600 root root`, `sudo wc -l` is `1` with an `aarch64-darwin` entry, and
   `systemctl status fabro-darwin-builders` plus `systemctl status nix-daemon`
   show the renderer ran and the daemon restarted. Build any `aarch64-linux`
   derivation and confirm it still runs on the guest.
4. **Smoke** — `sudo fabro-darwin-build-smoke` and confirm the printed store
   path exists in the guest store (`nix path-info`), then run
   `nix build --no-link <same derivation>` inside a sandbox and confirm the
   sandbox resolves the same output without a workflow change.

Until these observations are recorded here, this record claims no live
tailnet-join, guest-switch, or sandbox-store evidence, and requirements 1.4,
1.5, 3.1, 3.2, 6.6, and 8.6 are only partially observed.
