# Brief: nix-module-for-fly-io-app

## Problem

> As a Nix user, I want to be able to define Fly.io app configuration using Nix so that I can keep all of the configuration in the same location.
>
> The module must:
>
> * provide the ability to comprehensively define a Fly.io app, including the ability to leverage features from the Machines API such as multi-container machines and define a pre-existing container image or a Nix derivation built locally and pushed to Fly
> * expose each Fly app as an independently deployable Nix flake app, which another script can orchestrate
> * only require a fly.io access token for authentication

Nix users otherwise maintain Fly.io app settings and image/build declarations separately from their Nix configuration, and must keep those sources consistent during deployment.

## Current State

- The repository has no Fly.io app module or declarative app configuration.
- `flyctl` is installed in the personal Home Manager configuration; it is not wired to an app definition or deployment flow.
- `home-manager/common/fly-skill.nix` installs an operations skill, not Fly app configuration or deployment support.
- The repository has Nix module configurations and a NixOS VM, but no independently selectable Fly app deployment commands.
- The flake pins `pdtpartners/nix-snapshotter` and uses it to build the Fabro VM sandbox image, but there is no image-publish-to-Fly path.

## Desired Outcome

- A reusable Nix module lets users declare a Fly.io app and its Machines API configuration in Nix.
- An app can use an existing container image or a container image built locally from a Nix derivation with `nix-snapshotter` and pushed to Fly using Nix.
- The module supports multi-container machine configurations and the Fly app settings needed to operate the app.
- Users can deploy each Fly app with `nix run '.#deploy-<app>'`; an external script may orchestrate multiple app commands.
- Authentication requires only a Fly.io access token; it does not depend on an interactive `flyctl auth login` session or a separate credential service.

## Approach

- Provide a Nix module for declaring app and Machines API configuration, with one flake app per independently selectable Fly app.
- The flake app applies app settings with `flyctl deploy`, then reapplies and verifies every declared Machine's full configuration through the Machines API. Operators do not run separate out-of-band `flyctl deploy` commands against managed apps; the module does not enforce that guarantee.
- Build derivation-backed images locally with the pinned `pdtpartners/nix-snapshotter` flake input and push them to Fly from Nix; also accept existing image references.
- Package the runtime closure in a self-contained `dockerTools` base image, then use the pinned `nix-snapshotter.buildImage` and its publish API; Fly does not supply the snapshotter's runtime store mount.
- Track the image derivation's realized content identity and push only when it changes, making unchanged deployments avoid redundant pushes.
- If a previously published image disappears from Fly without a derivation change, fail rather than repush when the deployment host retains its publication record. With no local record (first use, host change, or state loss), automatic first publication may repush an unchanged image.
- Supply the Fly access token only at deployment runtime, never as a derivation input or generated artifact.
- Keep the module's configuration surface aligned with Fly's Machines API, including multi-container Machines and fields not represented by convenience options.

This uses an existing pinned image-builder dependency while adding the missing local-build and Fly-push lifecycle; remote building is unnecessary for this flow.

## Scope

- **In**: A reusable Nix module for Fly app configuration; comprehensive Machines API configuration, including multi-container machines; existing images and local `nix-snapshotter` image builds pushed to Fly only when the derivation changes; token-only authentication; an independently invokable flake app per Fly app.
- **Out**: Native deploy-rs/Colmena host integration; a required NixOps4 resource; multi-app orchestration beyond independently callable flake apps; managing Fly organizations, users, or unrelated Fly resources; a general-purpose Nix-to-OCI platform; changes to the Fly operations skill or personal `flyctl` installation.

## Boundary Candidates

- Nix option model for app and Machines API configuration.
- Image selection, local `nix-snapshotter` derivation build, content-change detection, and push path.
- Per-app flake app generation and a deployment command that scripts can invoke.
- Runtime token sourcing and safe secret handling.
- Evaluation and deployment verification for representative single- and multi-container apps.

## Out of Boundary

- Fly account and organization lifecycle management.
- General-purpose orchestration across non-Fly hosting providers.
- A separate secrets-management system; the deployment requires a supplied Fly access token.
- Replacing Fly's Machines API or its supported app behavior.

## Upstream / Downstream

- **Upstream**: Nix module evaluation and build tooling; the repository's pinned `pdtpartners/nix-snapshotter` flake input for OCI image builds; Fly.io app configuration and Machines API; a Fly access token provided by the operator.
- **Downstream**: Nix configurations that declare Fly apps and optional scripts or NixOps4 resources that invoke their flake app commands.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `nix-built-container-for-default-fabro-environmen` already builds a local OCI image with the pinned `nix-snapshotter` input, but owns Fabro's local sandbox lifecycle, not pushing app images to Fly; `mac-nix-remote-builder` covers remote Nix builds for macOS, not Fly Machines.

## Constraints

- Each declared Fly app must be independently invokable through `nix run '.#deploy-<app>'` without an SSH or NixOS target.
- The deployment command runs in a Linux environment; macOS operators can run it inside a local Linux VM. A native macOS wrapper is not required.
- Local derivation-backed image builds must use `pdtpartners/nix-snapshotter`; only push when the derivation changes.
- Existing image references are also supported.
- Machines API capabilities, including multi-container machines, must not be excluded by an overly narrow option model.
- The Fly access token must be provided without embedding it in a Nix derivation, store path, or generated configuration artifact.
- Authentication must not require interactive Fly CLI login or credentials beyond the access token.
