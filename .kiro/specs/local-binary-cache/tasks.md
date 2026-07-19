# Implementation Plan

- [x] 1. Establish the declarative foundation and test harness
- [x] 1.1 Define the core typed cache configuration contract
  - Cover disabled, bootstrap, server, publisher, and consumer capabilities with explicit endpoint, trust, package, secret-path, and state-path inputs.
  - Enforce valid host role combinations, ready-mode public trust, distributed-build exclusion, and paired runtime prerequisites.
  - Add disabled, bootstrap, ready, missing-trust, invalid-role, and distributed-publisher fixtures.
  - Done when valid fixtures evaluate and each invalid combination fails with an option-specific message.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.7, 3.4, 3.5, 4.4, 4.5, 4.6, 6.5, 7.5_
  - _Boundary: Cache Module_

- [x] 1.2 Define retention and garbage-collection policy options
  - Model the 30-day cache retention, 12-hour cache GC interval, and nullable pressure-GC pair.
  - Require paired nonzero pressure values with the target greater than the trigger; preserve Nix defaults while unset.
  - Done when fixtures prove the fixed retention values, null pressure defaults, accepted ordered pair, and rejected partial/zero/reversed pairs.
  - _Requirements: 5.1, 5.2, 5.5, 5.6, 7.5_
  - _Boundary: Cache Module, Retention Policy_

- [x] 1.3 Add isolated render and script test harnesses
  - Provide nix-darwin fixture evaluation plus injectable executable and state paths for script tests.
  - Register separate render and publisher checks in the flake without adding a package input.
  - Done when both empty fixture suites execute hermetically through the flake check entry points.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - _Boundary: Render Tests, Publisher Tests_

- [x] 2. Build publication and operator workflows
- [x] 2.1 Implement the non-blocking enqueue hook
  - Parse all `OUT_PATHS` with glob expansion disabled and reject non-store paths.
  - Create one deterministic indirect root per output and coalesce duplicate enqueue attempts atomically.
  - Fail only when local queue/root state cannot be recorded; perform no DNS, TLS, or cache operation.
  - Done when stub tests pass for multi-output builds, duplicates, invalid paths, and root-creation failure.
  - _Depends: 1.1, 1.3_
  - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 5.7_
  - _Boundary: Enqueue Hook_

- [x] 2.2 Implement the serialized publisher
  - Scan valid pending roots in stable order under a singleton lock and push one target with one upload job.
  - Remove a root only after successful upload or confirmed presence; retain it and stop the batch on failure.
  - Read authentication through a runtime token-file path and emit path-specific, secret-free logs.
  - Done when stubs prove ordering, success cleanup, already-present cleanup, failure retention, and next-run retry.
  - _Depends: 1.1, 1.3, 2.1_
  - _Requirements: 2.3, 2.4, 2.5, 4.2, 4.3, 4.4, 4.6, 6.2_
  - _Boundary: Publisher Job_

- [x] 2.3 Implement bootstrap identity preflight validation
  - Validate externally generated CA/leaf and RS256 keypairs, including the exact mDNS SAN and matching public/private material.
  - Report expected ownership and permissions without generating a CA or persisting plaintext private material.
  - Done when fixtures reject missing SANs, mismatched pairs, unsafe permissions, and absent public artifacts.
  - _Depends: 1.1, 1.3_
  - _Requirements: 1.3, 4.4, 4.6_
  - _Boundary: Bootstrap Tool_

- [x] 2.4 Implement cache bootstrap and token operations
  - Create the public `darwin` cache with priority 30 and official/community public-upstream filters.
  - Capture the cache signing public key and issue distinct one-year, push-only, cache-scoped host tokens.
  - Refuse cache auto-creation in ready mode or when a live/configured signing key differs.
  - Done when command stubs prove visibility, priority, filters, token subjects/scopes/validity, key capture, and identity guards.
  - _Depends: 2.3_
  - _Requirements: 1.2, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5, 6.5_
  - _Boundary: Bootstrap Tool_

- [x] 2.5 Implement redacted status diagnostics
  - Report TLS and cache health, configured/live cache-key equality, effective hooks/substituters, queue count/age, and broken roots.
  - Keep token and private-key contents out of output and logs.
  - Done when fixtures detect each healthy/unhealthy state and poisoned secrets never appear.
  - _Depends: 1.1, 1.3_
  - _Requirements: 3.3, 3.4, 3.5, 3.6, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: Status Tool_

