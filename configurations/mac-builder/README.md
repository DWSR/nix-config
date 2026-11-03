# mac-builder (Builder Host)

`mac-builder` is the `aarch64-darwin` Builder Host that serves Fabro's
`aarch64-darwin` builds. The Fabro Guest's `nix-daemon` is the only dispatch
client: it reads a runtime machines file and dials this host over the tailnet
with `ssh-ng`. This document is the operator runbook for the console-side
tailnet change, the builder identity and credential, and the end-to-end smoke
check. The remote-builder endpoint itself (OpenSSH, the `nix-builder` user, the
`builder-authorized-keys` activation) is owned by the `mac-nix-remote-builder`
spec and is unchanged here.

Build-session secrets are provisioned and rotated from the runbook in
[`secrets/README.md`](../../secrets/README.md); this page does not duplicate
that flow.

## How the guest reaches the builder

| Property | Value |
| --- | --- |
| Builder machine name (`--hostname`) | `mac-builder` |
| MagicDNS name the guest dials | `mac-builder.tuxedo-musical.ts.net` |
| Remote-builder port | `tcp:22` (stock sshd, no port override) |
| SSH user | `nix-builder` |
| Scheduled system | `aarch64-darwin` (only) |
| Builder tag | `tag:mac-builder` |

The guest's `fabro.darwinBuilder` module renders
`/run/fabro-darwin-builders/machines` at boot (mode `0600`, root) and sets
`nix.settings.builders = "@<that path>"`. The single line names the tailnet
MagicDNS name and the client key path; the key value never appears in the line
or in the Nix store. `aarch64-linux` requests never match the entry and build
locally on the guest.

The guest never dials the builder through the LAN forward (`127.0.0.1:2222`) or
a DHCP address: both belong to the operator-only `mac-builder-readiness`
endpoint check, never to dispatch. If the builder is moved or re-imaged, update
the tailnet name in `fabro.darwinBuilder.machine.hostName` rather than adding a
LAN or DHCP fallback.

## Console: tag ownership and the grant

Two console-side objects must exist before either host is switched. The
console change comes first; a host switched without it joins the tailnet but
cannot be reached.

1. Create a dedicated Tailscale OAuth client for the builder with the
   `auth_keys` scope and the `tag:mac-builder` tag. It must be a different
   OAuth client from the guest's `tailscale-oauth-secret`, and the tag in its
   scope must match the `tag:mac-builder` the auth daemon advertises.
2. Add the tag owner and the grant below to the tailnet policy file. Replace
   `autogroup:admin` with the group that owns infrastructure tags in this
   tailnet if your policy manages tags through a narrower group.

```json
{
  "tagOwners": {
    "tag:mac-builder": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:fabro"],
      "dst": ["tag:mac-builder"],
      "ip": ["tcp:22"]
    }
  ]
}
```

`tag:fabro` already exists: the guest registers under it from
`configurations/fabro-vm/tailscale.nix`. The grant admits the guest node to the
builder node's sshd port and nothing else; widen it only for a deliberate new
consumer.

The ACL decides reachability only. The SSH keys authenticate the build
session: the guest presents `/run/secrets/build-client-key`, the builder
accepts it only through its `builder-authorized-keys` list, and the guest pins
the builder's host key in `/run/secrets/build-host-key`. Tailnet admission
does not authenticate the build session, so a node the grant admits without an
authorized client key is still refused with `Permission denied (publickey)`.
Tailscale SSH is not enabled on this node, so node identity can never replace
the SSH key.

## Builder identity and credential

| Property | Value |
| --- | --- |
| Node tag joined by the auth daemon | `tag:mac-builder` |
| OAuth scope | `auth_keys` |
| OAuth client | dedicated builder client, separate from the guest's |
| SOPS key | `builder-tailscale-oauth-secret` |
| Runtime path | `/run/secrets/builder-tailscale-oauth-secret` |
| Mode / owner | `0400` `root:wheel` |
| Consumer | `launchd.daemons.mac-builder-tailscale-auth` |
| Store | `secrets/remote-builder.mac-builder.yaml` |

The credential is a dedicated OAuth client, distinct from the guest's
`tailscale-oauth-secret`, and its value is never rendered into the Nix store.
The `mac-builder-tailscale-auth` LaunchDaemon reads the credential path on
every poll and runs the open-source `tailscale` client with:

```sh
tailscale up \
  '--auth-key=<credential>?ephemeral=false&preauthorized=true' \
  --advertise-tags=tag:mac-builder \
  --hostname mac-builder \
  --accept-dns=false
```

`Running` is a no-op; `NeedsLogin`, `NeedsMachineAuth`, and `Stopped` trigger
that `tailscale up`. A missing or empty credential logs the runtime path and
retries without ever running `tailscale up`, so a provisioning gap is visible
in `/var/log/mac-builder-tailscale-auth.err.log` rather than silently joining
as an untagged node.

