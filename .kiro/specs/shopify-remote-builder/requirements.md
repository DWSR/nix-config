# Requirements Document

## Introduction

The `shopify-remote-builder` feature delegates explicit public package builds
from `ShopifyLaptop` to `Brandons-MacBook-Pro`. See `brief.md` for the problem,
selected approach, and scope decisions.

## Boundary Context

- **In scope**: Ineligible targets and failures detected before the explicit
  remote commit point fall back locally; failures after that point do not.
- **Out of scope**: The eligibility result is not an adversarial security
  boundary and does not classify individual derivations inside a host rebuild.
- **Adjacent expectations**: `local-binary-cache` continues to own cache
  serving, authentication, retention, and retry behavior. Ordinary Nix and
  `darwin-rebuild` commands do not acquire the personal builder; existing
  substituters and externally managed Shopify settings remain intact.

## Requirements

### Requirement 1: Explicit public-build requests
**Objective:** As the host owner, I want remote builds requested explicitly, so that normal Shopify builds cannot use the personal host accidentally.

#### Acceptance Criteria
1. When the operator submits a guarded build request, the Guarded Build shall require an explicit flake installable and resolve its source to an immutable revision.
2. If the source cannot be resolved to an immutable revision, the Guarded Build shall build the installable locally on `ShopifyLaptop` and report the immutability failure.
3. If the source repository is not in the trusted public evaluation allowlist, the Guarded Build shall build the installable locally on `ShopifyLaptop` and report the allowlist failure.
4. While no guarded build request is active, the Personal Remote Builder shall be unavailable to standard Shopify build scheduling.
5. When the resolved revision or requested attribute changes after eligibility validation, the Guarded Build shall invalidate the prior eligibility result.
6. The Guarded Build shall leave ordinary Nix and `darwin-rebuild` command behavior unchanged.

### Requirement 2: Anonymous-source eligibility
**Objective:** As the personal host owner, I want remote eligibility proven without Shopify access, so that only anonymously refetchable sources reach the personal host.

#### Acceptance Criteria
1. When eligibility validation starts, the Public Eligibility Check shall traverse the complete requested build graph until each dependency is covered by anonymous source proof or an approved public-cache cut.
2. The Public Eligibility Check shall classify a source as eligible only when `Brandons-MacBook-Pro` can obtain it without ambient credentials or credentials embedded in the source reference and without connecting to a non-globally-reachable destination.
3. When a dependency's complete closure is anonymously available from an approved public upstream cache and every path has a trusted signature, the Public Eligibility Check may classify that dependency as public without replaying its source ancestry.
4. While determining eligibility, the Public Eligibility Check shall not treat paths in either host's normal store, the local binary cache, a Shopify cache, or persistent fetch state as evidence of anonymous availability.
5. If the source set contains a mutable local path, unlocked input, unknown fetch mechanism, private endpoint, or unverifiable source, the Public Eligibility Check shall classify the request as ineligible.
6. If any required source cannot be fetched anonymously, the Public Eligibility Check shall classify the request as ineligible and identify the failing source without exposing credentials.
7. While eligibility has not succeeded, the Guarded Build shall not transfer the requested build graph's store-path closure from `ShopifyLaptop` to `Brandons-MacBook-Pro`.
8. If a request is ineligible, the Guarded Build shall keep the request off the Personal Remote Builder and build the originally requested installable locally on `ShopifyLaptop`.
9. The Public Eligibility Check shall bind a successful result to the exact build graph and public-cache attestations for one guarded invocation.

### Requirement 3: Remote execution and local fallback
**Objective:** As the Shopify host owner, I want approved work to use available personal capacity, so that explicit public builds can finish without making the personal host a hard dependency.

#### Acceptance Criteria
1. When eligibility succeeds and the Personal Remote Builder is ready, the Guarded Build shall force the requested output to rebuild on `Brandons-MacBook-Pro`.
2. When the remote build succeeds, the Guarded Build shall make the requested outputs available in the Shopify store and identify the personal host as the execution host.
3. If the Personal Remote Builder is unreachable, unavailable, or incompatible with the requested system features before the Guarded Build commits remote execution, the Guarded Build shall retry the same immutable installable locally on `ShopifyLaptop`.
4. When a local fallback starts, the Guarded Build shall report the fallback reason and identify `ShopifyLaptop` as the execution host when compilation occurs.
5. If any failure occurs after the Guarded Build commits remote execution, the Guarded Build shall return that failure without retrying the build locally.
6. While a guarded invocation uses the Personal Remote Builder, unrelated Shopify build requests shall remain ineligible for that builder.