- [x] 3. Add the personal cache runtime
- [x] 3.1 Render the secret-free Attic server configuration
  - Set canonical allowed, API, and substituter endpoints for the LAN TLS origin.
  - Configure loopback listening, SQLite/local storage, RS256 public verification, and 30-day/12-hour retention.
  - Represent the public cache contract without embedding runtime secrets or auto-creating cache identity.
  - Done when the server fixture validates every required field and contains no secret value.
  - _Depends: 1.1, 1.2_
  - _Requirements: 1.2, 1.4, 1.5, 4.1, 4.4, 5.1, 5.2, 7.4_
  - _Boundary: Attic Service_

- [x] 3.2 Add Attic state ownership and launchd supervision
  - Create login-user-owned state/log directories and a pre-login system daemon with absolute arguments.
  - Apply `RunAtLoad`, restart/throttle behavior, and operator-readable logs.
  - Done when the rendered daemon starts independently of login and failure fixtures expose restart/readiness state.
  - _Depends: 3.1_
  - _Requirements: 1.1, 4.6, 6.1, 6.2, 6.3_
  - _Boundary: Attic Service_

- [x] 3.3 Add the LAN TLS proxy service
  - Render explicit TLS on port 8443 with the required hostname, leaf/key paths, loopback upstream, and restricted protocols.
  - Add key preflight, login-user ownership, throttled restart, and secret-free logs.
  - Done when the adapted proxy configuration validates and a missing-key fixture produces the expected diagnostic/retry state.
  - _Depends: 1.1, 2.3_
  - _Requirements: 1.3, 4.4, 4.6, 6.1, 6.3_
  - _Boundary: TLS Proxy_

- [x] 3.4 Integrate bootstrap declaration gating and runtime readiness
  - Keep static evaluation limited to declared artifacts and option invariants; compare the live cache key only at runtime.
  - Render Attic/TLS in bootstrap mode while suppressing consumer and publisher capabilities.
  - Block ready status on TLS, endpoint, or live/configured key mismatch without recreating identity.
  - Done when static and runtime fixtures prove bootstrap isolation, ready success, and mismatch blocking.
  - _Depends: 2.4, 2.5, 3.2, 3.3_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 6.1, 6.3, 6.4, 6.5_
  - _Boundary: Cache Module, Attic Service, TLS Proxy_

- [x] 4. Integrate Nix daemon consumption, hooks, and retention
- [x] 4.1 Install the final post-build wrapper safely
  - Render the wrapper after includes and invoke enqueue exactly once before any explicitly chained hooks.
  - Inspect Shopify's external include in an isolated temporary `NIX_CONF_DIR` before daemon reload.
  - Accept no hook, chain a declared hook once, reject every undeclared hook, and require distributed builds disabled.
  - Done when all three include cases and the single-enqueue wrapper fixture pass.
  - _Depends: 2.1_
  - _Requirements: 2.1, 2.6, 2.7, 7.2, 7.5_
  - _Boundary: Cache Module, Enqueue Hook_

- [x] 4.2 Configure shared TLS trust and both-host cache consumption
  - Append the private CA to the combined public bundle and point each Nix daemon at that bundle.
  - Append the endpoint/signing key, preserve each host's existing substituters, enable fallback, set priority 30, and use a 60-second negative TTL.
  - Keep Shopify's managed include unchanged and subject only its hook value to the conflict contract.
  - Done when personal and Shopify fixtures prove local preference, signing/TLS rejection, fallback, freshness, and preservation of existing caches.
  - _Depends: 3.4_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 6.4, 7.1, 7.2_
  - _Boundary: Cache Module, Consumer Config_

- [x] 4.3 Render host garbage-collection and optimization policy
  - Set personal daily and Shopify weekly seven-day GC with complete calendar fields.
  - Set both optimizers to a distinct weekly time and leave personal pressure values unset by default.
  - Apply validated pressure values only when both are configured.
  - Done when live-host fixtures show exact schedules/defaults and invalid pressure pairs fail.
  - _Depends: 1.2_
  - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.8, 5.9, 7.1, 7.2, 7.5_
  - _Boundary: Retention Policy_

- [ ] 5. Complete staged host integration
- [x] 5.1 Provision prerequisite public and encrypted identities
  - Generate the offline CA/leaf and RS256 pairs outside the bootstrap tool, then validate them through the preflight command.
  - Commit only public CA, leaf, and JWT verifier artifacts; SOPS-encrypt TLS/JWT private material with specified owners and `0400` modes.
  - Add per-host SOPS creation rules and prove no plaintext private material remains.
  - Done when public artifacts validate and poisoned-secret checks see paths but no values.
  - _Depends: 2.3_
  - _Requirements: 1.3, 4.4, 4.6, 7.4_
  - _Boundary: Public Trust Bundle, SOPS Wiring_

