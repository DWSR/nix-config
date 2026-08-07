# Requirements Document

## Introduction

The `local-binary-cache` feature shares locally produced Nix outputs between the two macOS hosts while bounding duplicate storage on the personal host. See `brief.md` for the problem, selected approach, and scope.

## Boundary Context

- **In scope**: A signed LAN-TLS binary cache on `Brandons-MacBook-Pro`, asynchronous publication and consumption from both hosts, upstream fallback, cache retention, personal-host Nix GC tuning, secret delivery, and verification.
- **Out of scope**: Remote builds, public internet or Tailscale exposure, PostgreSQL or high availability, cross-architecture artifacts, durable cache backup, and retaining outputs already available from configured public upstream caches.
- **Adjacent expectations**: LAN/mDNS connectivity, per-host SOPS decryption, and existing upstream substituters remain available. Shopify's Nix installation is vanilla upstream under nix-darwin ownership; the Shopify-managed `nix.conf.d/shopify.conf` include remains externally owned.

## Requirements

### Requirement 1: Personal binary cache
**Objective:** As the personal host owner, I want a local binary cache, so that locally unique build outputs remain reusable after Nix store garbage collection.

#### Acceptance Criteria
1. When `Brandons-MacBook-Pro` starts, the Local Binary Cache shall make its configured cache available without an interactive user login.
2. The Local Binary Cache shall serve cache metadata signed by the configured cache identity.
3. The Local Binary Cache shall expose its read endpoint over TLS using the declared LAN hostname.
4. The Local Binary Cache shall retain cache storage independently from the personal host's `/nix/store`.
5. The Local Binary Cache shall exclude outputs already available from configured public upstream caches from local retention.

### Requirement 2: Non-blocking publication
**Objective:** As the owner of both hosts, I want locally built outputs published automatically, so that the second host can reuse whichever host built first.

#### Acceptance Criteria
1. When either host completes a local build, the Cache Publisher shall record the produced output paths for publication without waiting for network upload.
2. While output paths are pending publication, the Cache Publisher shall protect those paths from host Nix garbage collection.
3. When pending outputs are published successfully, the Cache Publisher shall remove their pending records and temporary retention state.
4. If the cache endpoint or LAN is unavailable, the Cache Publisher shall preserve pending outputs and retry without failing the completed build.
5. When the same output is recorded more than once, the Cache Publisher shall avoid creating conflicting publication state.
6. The Cache Publisher shall not republish substituted outputs.
7. If output paths cannot be recorded durably and protected from garbage collection, the Cache Publisher shall fail the current realization with an error identifying the local queue failure.

### Requirement 3: Host cache consumption and fallback
**Objective:** As the owner of both hosts, I want trusted local substitutions preferred over repeated builds, so that common host changes use less build time and upstream bandwidth regardless of build order.

#### Acceptance Criteria
1. When either host requests an output present in the local cache, its Nix daemon shall substitute the signed local copy instead of building it locally.
2. While the local cache is configured, each host's Nix daemon shall retain its existing substituters.
3. If the local cache is unavailable or lacks an output, each host's Nix daemon shall continue with configured upstream substituters or local compilation.
4. If local cache metadata does not validate against the declared cache signing key, the Nix daemon shall reject that substitution.
5. If the LAN TLS certificate does not validate against the declared local certificate authority, the Nix daemon shall reject the connection.
6. When an output is published after a prior local-cache miss, the Nix daemon shall become eligible to query for that output again within 5 minutes.

### Requirement 4: Publication access and secret handling
**Objective:** As the cache operator, I want publication restricted without burdening readers, so that only authorized hosts can add cache contents.

#### Acceptance Criteria
1. The Local Binary Cache shall permit read-only cache access without a publication credential.
2. When either host publishes outputs, the Local Binary Cache shall require a credential scoped to that host and cache.
3. The Local Binary Cache shall use separate publication credentials for `Brandons-MacBook-Pro` and `ShopifyLaptop`.
4. The local configuration shall not place publication credentials, TLS private keys, or server authentication secrets in the Nix store.
5. When a publication credential is replaced, the Local Binary Cache shall preserve the cache signing identity and reader trust configuration.
6. If a required runtime secret is unavailable, the affected cache service or publisher shall fail with an error identifying the missing secret.

### Requirement 5: Coordinated retention and garbage collection
**Objective:** As the personal host owner, I want cache and store retention coordinated, so that the second retained copy does not cause unbounded disk growth.

#### Acceptance Criteria
1. The Local Binary Cache shall retain a locally unique artifact until it has been unused for at least 30 days.
2. When a cache artifact exceeds the retention period, the Local Binary Cache shall make it eligible for cache garbage collection.
3. When personal-host Nix garbage collection runs, it shall delete profile generations older than 7 days and collect unreachable store paths.
4. The personal host shall run Nix garbage collection daily.
5. Where disk-pressure thresholds are configured, the personal host shall use a nonzero minimum free-space threshold and a greater target free-space threshold for Nix store cleanup.
6. While disk-pressure thresholds are unset, the personal host shall preserve the Nix default pressure-GC behavior.
7. While an output is pending publication, host garbage collection shall not delete its final local copy.
8. The Shopify host shall run Nix garbage collection once weekly with the 7-day generation retention period.
9. When store optimization is enabled, each host shall run it once weekly at a time distinct from scheduled garbage collection.

### Requirement 6: Resilience and operator visibility
**Objective:** As the cache operator, I want failures isolated and observable, so that cache problems do not become build outages.

#### Acceptance Criteria
1. If the cache server or TLS endpoint exits unexpectedly, the Personal Cache Service shall attempt to restore availability automatically.
2. If publication fails, the Cache Publisher shall record the failure and the affected pending outputs in operator-readable logs.
3. When the cache server is healthy, the Personal Cache Service shall provide an operator-verifiable health result.
4. If cache state is lost, both hosts shall remain able to use upstream substitutes and local builds.
5. If required cache identity has not been bootstrapped, the Personal Cache Service shall not advertise an unsigned cache as ready.
6. When a controlled outage procedure reaches its recovery step without interruption, the Outage Verification shall restore the stopped service and verify its health.
7. If a controlled outage procedure is interrupted while a service is stopped, the Outage Verification shall report that manual service recovery is required.
8. While a service remains stopped after an interrupted outage procedure, the Outage Verification shall reject a new outage run.
9. If a bounded publisher invocation is interrupted, the Outage Verification shall terminate and reap that invocation before returning control to the operator.

### Requirement 7: Declarative verification
**Objective:** As the repository maintainer, I want cache behavior checked from both host configurations, so that trust, fallback, publication, and GC policy do not drift silently.

#### Acceptance Criteria
1. When repository checks evaluate `Brandons-MacBook-Pro`, they shall verify the personal cache service, publication behavior, TLS endpoint, 30-day cache retention, and daily seven-day Nix GC policy.
2. When repository checks evaluate `ShopifyLaptop`, they shall verify local substituter preference, signing trust, TLS trust, upstream fallback, and publication behavior.
3. When publication fixtures contain duplicate or failed entries, repository checks shall verify idempotent retention and retry behavior.
4. When rendered service definitions are inspected, repository checks shall verify that secret values are absent.
5. If either host's required cache endpoint, trust key, retention policy, or publication scope is missing, repository checks shall fail.
6. When repository checks exercise controlled outage interruption, they shall verify manual recovery guidance and rejection of retries until service health is restored.
