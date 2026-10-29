# Requirements Document

## Introduction

This document states the observable model-routing behavior of the fabro-vm
gateway and of the OpenCode and Fabro model surfaces that call it. The
problem, current state, chosen approach, and scope are in `brief.md`.

## Boundary Context

- **In scope**: the client-visible catalog ids, weighted placement, session
  affinity, in-group failover and cooldown, the header-forwarding rule for
  unified groups, both client model surfaces, and the checks, bridge tests,
  operator smoke, and documentation that prove them.
- **Out of scope**: failover never extends to a different Logical Model, so a
  rate-limited `gpt-6-luna` never answers as `gpt-6.1-sol`; session identity is
  not accepted from a bare `x-session-id`; Fabro is not asked to emit a
  per-conversation header; affinity does not survive a gateway restart; header
  forwarding is not narrowed per Deployment; no client exposes a
  provider-pinning switch for a Unified Model Group; and no affinity
  persistence, multi-instance state, virtual keys, budgets, spend reporting,
  new subscriptions, providers, or credentials are added.
- **Adjacent expectations**: the pinned gateway 1.86.0 remains the feature
  ceiling; the nixpkgs `services.litellm` unit, the sops-rendered
  `litellm-env` template, the fabro-vm service ordering (a gateway restart
  also restarts Fabro), OpenCode 1.19.0 session headers, and Fabro
  0.386/Lithos `prompt_cache_key` emission remain owned by their modules and
  specs; the unused macOS launchd module and its render tests must keep
  evaluating but are not changed.

## Requirements

### Requirement 1: One client-callable identity per Logical Model
**Objective:** As a client integrator, I want every Logical Model reachable
under one provider-agnostic id, so that no client encodes a provider choice.

#### Acceptance Criteria
1. The Gateway shall expose exactly one client-callable id per Logical Model.
2. The Gateway shall not include a provider name in any client-callable id.
3. Where two or more providers offer the same upstream model, the Gateway
   shall serve it as one Unified Model Group under one client-callable id.
4. Where Deployments of the same upstream model differ in wire mode,
   request-affecting defaults, or effective context window, the Gateway shall
   serve them as separate Logical Models.
5. A Logical Model served by exactly one Deployment shall use a
   client-callable id of the same form as a Unified Model Group.
6. The Gateway shall keep every model it currently serves reachable under a
   client-callable id.
7. When a caller requests a provider-scoped model id that the Gateway no
   longer serves, the Gateway shall reject the request as an unknown model.
8. The Gateway shall never publish a client-callable id that resolves to zero
   Deployments.

### Requirement 2: Declarative Deployment Table
**Objective:** As the Gateway operator, I want model composition declared as
data, so that adding a provider, a model, or a weight is a table entry rather
than a client change.

#### Acceptance Criteria
1. The Deployment Table shall declare, for each Logical Model, an ordered list
   of Deployments carrying each Deployment's provider, upstream model id, wire
   mode, request-affecting defaults, effective context window, and weight.
2. When the operator adds a provider, a model, or a weight to the Deployment
   Table, the Gateway and both client model surfaces shall expose the result
   without a client code change.
3. When the operator adds a Deployment to an existing Unified Model Group, the
   group's client-callable id shall not change.
4. When the Deployment Table contents are unchanged, repeated configuration
   evaluation shall produce an identical served catalog.
5. If two Deployments of one Unified Model Group disagree on wire mode,
   request-affecting defaults, or effective context window, then configuration
   evaluation shall fail with an error naming the Logical Model and each
   conflicting Deployment.
6. If a Deployment Table entry omits a field required to serve its Logical
   Model, then configuration evaluation shall fail with an error naming the
   entry and the missing field.
7. Provider credentials referenced by the Deployment Table shall be resolved
   from the runtime environment, and no credential value shall appear in the
   deployed configuration artifact.
8. The Deployment Table shall be the only source of the Gateway's served model
   ids and of both client model surfaces' model entries.

### Requirement 3: Weighted placement
**Objective:** As the Gateway operator, I want new conversations spread across
the Deployments of a Unified Model Group by weight, so that no single
subscription absorbs the whole request rate.