- [x] 5.2 Wire the personal host in bootstrap mode
  - Enable server/proxy only and declare system SOPS paths/ownership for the TLS leaf key and operator JWT private key.
  - Keep consumer and publisher disabled until cache identity and tokens are captured.
  - Done when the personal host evaluates in bootstrap mode and both services can resolve their public/key paths.
  - _Depends: 3.4, 4.3, 5.1_
  - _Requirements: 1.1, 4.4, 4.6, 6.1, 6.5, 7.1, 7.4_
  - _Boundary: Personal Host Integration_

- [x] 5.3 Complete the cache bootstrap checkpoint
  - Create `darwin` only after the bootstrap runtime is healthy.
  - Verify anonymous visibility, priority 30, official/community filters, and configured/live cache-key equality.
  - Issue distinct host subjects with push-only `darwin` scope and one-year validity; SOPS-encrypt both tokens and commit the public cache key.
  - Done when bootstrap/API evidence passes and all private material is encrypted-only with correct ownership; live ready-mode status is verified by Task 6.5.
  - _Depends: 2.4, 5.2_
  - _Requirements: 1.2, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 6.3, 6.5_
  - _Boundary: Bootstrap Tool, Public Trust Bundle_

- [x] 5.4 Establish shared publisher runtime integration
  - Build the configured publisher executable from the declared client, endpoint, cache, CA, runtime token path, and pending/state paths without embedding token values.
  - Prepare root-owned state, pending-root, and log paths through the existing symlink-safe activation contract independently of the cache server role.
  - Render a root system daemon with one absolute executable, `RunAtLoad`, the declared 60-second interval, working directory, and separate operator-readable logs.
  - Add an isolated shared publisher-runtime render suite so this task can be reviewed and committed independently of either host-ready task; bootstrap and disabled fixtures shall render no publisher daemon.
  - Done when publisher-enabled personal-role and Shopify-role fixtures render the same shared runtime contract, poisoned secret values remain absent, and focused render/publisher checks pass from a committed baseline.
  - _Depends: 1.1, 1.3, 2.2, 3.2, 4.1_
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 4.2, 4.3, 4.4, 4.6, 5.7, 6.2, 7.1, 7.2, 7.4, 7.5_
  - _Boundary: Cache Module, Publisher Job, Render Tests_

- [x] 5.5 Enable personal consumer and publisher ready mode
  - Declare the root-owned personal token secret and configure local cache consumption, queue/log state, and the final hook.
  - Keep Attic/Caddy state owned by the login user and pressure thresholds unset.
  - Done when the personal configuration evaluates ready with the exact token path, consumer/publisher settings, root publisher daemon, final hook, ownership contracts, and null pressure thresholds.
  - _Depends: 5.3, 5.4_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.2, 4.3, 4.4, 6.2, 7.1_
  - _Boundary: Personal Host Integration_

- [ ] 5.6 Enable Shopify consumer and publisher ready mode
  - Declare the root-owned Shopify token secret and activate trusted local consumption, queue/log state, and the checked final hook.
  - Preserve the managed include and all existing substituters.
  - Done when the Shopify configuration evaluates ready with the scoped token path and unchanged include.
  - _Depends: 5.3, 5.4_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.2, 4.3, 4.4, 6.4, 7.2_
  - _Boundary: Shopify Host Integration_

- [ ] 6. Validate end-to-end integration and recovery
- [ ] 6.1 Complete live-host render and secret-safety coverage
  - Assert both host roles, endpoint, trust, secret paths, service contracts, retention, and schedules.
  - Include poisoned-secret non-vacuity fixtures and required-field failures.
  - Done when both `darwinConfigurations` and all render/security fixtures pass.
  - _Depends: 5.5, 5.6_
  - _Requirements: 7.1, 7.2, 7.4, 7.5_
  - _Boundary: Render Tests_

- [ ] 6.2 Validate the complete hook-to-publisher state flow
  - Exercise enqueue, duplicate coalescing, local failure, remote outage, retained root, retry, and success cleanup through stubs.
  - Prove local durable-state failure blocks the realization while remote cache failure does not affect completed builds.
  - Done when every publication transition and failure contract passes in one integration suite.
  - _Depends: 4.1, 5.4, 5.5, 5.6_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 6.2, 7.3_
  - _Boundary: Publisher Tests_

- [ ] 6.3 Validate reuse in both producer orders
  - After committed ready configurations are active, pause the personal publisher, build a unique output, observe its deterministic pending root, resume publication, and verify logged root removal.
  - Make the personal producer output unreachable, collect its local store path, and substitute the signed cache copy on Shopify without recompilation.
  - Repeat the paused-publisher root observation, logged drain, producer-store collection, and signed substitution flow with Shopify as producer and personal as consumer.
  - Done when both producer orders prove pending-root creation, successful logged drain, producer-store collection, and signed second-host substitution without recompilation.
  - _Depends: 6.1, 6.2_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 5.1, 5.2, 5.3, 5.4, 5.7_
  - _Boundary: Full Feature Integration_

