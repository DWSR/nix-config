# Gap Analysis: local-binary-cache

## Analysis Summary

- Brownfield integration with reusable Nix settings, SOPS, launchd, queue-locking, and render-test patterns; the cache lifecycle itself is net new.
- Attic is the best fit for independently retained compressed artifacts, scoped publication, signing, and age-based cache GC on `aarch64-darwin`.
- The critical workflow gap is a non-blocking publication queue whose entries are also Nix GC roots.
- LAN TLS and Nix signing are separate trust planes; the Nix daemon needs a combined public/private CA bundle plus the cache's Nix public key.
- Effort L, risk Medium: several new root-service contracts, but primary mechanisms and failure modes are known.

## Current State Investigation

### Reusable assets

| Asset | Existing location | Reuse |
|---|---|---|
| Additive substituters and keys | `configurations/common-darwin/default.nix:52-72` | Preserve official, community, and Shopify caches while adding the LAN cache. |
| Automatic Nix GC and optimize | `configurations/common-darwin/default.nix:45-50,74-77` | Override host schedules and add pressure thresholds. |
| System SOPS secrets | `configurations/personal/default.nix:28-46`, `.sops.yaml:21-41` | Deliver server auth, TLS key, and per-host publication tokens by path. |
| Long-running launchd shape | `home-manager/mcp/default.nix:554-603` | Reuse absolute arguments, `RunAtLoad`, `KeepAlive`, and logs at the system-daemon layer. |
| Serialized worker pattern | `scripts/sqlite-backup-cli.nix:219-249` | Reuse atomic lock and cleanup behavior. |
| Host and fixture checks | `flake.nix:997-1118`, `tests/personal-tailscale-service/hm-render.test.js` | Evaluate both live hosts and isolated invalid/edge fixtures. |
| Secret-absence check | `tests/opencode-nono/integration/hm-render.test.js:187-245` | Prove generated files contain secret paths, not secret values. |

### Missing capabilities

- No Attic package pin, server, cache identity, object storage, database, reverse proxy, private CA, publication hook, queue, publisher, health probe, or cache-specific checks.
- No custom root launchd daemon pattern exists; existing examples are user agents.
- `post-build-hook` is a scalar Nix setting. Any existing or externally included hook must be detected or explicitly chained.
- Shopify includes externally owned `/etc/nix/nix.conf.d/shopify.conf`; effective daemon settings need runtime verification because later includes can override scalar values.

## Requirement-to-Asset Map

| Requirement | Existing asset | Gap |
|---|---|---|
| R1 Personal cache | SOPS and launchd patterns | Missing server, storage, cache bootstrap, TLS proxy, signing identity, readiness. |
| R2 Publication | Atomic lock/rename patterns | Missing post-build enqueue, deterministic roots, serialized retry worker, per-host token config. |
| R3 Both-host consumption | Additive substituters/keys | Missing URL, CA trust, cache public key, priority, fallback, negative-cache tuning. |
| R4 Access/secrets | System-level SOPS | Missing four secret classes and operator bootstrap/rotation workflow. |
| R5 Retention/GC | Shared GC/optimize declarations | Missing host-specific schedules, pressure values, 30-day cache GC, queue-root coordination. |
| R6 Resilience | KeepAlive/log patterns | Missing system daemons, health contract, bootstrap guard, queue status. |
| R7 Verification | Nix/Node host checks | Missing server/client render, queue behavior, invalid config, and secret non-vacuity fixtures. |

## External Findings

### Attic status and Darwin support

