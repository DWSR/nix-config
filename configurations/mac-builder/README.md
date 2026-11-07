# Fabro macOS builder tailnet and smoke test

## Tailnet console policy

In the Tailscale admin console, add the following scoped policy entries. They
allow the Fabro guest tagged `tag:fabro` to reach the builder tagged
`tag:nix-remote-builder` on SSH only; `autogroup:admin` owns the builder tag:

```json
{
  "tagOwners": {
    "tag:nix-remote-builder": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:fabro"],
      "dst": ["tag:nix-remote-builder"],
      "ip": ["tcp:22"]
    }
  ]
}
```

Merge these entries into the tailnet policy's existing `tagOwners` and
`grants` objects; preserve the rest of the policy. The grant controls network
reachability only. It does not authenticate or authorize a build session:
SSH client keys authenticate the session, and the client verifies the pinned
SSH host key. Builder Host Tailscale SSH is not used.

### ACL-denial validation

At the live validator's ACL-denial prompt, temporarily replace the SSH grant
above with an ICMP-only grant:

```json
{
  "src": ["tag:fabro"],
  "dst": ["tag:nix-remote-builder"],
  "ip": ["icmp:*"]
}
```

Remove every other matching rule that permits the guest to reach the builder
on TCP/22 for this probe. Grants are additive; the ICMP-only grant does not
override an existing SSH grant.

Retaining ICMP access keeps the builder visible in the guest's peer map and
MagicDNS. Removing all access can hide the builder and produce `Could not resolve
hostname`, which does not prove the required connection-level failure. See
[Tailscale device visibility](https://tailscale.com/kb/1087/device-visibility).

Before confirming the denied-build prompt, verify name resolution from another
host terminal:

```sh
LIMA_HOME="${LIMA_HOME:-$HOME/.local/state/lima}" \
  lima-vmctl shell fabro getent ahostsv4 mac-builder.tuxedo-musical.ts.net
```

At the restoration prompt, restore the original SSH grant and remove the
temporary ICMP-only grant. The recovery build must succeed.

## Builder identity and credential

The builder joins the tailnet as machine `mac-builder`, with MagicDNS name
`mac-builder.tuxedo-musical.ts.net` and tag `tag:nix-remote-builder`. The Fabro guest
uses that MagicDNS name for dispatch. Do not address the guest through the LAN
forward or a DHCP address.

Create a dedicated Tailscale OAuth client for the builder in the admin
console. Give it the `auth_keys` scope and authorize the `tag:nix-remote-builder`
tag. This client is separate from the Fabro guest's OAuth client. The builder
reads its OAuth client secret at runtime from
`/run/secrets/builder-tailscale-oauth-secret`; provision it through the
operator procedure in [`secrets/README.md`](../../secrets/README.md). Do not
put credential values in this documentation.

OAuth enrollment explicitly uses `ephemeral=true` and `preauthorized=true`.
An ephemeral registration is removed immediately on `tailscale logout`, releasing
the machine name for the auth daemon's next enrollment.

For build-key provisioning, follow the “Fabro build-session keys” section in
[`secrets/README.md`](../../secrets/README.md). For rotation, follow its
“Authorized-key rotation” section in the same [runbook](../../secrets/README.md).

## Smoke test

From a running Fabro sandbox, run:

```sh
fabro-darwin-build-smoke
```

The command preflights the builder secret paths and Darwin builder
configuration, requests a trivial `aarch64-darwin` build through the sandbox,
and confirms the resulting store path exists in the Fabro guest's store. It
uses the sandbox image identified by `/run/fabro-sandbox/digest` by default;
an alternate image reference can be supplied as `fabro-darwin-build-smoke
IMAGE_REF`.