#### Acceptance Criteria
1. While every Deployment of a Unified Model Group is available, the Gateway
   shall place new conversations across them in proportion to their configured
   weights.
2. Where a Deployment declares no weight, the Gateway shall treat it as
   equal-weighted with its available siblings.
3. For a new conversation, the Gateway shall base placement on configured
   weights and current Deployment availability alone.
4. When the Gateway places a conversation, the Gateway shall record the
   selected Deployment as that conversation's Affinity Pin.
5. When the operator changes a weight, the Gateway shall apply the new weight
   after its configuration is reloaded, without a client change.
6. Over a sequence of new conversations, the observed share of placements per
   Deployment shall track its configured weight share rather than concentrate
   on a single Deployment.
7. While a Unified Model Group has exactly one available Deployment, the
   Gateway shall place all of its new conversations on that Deployment.

### Requirement 4: Session affinity
**Objective:** As a client user, I want every request in one conversation to
reach the same Deployment for as long as its session lasts, so that provider
caching applies across turns.

#### Acceptance Criteria
1. When a request carries a Session Identity whose Affinity Pin has not
   exceeded the Affinity TTL, the Gateway shall route the request to the pinned
   Deployment.
2. When a request carries a client session header, the Gateway shall derive the
   Session Identity from that header.
3. When a request carries no client session header and carries a
   conversational cache key in its body, the Gateway shall derive the Session
   Identity from that key.
4. If a request carries both a client session header and a conversational cache
   key, then the Gateway shall derive the Session Identity from the header and
   shall not let the body key override it.
5. The Gateway shall namespace body-key-derived Session Identities by producer,
   so that an identical raw key from a different producer does not resolve to
   the same Session Identity.
6. The Gateway shall ensure that a body-key-derived Session Identity never
   matches a header-derived Session Identity.
7. The Gateway shall key affinity by Logical Model and Session Identity, so
   that one conversation on two Logical Models may hold two independent
   Affinity Pins.
8. While an Affinity Pin is within the Affinity TTL, the Gateway shall keep
   routing that conversation to the pinned Deployment.
9. When an Affinity Pin exceeds the Affinity TTL, the Gateway shall treat the
   next request of that conversation as a new placement.
10. When a request carries no Session Identity, the Gateway shall place it by
    weight without error and shall not attach it to another conversation's
    Affinity Pin.
11. When a conversational cache key does not identify a conversation, the
    Gateway shall place the request by weight without error.
12. When the Gateway restarts, the Gateway shall place the next request of
    every existing conversation as a new placement.

### Requirement 5: Within-group failover and cooldown
**Objective:** As a client user, I want a rate-limited or failing provider to
be absorbed inside the Unified Model Group, so that a conversation survives a
provider fault without my intervention.

#### Acceptance Criteria
1. When a Deployment returns a rate-limit response, the Gateway shall retry the
   request on another available Deployment of the same Unified Model Group
   before responding to the caller.
2. When a Deployment fails with a provider error or times out, the Gateway
   shall retry the request on another available Deployment of the same Unified
   Model Group before responding to the caller.
3. When a retried attempt succeeds, the caller shall receive exactly one
   successful response for its single request.
4. When a Deployment fails, the Gateway shall exclude it from placement, retry
   selection, and affinity selection for a configured cooldown period.
5. While an Affinity Pin points at a Deployment in cooldown, the Gateway shall
   serve that conversation's requests from an available sibling Deployment of
   the same Unified Model Group.
6. When a Deployment's cooldown period ends, the Gateway shall return it to
   placement.
7. If every Deployment of a Unified Model Group is unavailable or has failed,
   then the Gateway shall respond with an error that identifies the requested
   Logical Model.
8. The Gateway shall not fail a request over to a Deployment of a different
   Logical Model.
9. The Gateway shall bound the number of in-group attempts by configuration.

### Requirement 6: Client model surfaces
**Objective:** As a client user, I want OpenCode and Fabro to offer the same
Logical Models under the same ids, so that switching between clients never
means re-learning model names or reaching a dead id.