- Upstream has no formal releases and labels itself an early prototype, but current development is active. Pin an exact source revision rather than a moving branch.
- Attic and nixpkgs declare `aarch64-darwin` support; upstream CI builds client and server on macOS.
- SQLite with one server instance is appropriate for two hosts. Concurrent uploads have open pool failures; clients should push with one job and publisher workers should serialize access.
- `attic watch-store` has unresolved macOS descriptor, memory, and long-running crash reports. It is not suitable for this feature.
- Sources: [Attic repository](https://github.com/zhaofengli/attic), [macOS issue #107](https://github.com/zhaofengli/attic/issues/107), [worker issue #226](https://github.com/zhaofengli/attic/issues/226), [SQLite issue #215](https://github.com/zhaofengli/attic/issues/215).

### Post-build hook and queue roots

- Nix 2.34 and Lix 2.95 invoke `post-build-hook` after executed derivation builds with `DRV_PATH` and space-separated `OUT_PATHS`. Substituted paths do not trigger it.
- The root daemon runs the hook as root. Concurrent Nix client connections can overlap hook invocations.
- A nonzero hook result fails the current realization after outputs are registered. Network work must not occur in the hook; failure to record a durable local queue entry must remain fatal.
- A directory of deterministic indirect roots can serve as both queue and retention state:

  ```text
  /var/lib/local-binary-cache/pending/<store-hash> -> /nix/store/<hash>-<name>
  ```

- `nix-store --add-root <path> --realise <output>` performs atomic root replacement. One root per output makes duplicate enqueue idempotent. The publisher unlinks the root only after confirmed upload or cache presence.
- Sources: [Nix post-build-hook](https://nix.dev/manual/nix/2.34/command-ref/conf-file.html#conf-post-build-hook), [Lix post-build-hook](https://docs.lix.systems/manual/lix/stable/command-ref/conf-file.html#conf-post-build-hook), [Nix add-root](https://nix.dev/manual/nix/2.34/command-ref/nix-store/realise.html#opt-add-root).

### Cache bootstrap and secret boundaries

- Cache creation generates the Nix signing keypair and stores it in SQLite. The public key must be captured from `attic-cache-info` and committed to client trust configuration.
- Anonymous public-cache access grants pull only. Each publisher can use a distinct push-only token because public pull permission is merged into authenticated requests.
- Client configuration supports `token-file`; avoid `attic login`, which persists an inline token.
- The server cannot read its JWT signing secret directly from a file. A runtime wrapper must read the SOPS path into the environment before `exec`, or the server must hold only an RS256 public key while `atticadm` uses the private key offline.
- Do not auto-create a missing cache. Database loss otherwise generates a new Nix signing identity that clients do not trust.
- Sources: [Attic config](https://github.com/zhaofengli/attic/blob/main/server/src/config.rs), [cache CLI](https://github.com/zhaofengli/attic/blob/main/client/src/command/cache.rs), [client token-file](https://github.com/zhaofengli/attic/blob/main/client/src/config.rs), [secret-file gap #331](https://github.com/zhaofengli/attic/issues/331).

### LAN TLS and Nix trust

- Attic listens on loopback; a lightweight proxy terminates TLS for `Brandons-MacBook-Pro.local`.
- The leaf certificate needs a `DNS:Brandons-MacBook-Pro.local` SAN and `serverAuth`. The CA private key stays offline; the leaf key is SOPS-delivered.
- `security.pki.certificateFiles` appends the private CA to the normal public bundle at `/etc/ssl/certs/ca-certificates.crt`. `nix.settings.ssl-cert-file` must reference that combined bundle, not the private CA alone.
- Cache TLS trust does not replace NAR signing trust. Keep signature verification enabled and append the Attic public key separately.
- Caddy and nginx build on `aarch64-darwin`; Caddy needs less request-buffering configuration. Neither has a nix-darwin service module.
- Sources: [nix-darwin PKI module](https://github.com/LnL7/nix-darwin/blob/master/modules/security/pki/default.nix), [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls), [Apple local hostnames](https://support.apple.com/guide/mac-help/mchlp2322/mac).

### Fallback, preference, and cache freshness

- Add the LAN URI through `extra-substituters`; replacing `substituters` can remove official, community, or Shopify caches.
- Nix chooses lower cache priority values first. The local cache needs a value below `cache.nixos.org`'s advertised `40`.
- `fallback = true` permits broken/TLS-failed downloads to continue to another substituter or local compilation.
- Negative narinfo results default to a one-hour cache. A shorter negative TTL is needed so an asynchronously published output becomes discoverable within Requirement 3's five-minute bound.
- Connection timeout settings differ between Nix 2.34 and Lix 2.95 and are global. Avoid aggressive timeout tuning until measured.

### Garbage collection semantics

- `--delete-older-than 7d` deletes old profile generations, then collects all unreachable store paths. It does not age-filter arbitrary paths.
- `min-free` triggers pressure GC; `max-free` is its target. Both must be nonzero with `max-free > min-free` or Nix can attempt to collect all available garbage.
- Pressure GC does not delete profile generations. Scheduled and pressure GC serialize on the global GC lock and honor pending-output roots.
- Attic storage is not reclaimed or deduplicated by Nix GC. Cache GC is age-based and has no byte quota.
- A launchd `StartCalendarInterval` with only `Weekday` set fires for every matching minute. Both current Sunday-only jobs need explicit hour and minute fields to mean once weekly.

## Implementation Approach Options

### Option A: Extend host defaults

Put cache services, scripts, and settings directly in common/personal/Shopify defaults.

- Pros: fewer new files; direct host visibility.
- Cons: mixes server, publisher, trust, and GC lifecycles into broad modules; weak fixture isolation.

### Option B: New monolithic system module

Create one root module owning server, proxy, publication, consumer, secrets, GC, and tests.

- Pros: one feature boundary; central validation.
- Cons: one large module with platform scripts and host-specific branches.

### Option C: Hybrid system module and scripts

Create a typed root module for contracts and launchd wiring, focused queue/bootstrap/publisher scripts, and minimal host configuration.

- Pros: isolates mutable workflows, reuses repository patterns, supports pure render tests and shell behavior tests.
- Cons: more files and explicit interfaces.

## Effort and Risk

- **Effort: L (1–2 weeks)** — new server, TLS, queue, bootstrap, two-host trust, secret, GC, and test contracts.
- **Risk: Medium** — upstream is early-stage and bootstrap is partly manual, but Darwin support and each integration mechanism are verified.

## Research Needed for Design

- Select concrete `min-free` and `max-free` values for the personal host.
- Select TLS listener port and service identities; `8443` permits an unprivileged proxy while `443` requires privilege.
- Verify the effective Shopify `post-build-hook` after its external Nix include and define an explicit conflict response.
- Decide whether the Attic JWT private signing key is loaded by the server or kept operator-only with RS256 public verification.
- Define runtime smoke checks for mDNS hostname, certificate SAN, live cache public key, queue age, and cache fallback.

## Recommendations for Design

- Prefer Option C.
- Treat the root symlink spool as the queue source of truth.
- Keep Attic loopback-only behind LAN TLS and use the combined nix-darwin CA bundle.
- Separate declarative runtime state from one-time cache/token bootstrap and document recovery after cache identity loss.
- Give both GC and optimize jobs complete calendar intervals.

---

## Design Synthesis

### Generalization

- Server, publisher, and consumer are capabilities of one typed nix-darwin module, not three host-specific implementations. Only the two required host compositions are implemented.
- A pending root is both queue record and GC-retention record. A separate queue database or journal would duplicate state and introduce consistency races.
- TLS identity, Attic API authorization, and Nix artifact signing remain three explicit trust contracts rather than one generic "cache credential" abstraction.

### Build vs. Adopt

- Adopt the Attic client/server already pinned by `nixpkgs-unstable`; its nixpkgs recipe pins an exact upstream revision, avoiding a new flake input.
- Adopt Caddy for TLS termination and nix-darwin `security.pki` for the combined CA bundle.
- Build only the enqueue, serialized publisher, bootstrap/verify, and status scripts because Attic's watcher is unsuitable and no existing package owns the GC-root queue contract.

### Simplification

- Use the existing login user as the unprivileged Attic/Caddy service identity instead of introducing Darwin UID allocation. The root publisher remains separate.
- Serve on `8443` to avoid privileged port ownership. The explicit port is part of the endpoint contract.
- Keep the Attic JWT private key operator-only; `atticd` receives only the RS256 public verification key. This removes a server runtime secret.
- Do not add cache backup, quota enforcement, remote builds, a generic reverse-proxy module, or automatic cache recreation.

## Design Decisions

### Decision: Hybrid module and script boundary
- **Selected**: A typed system module owns configuration and launchd wiring; focused scripts own mutable workflows.
- **Rationale**: Root daemon settings and host evaluation remain testable while queue behavior can be exercised independently.

### Decision: Staged bootstrap
- **Selected**: Bootstrap mode starts Attic and TLS without enabling consumers or publishers. An operator creates the cache, captures its public key, issues host tokens, imports them into SOPS, then enables ready mode.
- **Rationale**: Attic generates the Nix signing identity in SQLite; automatic recreation would silently invalidate client trust.

### Decision: Balanced disk policy
- **Selected**: Personal Nix GC daily at 03:15 with seven-day generation retention; Shopify GC Sunday at 03:15; optimization Sunday at 04:15; Attic retention 30 days with 12-hour internal GC. `min-free` and `max-free` remain optional typed settings and are initially unset.
- **Rationale**: The user chose to measure before activating pressure thresholds. The module enforces paired nonzero values with `max-free > min-free` when later enabled.

### Decision: Cache freshness and priority
- **Selected**: Cache priority `30`, `fallback = true`, and negative narinfo TTL `60` seconds.
- **Rationale**: The local cache precedes `cache.nixos.org` priority `40`, outages degrade to existing paths, and asynchronous uploads become discoverable within Requirement 3's five-minute bound.

## Design Risks and Mitigations

- Attic source churn — use the nixpkgs-pinned revision and revalidate schema/CLI on package changes.
- SQLite upload contention — one publisher process per host, `-j 1`, idempotent roots, durable retry.
- mDNS hostname collision — certificate/readiness checks compare the exact hostname and SAN.
- Shopify external hook override — render the wrapper after includes and fail activation when an undeclared external hook would be replaced.
- Cache identity loss — keep clients on upstream fallback and require explicit rebootstrap plus trust-key update.
- Long-lived push credentials — use separate one-year cache-scoped tokens in SOPS; global JWT-key rotation remains the immediate revocation path.

## Design Validation Findings

- Attic behind a proxy needs explicit `allowed-hosts`, `api-endpoint`, and `substituter-endpoint` values matching the LAN TLS origin.
- Public/private TLS and JWT pairs must exist before bootstrap services start. Caddy's launch wrapper handles only the SOPS materialization race, not missing provisioning.
- Shopify hook conflict detection must inspect the external include in isolation before the generated final hook masks it. A temporary `NIX_CONF_DIR` provides an executable check.
- Upstream filtering is limited to configured public cache identities. Shopify-private substitutions bypass the hook, while private-cache identity/configuration remains externally owned.
- Both hosts consume the cache in ready mode. This is required for Shopify-first builds to be reusable by personal after its store copy is absent.
