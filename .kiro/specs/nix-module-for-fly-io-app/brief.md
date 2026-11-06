# Brief: nix-module-for-fly-io-app

## Problem

> As a Nix user, I want to be able to define Fly.io app configuration using Nix so that I can keep all of the configuration in the same location.
>
> The module must:
>
> * provide the ability to comprehensively define a Fly.io app, including the ability to leverage features from the Machines API such as multi-container machines and define a pre-existing container image or a Nix derivation to be built remotely
> * be compatible with deployment tooling such as deploy-rs or Colmena
> * only require a fly.io access token for authentication

Nix users otherwise maintain Fly.io app settings and image/build declarations separately from their Nix configuration, and must keep those sources consistent during deployment.

## Current State

- The repository has no Fly.io app module or declarative app configuration.
- `flyctl` is installed in the personal Home Manager configuration; it is not wired to an app definition or deployment flow.
- `home-manager/common/fly-skill.nix` installs an operations skill, not Fly app configuration or deployment support.
- The repository has Nix module configurations and a NixOS VM, but no Fly-specific integration with deploy-rs or Colmena.

## Desired Outcome

- A reusable Nix module lets users declare a Fly.io app and its Machines API configuration in Nix.
- An app can use an existing container image or a Nix derivation built remotely.
- The module supports multi-container machine configurations and the Fly app settings needed to operate the app.
- Users can deploy the module through Nix deployment tooling such as deploy-rs or Colmena.
- Authentication requires only a Fly.io access token; it does not depend on an interactive `flyctl auth login` session or a separate credential service.

## Approach

- Provide a normal Nix module interface for declaring the app and its image/build source, with a clear boundary between evaluated Nix configuration and the Fly deployment operation.
- Integrate with deploy-rs and Colmena as consumers of Nix configuration rather than requiring either tool to understand Fly-specific options.
- Supply the Fly access token at deployment/runtime, not as a Nix store input or generated app configuration, so the credential is not exposed in derivation paths or configuration artifacts.
- Keep the module's configuration surface aligned with Fly's Machines API, including a way to express API features not represented by convenience options.

## Scope

- **In**: A reusable Nix module for Fly app configuration; comprehensive Machines API configuration, including multi-container machines; existing-image and remotely built Nix-derivation image sources; token-only authentication; deploy-rs and Colmena compatibility.
- **Out**: Replacing deploy-rs or Colmena; managing Fly organizations, users, or unrelated Fly resources; building a general-purpose Nix-to-OCI platform outside the Fly deployment flow; changes to the existing Fly operations skill or personal `flyctl` installation.

## Boundary Candidates

- Nix option model for app and Machines API configuration.
- Image selection and remote Nix derivation build path.
- Deployment invocation and deploy-rs/Colmena integration.
- Runtime token sourcing and safe secret handling.
- Evaluation and deployment verification for representative single- and multi-container apps.

## Out of Boundary

- Fly account and organization lifecycle management.
- General-purpose orchestration across non-Fly hosting providers.
- A separate secrets-management system; the deployment requires a supplied Fly access token.
- Replacing Fly's Machines API or its supported app behavior.

## Upstream / Downstream

- **Upstream**: Nix module evaluation and build tooling; Fly.io app configuration and Machines API; a Fly access token provided by the operator.
- **Downstream**: NixOS or other Nix configurations that declare Fly apps and deploy them through deploy-rs, Colmena, or compatible tooling.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `nix-built-container-for-default-fabro-environmen` defines a local Fabro sandbox image, not Fly app deployment; `mac-nix-remote-builder` covers remote Nix builds for macOS, not Fly Machines.

## Constraints

- The module must be usable in Nix configurations managed by deploy-rs or Colmena.
- Remote Nix derivation builds and use of a pre-existing image are both supported image paths.
- Machines API capabilities, including multi-container machines, must not be excluded by an overly narrow option model.
- The Fly access token must be provided without embedding it in a Nix derivation, store path, or generated configuration artifact.
- Authentication must not require interactive Fly CLI login or credentials beyond the access token.