#### Acceptance Criteria
1. OpenCode's LiteLLM provider model map shall list exactly one entry per
   Logical Model, keyed by its client-callable id.
2. Fabro's model records shall contain exactly one entry per Logical Model,
   carrying its client-callable id as the upstream model id.
3. OpenCode's default model shall be a client-callable id served by the
   Gateway.
4. Every Fabro default model reference and CLI model reference shall name a
   Fabro model record the Gateway can serve.
5. OpenCode's provider configuration shall declare no static session header.
6. When OpenCode sends a request for a Logical Model, the Gateway shall receive
   OpenCode's per-session session header without client-side header
   configuration.
7. When Fabro sends a request for a Logical Model, the request shall carry a
   conversational cache key that identifies the conversation.
8. Every Fabro model record that routes to the Gateway shall advertise the
   capability that makes Fabro emit that cache key.
9. Fabro's static upstream session header shall not be treated as a Session
   Identity, so that a Fabro request carrying it together with a conversational
   cache key derives its Session Identity from that key.
10. When the served catalog changes, both client model surfaces shall expose
    the same client-callable ids in the same change, and neither client shall
    retain a reference to a removed provider-scoped id.

### Requirement 7: Upstream header forwarding
**Objective:** As the Gateway operator, I want client session headers carried
to every Deployment of a group that needs them, so that a shared upstream
requirement does not split a Logical Model.

#### Acceptance Criteria
1. Where a Unified Model Group contains a Deployment whose upstream requires a
   client session header, the Gateway shall forward the client's session
   headers to that Deployment.
2. Where a Unified Model Group contains a Deployment whose upstream requires a
   client session header, the Gateway shall apply the same forwarding to every
   other Deployment of that group.
3. Where no Deployment of a Unified Model Group requires a client session
   header, the Gateway shall not forward client headers to that group.
4. The Gateway shall not forward client credentials or content-type headers to
   any upstream.
5. While forwarding is enabled for a Unified Model Group, the Gateway shall
   forward only headers on the documented forwarding allowlist and shall
   forward nothing outside it.
6. Header forwarding shall be uniform across the Deployments of a Unified
   Model Group, with no per-Deployment filtering.

### Requirement 8: Verification and operator enablement
**Objective:** As the repository maintainer, I want the catalog, routing
settings, and client surfaces checked automatically and smoked by hand, so that
routing drift is caught before it reaches a client.

#### Acceptance Criteria
1. When repository checks evaluate the gateway and client configuration, the
   Repository Checks shall verify that every client-callable id exposed by
   either client is served by exactly one Logical Model.
2. When repository checks evaluate the gateway configuration, the Repository
   Checks shall verify that every Unified Model Group declares Deployment
   weights, an explicit Affinity TTL, bounded in-group retries, and weighted
   failover.
3. When repository checks evaluate the Deployment Table, the Repository Checks
   shall verify that the Deployments of each Unified Model Group agree on wire
   mode, request-affecting defaults, and effective context window.
4. When repository checks evaluate either client model surface, the Repository
   Checks shall fail if a client references a removed provider-scoped id.
5. When repository checks evaluate a rendered configuration, the Repository
   Checks shall fail if that configuration contains a credential value.
6. If any Repository Check fails, then the check shall report the offending
   Logical Model, Deployment, or client entry.
7. The Affinity Bridge Tests shall cover header precedence over a body cache
   key, namespacing between producers, a request with no cache key, and a
   malformed cache key; a failing Affinity Bridge Test shall fail the
   Repository Checks.
8. The Operator Smoke Check shall document steps that verify weight
   distribution across Deployments, affinity stability within one conversation,
   and absorption of a forced Deployment failure inside the group, together
   with the expected observation for each step.
9. The operator documentation shall state how to add a provider, a model, or a
   weight, where weights and the Affinity TTL are configured, and how to
   observe which Deployment served a request.
10. The operator documentation, the fabro-vm handoff, and the in-repo
    configuration comments shall be updated so that no current document or
    comment instructs a client to call a provider-scoped model id.
