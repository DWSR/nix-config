# Brief: mac-builder-for-fabro-nix-darwin-builds

## Problem

> As a Fabro operator, I want Fabro runs to use the mac-builder for Nix builds for Darwin so that Darwin-specific checks, builds, etc. can be done in Fabro runs
>
> The runs must:
>
> * communicate to the mac-builder VM over Tailscale so that ACLs/tags/etc. can work properly
> * continue to use the Fabro host's nix daemon and store rather than a per-container one
>
> The mac-builder host must:
>
> * use existing Nix distributed build functionality rather than creating something new and bespoke
> * use public caches (e.g. cachix) rather than any existing private build/binary cache
> * use the opensource tailscale with an oauth key instead of the tailscale app
> * be configured with nix-darwin/home-manager

Fabro runs execute in `aarch64-linux` sandboxes on `fabro-vm`, and their Nix calls end at
that guest's daemon, which knows only `aarch64-linux`. A workflow step that builds or checks
Darwin output stops at a platform mismatch, so agents cannot verify Darwin work where they
run.

## Current State

- `configurations/mac-builder/default.nix` (`darwinConfigurations.mac-builder`, `flake.nix:3223`)
  is an `aarch64-darwin` nix-darwin host: `nix.enable`, `trusted-users = [ "nix-builder" ]`,
  OpenSSH without password auth, a hidden `nix-builder` user (uid 502), and a store
  (`secrets/remote-builder.mac-builder.yaml`) holding only `builder-authorized-keys`.
- The personal host runs it as a Lima macOS guest (`home-manager/common/lima-mac-guest.nix`,
  `configurations/personal/home-manager/default.nix:252`) with a launchd supervisor and an
  SSH forward on `0.0.0.0:2222` that `mac-builder-deploy` and `mac-builder-readiness` use.
- The builder joins no tailnet: no `services.tailscale`, no tailscale package, no OAuth
  credential. The LAN forward is its only reachable path.
- `fabro-vm` is a tagged tailnet node (`tag:fabro`, `tuxedo-musical.ts.net`) registered with
  an OAuth secret (`configurations/fabro-vm/tailscale.nix`).
- The guest's Nix settings (`configurations/fabro-vm/default.nix:367`) hold only experimental
  features and `trusted-users = [ "@wheel" ]`: no build machines, builder identity, or
  substituters; `nix.distributedBuilds` is off, so the daemon ignores `/etc/nix/machines`.
- Sandboxes already get the guest's `/nix/store` read-only and the daemon socket from the
  engine-level `containers.conf`, with `NIX_REMOTE=daemon` in the image
  (`configurations/fabro-vm/sandbox.nix:199`); all run-side Nix traffic ends at the daemon.
- The builder declares no substituters or trusted keys beyond Nix defaults and has no link
  to the private `local-binary-cache`/Attic.

## Desired Outcome

- A Fabro run builds and checks `aarch64-darwin` derivations from its existing sandbox with
  no workflow change; outputs land in the guest store and resolve for the sandbox.
- The run's build traffic leaves the guest as the `fabro-vm` tailnet node, so tailnet tags
  and ACLs decide whether the builder is reachable.
- Sandboxes keep exactly one Nix: the guest's daemon and store. No container runs its own
  daemon, keeps its own store, holds a builder key, or joins the tailnet.
- The builder joins the tailnet with the open-source client and an OAuth credential and
  serves the stock `ssh-ng` remote-builder and store protocol.
- The builder substitutes from public caches only.

## Approach

- Make the guest's Nix daemon the only distributed-build client: `nix.distributedBuilds = true`
  with one `nix.buildMachines` entry for `aarch64-darwin` — `hostName` the builder's
  tailnet name, `sshUser = "nix-builder"`, `protocol = "ssh-ng"`, job and speed limits, and
  the builder host key pinned. Building in the daemon preserves the sandbox's
  `NIX_REMOTE=daemon` contract and lands outputs in the store the sandbox mounts.
  `builders-use-substitutes = true` lets the builder fetch inputs from its own public
  substituters instead of importing them from the guest store.
- Trust: the fabro store gains a builder client key rendered to a root-only runtime path and
  referenced by path (never by value) in `/etc/nix/machines`, plus the builder host key; the
  builder store adds the matching public key to `builder-authorized-keys`. The builder's
  `trusted-users = [ "nix-builder" ]` already admits the daemon's requests.
