# Brief: shopify-remote-builder

## Problem

> Build a spec to use the personal host as a Nix remote builder for the Shopify host. The personal host should push the build contents both to the local binary cache as well. There must also be some safeguard to only build publicly available packages and not Shopify-private ones as the personal host does not have access.

The owner of `ShopifyLaptop` wants to move selected compilation work to
`Brandons-MacBook-Pro` without accidentally dispatching inputs that require
Shopify credentials or private infrastructure.

## Current State

Both hosts are `aarch64-darwin`. The personal host runs Lix and the shared
Attic cache; the Shopify host runs Tecnix/Nix and consumes and publishes to
that cache. No remote builder, builder SSH identity, or public-build
eligibility policy exists. The cache module currently rejects distributed
builds while publication is enabled.

## Desired Outcome

`ShopifyLaptop` can explicitly request a build of an approved public flake
installable on `Brandons-MacBook-Pro` over the LAN. Eligible sources are
anonymously refetchable by the personal host; dependency closures may instead
be attested by approved signed public caches. Successful personal-host builds
enter the existing local binary-cache publication flow. An ineligible target
or readiness failure detected before the remote commit point falls back to a
local Shopify build. Any failure after that point is reported without a local
retry.

## Approach

Add a guarded public-build command rather than a globally eligible builder.
The command accepts an immutable installable from an allowlisted public flake.
The personal host validates and evaluates it without Shopify credentials,
private substituters, the local Attic cache, or persistent fetch state. A
matching approved derivation then uses the personal Lix daemon as a direct LAN
`ssh-ng://` remote store. The command primes a missing output, always performs
a remote Check rebuild, and copies verified outputs back to Shopify. Eligible
requests therefore run the personal post-build hook; an ineligible request
stays on the Shopify host.

## Scope

- **In**:
  - Explicit guarded builds of immutable, allowlisted public `flake#attr`
    installables
  - Forced rebuilding of the selected eligible output on the personal host
  - Credential-free personal-host eligibility validation with unknown or
    non-anonymous inputs rejected
  - LAN-only Nix remote execution between the two hosts
  - Local Shopify fallback when the target is ineligible or the personal
    builder cannot accept the request
  - Direct reporting of every failure after the remote commit point
  - Personal-host publication of successful remote outputs through the
    existing Attic queue
  - A primary-user-owned Shopify client key, root-owned personal host key,
    host-key trust, diagnostics, and declarative tests
  - Compatibility revalidation and cross-module tests for the existing
    local-cache publication contract
- **Out**:
  - Transparent partitioning of `darwin-rebuild` or arbitrary build graphs
  - Shopify-private packages, repositories, caches, credentials, or endpoints
  - Arbitrary or unlocked flake references
  - Tailscale or public-internet builder exposure
  - Protection against deliberate bypass by a trusted Shopify user or root
  - A custom security broker, VM trust boundary, or pull-only build service

## Boundary Candidates

- Public-installable policy and credential-free eligibility validation
- Per-invocation remote-builder transport, trust, and fallback
- Remote-output handoff to the existing cache publisher
- Declarative host wiring and cross-version verification

## Out of Boundary

- Replacing Attic, its TLS endpoint, retention policy, or publication protocol
- Reclassifying outputs already retained by the local cache
- Automatically discovering public derivations inside a mixed private graph
- Making untrusted flake evaluation safe on either host
- Guaranteeing source availability after the eligibility check completes

## Upstream / Downstream

- **Upstream**: `local-binary-cache`, shared nix-darwin settings, host-scoped
  SOPS secrets, LAN/mDNS connectivity, and public upstream substituters
- **Downstream**: Optional whole-host graph partitioning or a stronger
  personal-side build broker may build on the eligibility contract later

## Existing Spec Touchpoints

- **Extends**: None
- **Adjacent**: `local-binary-cache`; this feature keeps global distributed
  builds disabled and revalidates asynchronous, idempotent publication for the
  direct remote-store path

## Constraints

- The public policy means every source input is anonymously refetchable, not
  merely named like a public package. A dependency may terminate traversal only
  when its complete closure is anonymously available and signed by an approved
  public cache; the target itself receives no such exemption.
- The personal validation path must not trust its normal store or Attic cache,
  because either can contain outputs previously published by Shopify.
- Only trusted, explicitly allowlisted public repositories may be evaluated.
- `ShopifyLaptop` uses Tecnix/Nix 2.34 while `Brandons-MacBook-Pro` uses Lix
  2.95; the design must constrain `ssh-ng://` to worker-protocol operations
  supported by both and require an actual cross-version smoke test.
- The safeguard targets accidental dispatch in the declared workflow. It is
  not an adversarial information-flow boundary.