- [ ] 6.4 Validate cache outage fallback and recovery
  - Stop the cache endpoint and verify consumers continue through existing substituters or local compilation.
  - Verify pending roots survive the outage, then restart services and confirm the publisher drains them.
  - Done when captured command evidence shows uninterrupted fallback and successful recovery.
  - _Depends: 6.3_
  - _Requirements: 2.2, 2.3, 2.4, 3.2, 3.3, 5.7, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Full Feature Integration_

- [ ] 6.5 Validate network, trust, and service state
  - Verify mDNS resolution, certificate SAN, configured/live cache key, launchd restart, and effective host hook/substituters.
  - Verify one-year token claims/scopes and absence of plaintext credentials in rendered artifacts or logs.
  - Done when status and host commands report healthy state on both hosts with no secret exposure.
  - _Depends: 6.4_
  - _Requirements: 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5_
  - _Boundary: Full Feature Integration_

## Implementation Notes

- Task 1.1 runtime paths need pure lexical rejection of noncanonical and case-insensitive Nix store aliases; the cache endpoint is the exact origin `https://Brandons-MacBook-Pro.local:8443`.
- Task 1.1's human-directed follow-up removed the remaining Statix W8 warning; focused, formatting, and full flake checks pass.
- Task 2.2 publisher locking must distinguish live ownership from stale PID state; `INT` and `TERM` handlers must exit after cleanup so publication cannot continue without the singleton lock.
- Task 2.3 keypair validation must check private-key consistency and prove RS256 PKCS#1 v1.5 signing; public-key equality alone accepts corrupted or RSA-PSS-restricted keys.
- Task 2.4 bootstrap and ready-mode cache-key validation must use the same canonical 32-byte Base64 grammar as the typed module, including final padding-bit restrictions.
- Task 2.5 read-only probes must disable ambient tool configuration before arguments and suppress parser/helper stderr; otherwise local config or poisoned diagnostics can violate TLS, mutation, and redaction guarantees.
- Task 3.1 Attic state directories need stricter validation than generic runtime paths because whitespace, controls, and URI-reserved characters make SQLite and storage URLs ambiguous.
- Task 3.2 ownership-changing activation must constrain Attic state to its dedicated canonical directory and reject symlinks; configurable system-directory targets can otherwise cause root to retarget broad macOS paths.
- Task 3.3 every dynamic Caddyfile token must be quoted or rejected before rendering; an accepted newline-bearing runtime path can inject additional plaintext listeners even when canonical fixtures validate.
- Task 3.4 runtime fixture injection does not prove module wiring; render tests must inspect the generated readiness executable for exact CA, endpoint, and key inputs plus secret-path exclusion.
- Task 4.2 Shopify's external include can replace declarative cache lists, so post-include overrides must re-append the complete evaluated substituter/key sets and trust tests must use distinct identities on both host roles.
- Task 5.1 identity tests must assert complete SAN/EKU and RSA algorithm contracts plus every SOPS recipient form; checking only expected entries can miss added identities or recipients.
- Task 5.3 completes on bootstrap/API and encrypted-artifact evidence; bootstrap-mode status is intentionally not-ready, and passing live ready-mode status belongs to Task 6.5.
- Task 5.3 live bootstrap exposed six integration gaps: anonymous missing caches return 401, curl needs the declared CA, Attic's Rustls client needs process-scoped CA merging, Attic cannot share MCPProxy's loopback port 8080, Attic's exact Host check requires a lowercase allowlist for reqwest, and Caddy must normalize every upstream Host to that authority; commits `97ab16c`, `bd57d55`, `646e450`, `e6c953b`, `564f68c`, and `8d2e798` fix them and were activated before the successful checkpoint.
- Task 5.4 is the independently reviewable shared Cache Module/Publisher Job prerequisite; Task 2.2 owns worker behavior, while Task 5.4 owns package injection, root queue/log activation, and the publisher LaunchDaemon.
- Task 5.4 uses a dedicated cross-role render suite so the shared runtime can be reviewed and committed without pulling personal or Shopify ready-mode wiring into its boundary.
- Task 5.5's Caddy HTTP 502 came from stale launchd penalty state after the old 8080 crash loop; bootout/bootstrap re-registration restored persistent Attic on 18080 and CA-verified HTTP 200 through Caddy.
- Task 5.5 ends at static personal ready-mode evaluation so its reviewed configuration can be committed and delivered independently of runtime validation.
- Task 6.3 owns deterministic pending-root observation, logged publication drain, producer-store collection, and signed cross-host reuse for both producer orders; Task 6.5 owns live ready-status on both hosts.
