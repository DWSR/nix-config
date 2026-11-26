# Brief: flake-repository-layout

## Problem

> The flake.nix in the root of the repository is getting incredibly long and the flake itself is likely better split up into other flakes for things like scoping test runs, etc.
>
> Look at the repository and build a list of flakes and the functionality they will contain such that the flakes are self-contained and can be individually addressed through things like tests, etc. The intention here is to make areas of the repository individually addressable to allow parallel processing for agents, test runs, etc.

> Review this plan for sequencing issues and other opportunities to simplify/standardize the repository. Build out a Kiro spec for implementation.

The maintainer and agents need to change and test an area without editing the same root file or evaluating unrelated hosts.

## Current State

The root flake is over 5,000 lines, mostly checks. Package definitions, module code, scripts, and tests for one feature live in different trees. Some checks exercise local fixtures; others assert against the real personal Mac, builders, and Fabro guest. Several suites re-evaluate a copy of the entire checkout.

## Desired Outcome

Agents can run a named area's checks in their own checkout, and CI can run the same areas concurrently on the appropriate systems. Existing rebuild, build, run, and integration-check selectors remain usable at the root.

## Approach

Keep the root as the host flake and establish roughly 15 real flake roots under `flakes/`. Baseline the current contract, land the Nix prerequisite independently, prove the convention with Fly, then migrate by dependency order. Move domain packaging and test code with its owner; keep cross-host assertions at the root.

The original relative-input plan is incompatible with the personal host's current Lix. The user selected: “Swap the personal host to stock Nix, latest stable version.” The engine transition precedes the first production relative-input lock.

## Scope

- **In**: Personal-host Nix engine transition; area ownership and lock policy; root compatibility; scoped checks and CI; contributor and agent guidance; bounded migration slices.
- **Out**: A single cutover PR; changes to service behavior, credentials or secret contents; upgrading unrelated inputs; rewriting all test runners; adding a flake framework.

## Boundary Candidates

- Shared package fixes and pin policy vs. area-owned packages, modules, and checks.
- Standalone module/package checks vs. production host and repository integration.
- Nix engine cutover vs. relative-input and CI migration; agent work vs. serialized root registration.

## Out of Boundary

Existing feature specs retain their service contracts. This migration does not deploy workloads or provision credentials.

## Upstream / Downstream

- **Upstream**: Stock Nix lock semantics; current nixpkgs and service pins; current host configurations and check outputs.
- **Downstream**: Host operators, Fly-module consumers, CI, Fabro test commands, and future area owners.

## Existing Spec Touchpoints

- **Extends**: None. This is one repository migration with independently reviewable slices.
- **Adjacent**: Fly public outputs, Fabro sandbox and builders, SDD/Kiro, LiteLLM/Postgres, and the editor/agent tests retain their existing behavior contracts.

## Constraints

Use the existing repo task-count and diff limits. No phase requires a live service credential. Host activation and recovery remain operator-owned. Nix validation uses supported native runners or a configured compatible builder.