### Requirement 4: Local-cache publication
**Objective:** As the owner of both hosts, I want remote outputs published by the personal host, so that later builds can reuse them through the existing local cache.

#### Acceptance Criteria
1. When `Brandons-MacBook-Pro` completes any build in the approved graph, the Personal Cache Publisher shall enqueue every produced output for publication.
2. When a remote result reaches `ShopifyLaptop`, the Guarded Build shall return that result without waiting for cache publication to finish.
3. If the local cache is unavailable, the Personal Cache Publisher shall preserve pending remote outputs for retry without changing the successful build result.
4. When both hosts record the same remote output, the Cache Publishers shall avoid conflicting publication state.
5. When a request falls back to a local Shopify build, the Shopify Cache Publisher shall retain its existing publication behavior.
6. The Cache Publishers shall not enqueue outputs obtained only by substitution.

### Requirement 5: LAN trust and secret handling
**Objective:** As the personal host owner, I want remote access narrowly trusted, so that enabling builds does not expose host or Shopify credentials.

#### Acceptance Criteria
1. When a remote build connection is requested, the Personal Remote Builder shall accept it only from the declared Shopify host identity.
2. When `ShopifyLaptop` connects, the Guarded Build shall verify the declared personal host identity before sending an approved build.
3. If the declared LAN endpoint is unavailable, the Guarded Build shall not try an undeclared network path.
4. The Remote Builder Configuration shall keep private access credentials and host private keys outside the Nix store.
5. The Guarded Build shall not deliver Shopify source, cache, network, or repository credentials to `Brandons-MacBook-Pro`.
6. If a required access credential or trust record is unavailable, the Guarded Build shall use local fallback and identify the missing trust prerequisite.
7. The Guarded Build and Personal Remote Builder shall omit secret values from logs and diagnostics.

### Requirement 6: Operator visibility and interruption safety
**Objective:** As the operator, I want each decision and failure visible, so that I can distinguish eligibility, transport, build, and cache problems.

#### Acceptance Criteria
1. When a guarded request completes, the Guarded Build shall report the immutable target, eligibility outcome, fallback status, final result, and execution host when compilation occurred.
2. If eligibility fails, the Guarded Build shall report the failed policy category and affected source without exposing secret-bearing values.
3. If remote readiness fails before the commit point, the Guarded Build shall report the remote failure before local fallback begins.
4. If remote execution fails after the commit point, the Guarded Build shall report the failure without claiming whether it was a package or transport failure unless the remote result proves that distinction.
5. If eligibility validation is interrupted, the Public Eligibility Check shall leave no reusable approval for that request.
6. If a guarded request is interrupted after remote execution starts, the Guarded Build shall report that completion is unknown until the output is verified.
7. When the operator requests a readiness check, the Remote Builder Diagnostics shall report LAN reachability, host trust, version compatibility, and personal cache-publisher readiness.
8. The Remote Builder Diagnostics shall return a nonzero result when a required readiness check fails.

### Requirement 7: Declarative and cross-host verification
**Objective:** As the repository maintainer, I want the public-only boundary and two-host workflow verified, so that configuration drift cannot silently broaden remote eligibility.

#### Acceptance Criteria
1. When repository checks evaluate the personal host, the Repository Checks shall verify LAN-only builder access, declared Shopify trust, cache publication, and absence of secret values from rendered artifacts.
2. When repository checks evaluate the Shopify host, the Repository Checks shall verify guarded invocation, local fallback, and the absence of global personal-builder scheduling.
3. When eligibility fixtures contain immutable public, approved-public-cache, mutable local, unlocked, private, credential-bearing, unknown, local-cache-contaminated, private-DNS, or private-redirected inputs, repository checks shall verify the corresponding eligibility decision and execution host.
4. When remote-execution fixtures simulate availability, unavailability, transport loss, and package failure, repository checks shall verify the required remote, fallback, or no-retry result.
5. When cache fixtures record the same remote output from both hosts, repository checks shall verify idempotent publication state.
6. When rollout verification runs on the configured hosts, the Rollout Verification shall demonstrate an uncached public build using the actual Shopify and personal Nix implementations, return the output to `ShopifyLaptop`, enqueue it on `Brandons-MacBook-Pro`, and reuse it from the local cache.