Provisioning the OAuth credential (1Password item, `sops set`, and the
`sops -d --extract` verification) is documented in
[`secrets/README.md` → Builder OAuth credential](../../secrets/README.md#builder-oauth-credential).

## Build-session keys

Build-session key generation, the two 1Password fields, the sync, the
`builder-authorized-keys` append, and rotation are documented in
[`secrets/README.md` → Fabro build-session keys](../../secrets/README.md#fabro-build-session-keys)
and its "Authorized-key rotation" section. Do not invent a second flow.

| Property | Guest side | Builder side |
| --- | --- | --- |
| Material | `/run/secrets/build-client-key` (private, `0400` root:root) | `builder-authorized-keys` (public halves) |
| Role | Client key presented by `nix-daemon` over `ssh-ng` | Authorized-key list enforced by sshd |
| Pin | `/run/secrets/build-host-key` (builder host public key) | `ssh_host_ed25519_key.pub` |

The builder's activation already fails with the runtime path when
`builder-authorized-keys` is missing or empty; a client key outside that list
is refused. Re-pin `build-host-key` and restart `nix-daemon` after the builder's
host key changes (for example after a re-image), as described in the rotation
section of the secrets runbook.

## Apply order

1. **Console** – create the OAuth client (`auth_keys`, `tag:mac-builder`) and
   apply the `tagOwners` and `grants` snippet above. This comes before any host
   switch.
2. **Secrets** – provision the builder OAuth credential and the build-session
   keys, then append the client public key to `builder-authorized-keys`, all per
   [`secrets/README.md`](../../secrets/README.md). The stores must contain the
   declared keys before the switches, because sops activation fails on a
   missing key.
3. **Builder** – from the repository root on the host that drives the Lima VM,
   run:

   ```sh
   nix run '.#mac-builder-deploy'
   ```

   The app streams the tree into the VM and runs the builder's switch. On the
   builder itself (for example over
   `ssh -F ~/.local/state/lima/mac-builder/ssh.config lima-mac-builder`),
   confirm the node joined under its own tag and that the auth daemon is
   loaded:

   ```sh
   tailscale status --json | nix shell nixpkgs#jq -c jq -r '.Self.Tags[]?'
   sudo launchctl print system/org.nixos.mac-builder-tailscale-auth | head
   ```

4. **Guest** – switch the Fabro Guest with `lima-vm-deploy` from the repository
   root (it runs `nixos-rebuild switch --flake .#fabro-vm` in the guest), then
   confirm on the guest that the renderer produced exactly one line and that
   the daemon restarted:

   ```sh
   systemctl status fabro-darwin-builders
   systemctl status nix-daemon
   sudo stat -c '%a %U %G' /run/fabro-darwin-builders/machines
   sudo wc -l /run/fabro-darwin-builders/machines
   ```

   The file must be `0600 root root` with one line containing
   `aarch64-darwin`. `aarch64-linux` builds still run locally on the guest.

5. **Smoke** – run the Darwin Build Smoke on the guest as root:

   ```sh
   sudo fabro-darwin-build-smoke
   sudo fabro-darwin-build-smoke 'localhost/fabro-sandbox@sha256:<digest>'
   ```

   The optional `IMAGE_REF` argument overrides the default
   `localhost/fabro-sandbox@$(cat /run/fabro-sandbox/digest)` when a specific
   sandbox image should be exercised.

## Darwin Build Smoke

`fabro-darwin-build-smoke [IMAGE_REF]` is installed on the Fabro Guest by the
`fabro.darwinBuilder` module. It proves the sandbox → guest daemon → builder
path and localises a failure to one step:

1. **Preflight** – checks that `/run/secrets/build-client-key` and
   `/run/secrets/build-host-key` are readable and non-empty, and that the
   machines file contains an `aarch64-darwin` entry. Any failure names the
   missing path and exits non-zero.
2. **Build** – starts a sandbox with `podman run --rm <ref> /bin/bash -c
   '<nix build …>'` and requests a trivial `aarch64-darwin` derivation whose
   builder is `/bin/sh` and whose output is a single file. The guest daemon
   schedules it on the builder and lands the output in the guest store.
3. **Report** – confirms the printed store path exists in the guest store and
   prints it. That path must also resolve inside a sandbox, because every
   sandbox mounts the guest store read-only.

The smoke runs on the guest (not inside a workflow) and needs no workflow
change. `mac-builder-readiness` remains the separate LAN-forward endpoint
check for the stock remote-builder service; it is not the dispatch path.

## Failure layers

Each failure names its owning layer:

| Symptom | Layer | Recovery |
| --- | --- | --- |
| Connection failure naming `mac-builder.tuxedo-musical.ts.net` | tailnet reachability | Apply or repair the documented grant |
| `Permission denied (publickey)` | SSH session | Add the client public key to `builder-authorized-keys` |
| Error naming `/run/secrets/build-client-key` | guest material | Provision or rotate the fabro secret |
| Host-key verification failure naming the builder | pinned host key | Re-pin `build-host-key` from the builder |
| Auth daemon log naming `/run/secrets/builder-tailscale-oauth-secret` | builder material | Provision the builder OAuth credential |
| Renderer unit failed, `nix-daemon` still up | guest material | Inspect `journalctl -u fabro-darwin-builders`; local builds continue |

## Related

- [`configurations/mac-builder/default.nix`](./default.nix) – endpoint, user,
  authorized-key activation.
- [`configurations/mac-builder/tailscale.nix`](./tailscale.nix) – membership,
  credential declaration, auth daemon.
- [`configurations/mac-builder/substituters.nix`](./substituters.nix) – public
  caches only, `aarch64-darwin` only.
- [`configurations/fabro-vm/darwin-dispatch.nix`](../fabro-vm/darwin-dispatch.nix)
  – guest dispatch options, renderer unit, machines file.
- [`secrets/README.md`](../../secrets/README.md) – OAuth credential and
  build-session key provisioning and rotation.
