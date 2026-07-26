# Brief: local-binary-cache

## Problem

> Create a spec for running a lightweight Nix binary cache (such as attic) on the personal host and pointing the shopify laptop at it. The intention is to reduce recompilation and bandwidth use when making changes common to multiple hosts. The spec should also encompass tuning the nix garbage collection to account for the fact that a second copy of packages will remain on the host in the form of cache contents.

Both nix-darwin hosts independently rebuild outputs that are absent from upstream caches. The personal host has no retained binary-cache copy, so its weekly Nix GC can remove outputs before the other host reuses them.

## Current State

Both hosts append `nix-community.cachix.org` to the default Nix substituters and trust its signing key. They have no local cache server, publication hook, distributed builder, or cache signing lifecycle. Shared GC and store optimization use Sunday-only launchd intervals with omitted time fields, which are wildcards rather than once-weekly schedules. GC uses `--delete-older-than 7d`. The personal host has SOPS, launchd, and LAN/mDNS service precedents.

## Desired Outcome

The personal host retains locally unique build outputs in a signed Attic cache that survives `/nix/store` GC. Both hosts publish completed local builds asynchronously and prefer the local cache while preserving upstream fallback, and cache retention plus personal-host Nix GC bound duplicate disk use without reducing the seven-day rollback window.

## Approach

Run pinned `atticd` on `Brandons-MacBook-Pro` as a launchd-managed system service with SQLite and local object storage. Terminate LAN TLS at a lightweight reverse proxy for `Brandons-MacBook-Pro.local`; distribute the public CA certificate declaratively and keep private keys and scoped push tokens in per-host SOPS secrets.

Each host uses a fast Nix post-build hook that atomically queues local output paths and creates temporary GC roots. A serialized launchd worker drains the queue with `attic push -j 1`, retries durably, and removes roots only after successful publication. The cache allows anonymous pull over TLS, filters outputs already available from configured public upstream caches, and retains unique artifacts for 30 days.

Run personal-host Nix GC daily with `--delete-older-than 7d` and optional configurable disk-pressure thresholds. Give ShopifyLaptop an explicit once-weekly time while preserving its seven-day retention.

## Scope

- **In**: Attic package pin, personal server/storage/database, LAN TLS, cache bootstrap and signing trust, one-year per-host scoped push credentials, asynchronous publication queues, both-host substituter/fallback, 30-day Attic GC, daily seven-day personal Nix GC, optional disk-pressure settings, launchd health/retry behavior, and evaluation/render checks.
- **Out**: Distributed or remote builds, public internet exposure, Tailscale transport, PostgreSQL/HA, cross-architecture caches, general artifact storage, and preserving dependencies already available from configured public upstream caches.

## Boundary Candidates

- Personal cache service, storage, TLS endpoint, and cache lifecycle.
- Per-host non-blocking publication queue and temporary GC roots.
- Shopify daemon-level substituter, CA trust, signing trust, and fallback.
- Coordinated Attic retention and personal-host Nix GC.
- Declarative validation and runtime smoke checks.

## Out of Boundary

- SSH builders, `nix.buildMachines`, and remote execution.
- Attic `watch-store`; queued publication is required because of unresolved macOS stability issues.
- Cache database/object backups as durable data; cache loss is recoverable by rebuilding and re-bootstrapping trust.
- Automatic certificate-authority rotation or public ACME issuance.
- Changes to Shopify-managed `/etc/nix/nix.conf.d/shopify.conf`.

## Upstream / Downstream

- **Upstream**: nix-darwin Nix daemon settings, SOPS secret delivery, launchd, mDNS, existing upstream substituters, and the pinned aarch64-darwin package set.
- **Downstream**: Faster second-host rebuilds, future cache observability or backup work, and a separate distributed-build spec if remote execution is later desired.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `personal-tailscale-service` owns tailnet-private exposure and remains unchanged; `sqlite-backup` provides service/queue patterns but does not back up this disposable cache; `mcp-secrets-sops-nix` and `deskflow-config` provide SOPS and LAN TLS precedents.

## Constraints

- Pin Attic to a tested revision because upstream has no formal releases and labels itself an early prototype.
- Support `aarch64-darwin` and launchd without relying on the upstream NixOS module.
- Serialize SQLite-facing uploads and avoid `attic watch-store`.
- The Nix post-build hook must enqueue quickly, never perform network I/O, and not fail a completed build because the cache is unavailable.
- Pending paths remain GC-rooted until uploaded; cache GC and host GC must not race publication.
- JWT secrets, TLS private keys, and server authentication secrets must not enter the Nix store.
- Cache unavailability must not prevent builds from falling back to existing substituters or local compilation.