- Tailscale on the builder: `services.tailscale.enable` (launchd `tailscaled`, MagicDNS
  resolver), the OAuth secret in the builder store, and a launchd authentication step running
  `tailscale up` with it and the advertised tag, since nix-darwin exposes no auth-key option.
- Public caches on the builder: explicit public substituters with their trusted keys, no
  private cache URL or key.
- Verification: eval checks over both hosts (build machines entry, SSH user and system,
  tailscale service and tag, authorized key, no secrets in rendered files, no per-container
  Nix wiring) and a runtime smoke that builds a trivial `aarch64-darwin` derivation from a
  sandbox and asserts the store path lands in the guest store.

Rejected: a per-run tailnet sidecar or direct sandbox-to-builder remote store (each
container gets its own Nix identity and store, contradicting the host-daemon requirement);
a bespoke build service (the issue requires stock Nix distributed builds); exposing the
builder through the personal host's tailnet node (puts the ACL on the wrong node).

## Scope

- **In**: builder tailnet membership (package, launchd daemon, OAuth step, dedicated tag,
  OAuth secret in the builder store); guest distributed-build settings (build machines,
  `builders-use-substitutes`); builder trust material on both sides (client key, pinned host
  key, authorized key); public substituter configuration on the builder; declarative checks
  and the sandbox-side Darwin build smoke; the required tailnet ACL grant documented.
- **Out**: client wiring outside `fabro-vm` (personal host, CI); publishing Darwin outputs to
  a public cache, cachix account or token; per-run or per-workflow builders, pools, load
  balancing, or scheduling policy; sandbox image contents and mounts; builder configuration
  beyond tailscale, caches, and trust; retiring the LAN forward used by deploy and readiness.

## Boundary Candidates

- Builder tailnet membership: tailscaled under launchd, OAuth authentication, tag, secret.
- Guest distributed-build settings: build machines entry, job limits, substitution policy.
- Builder trust plumbing: client key, host-key pinning, authorized key, both secret stores.
- Public cache policy on the builder.
- Declarative and runtime verification.

## Out of Boundary

- Publishing Darwin build results to a public cache; any cachix account, token, or push hook.
- Tailnet ACL, tag, and DNS administration beyond documenting the grant the fabro node needs;
  the console owns policy.
- `x86_64`, Linux, or additional Darwin builders; CI runner capacity.
- Distributed builds and cache publication on the personal host (its publisher assertion
  `nix.distributedBuilds = false` stands), and Home Manager on the builder host (no
  interactive login user; it stays nix-darwin only).

## Upstream / Downstream

- **Upstream**: `mac-nix-remote-builder` (builder host, Lima guest, deploy, readiness); the
  fabro-vm sandbox daemon and store sharing (`nix-built-container-for-default-fabro-environmen`);
  the fabro-vm tailnet node and its OAuth client; sops per-host stores.
- **Downstream**: workflows and checks that build or verify Darwin output, such as a
  `nix flake check`-style gate covering `aarch64-darwin`; eventual dedicated Apple hardware
  behind the same endpoint.

## Existing Spec Touchpoints

- **Extends**: none; `mac-nix-remote-builder` excluded client dispatch and tailnet exposure.
- **Adjacent**: `mac-nix-remote-builder` (endpoint contract, `builder-authorized-keys`,
  readiness checks); `nix-built-container-for-default-fabro-environmen` (image environment,
  daemon socket and store mounts); `local-binary-cache` (private cache, personal-host
  distributed-build assertion); `personal-tailscale-service` (macOS app path this spec
  deliberately does not use).

## Constraints

- `aarch64-darwin` only; the builder's daemon serves its own system without `extra-platforms`.
- The builder uses the open-source `tailscale` client with an OAuth credential; the macOS app
  path is neither available nor wanted there.
- Tailnet ACLs are console-owned: access from `tag:fabro` to the builder's SSH port must be
  granted and documented, and the guest must resolve the builder by tailnet name rather than
  the LAN forward or a DHCP address; the repo cannot verify reachability offline.
- The guest daemon runs as root: the client key lives at a root-only path outside the Nix
  store, the sandbox image, and the machines-file body. No secret value enters the Nix store,
  and the guest store gains only the builder public key.
- Sandbox wiring must not change: `NIX_REMOTE=daemon`, read-only `/nix/store`, daemon socket.
- The builder never reads or pushes to the private cache; public substituters only.
- `nix.distributedBuilds = true` is required for `/etc/nix/machines` to be consulted, since
  this nixpkgs nulls `builders` when the option is false.
