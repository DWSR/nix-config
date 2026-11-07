# Requirements Document

## Introduction

The Fly App Module declares and deploys Fly apps from Nix. Problem, chosen image-build approach, and scope are in `brief.md`.

## Boundary Context

- **In scope**: Configuration and deployment of an existing Fly app; image references or locally built derivation-backed images; Machines API configuration, including multi-container Machines; token-only deployment authentication.
- **Out of scope**: Creating or deleting Fly apps; provisioning application secrets, Fly accounts, or tokens; deploying to other providers.
- **Adjacent expectations**: Fly authorizes deployment and supplies its registry/runtime; the operator supplies the token, an existing app, and a Nix build environment. External scripts and NixOps4 may invoke app commands; this spec does not integrate with their internals.

## Requirements

### Requirement 1: Fly app declaration and settings

**Objective:** As a Nix user, I want to declare an app and its settings in Nix, so that Fly configuration has one declarative source.

#### Acceptance Criteria
1. When a user declares an existing Fly app, the Fly App Module shall make its identity and declared settings available to deployment.
2. Where a Fly app setting is supported by the deployment path, the Fly App Module shall allow the user to declare that setting.
3. When a deployment is accepted, the Fly App Module shall apply the declared app settings to the target app.
4. If the declared app does not exist or Fly rejects its settings, the Fly App Module shall report deployment failure.

### Requirement 2: Machines API and multi-container Machines

**Objective:** As a Nix user, I want to declare complete Machine configurations, so that I can use supported Fly features without losing configuration.

#### Acceptance Criteria
1. Where a Machine contains multiple containers, the Fly App Module shall allow the user to declare each container and its image and configuration.
2. Where a supported Machines API field has no dedicated option, the Fly App Module shall allow the user to express that field.
3. When a Machine is deployed, the Fly App Module shall preserve all declared supported Machine and container fields.
4. When Fly accepts a Machine deployment, all Machines in the module-managed set shall reflect the declaration and no surplus Machine shall remain in that set.

### Requirement 3: Image selection, local build, and publishing

**Objective:** As a Nix user, I want to deploy an existing image or a locally built derivation-backed image, so that image and app declarations stay together.

#### Acceptance Criteria
1. Where an existing image reference is selected, the Fly App Module shall deploy that image without rebuilding or republishing it.
2. Where a Nix derivation is selected as an image source, the Fly App Module shall build a Fly-runnable container image locally with the pinned `nix-snapshotter` dependency and publish it to Fly before deploying it.
3. When a derivation-backed image's realized identity has not changed and its published image remains available, the Fly App Module shall not republish it.
4. When a derivation-backed image's realized identity changes, the Fly App Module shall publish the changed image before deploying it.
5. If a previously published image is unavailable, its derivation identity has not changed, and local publication state is intact, the Fly App Module shall report failure without republishing it.
6. If both image sources are declared for the same image-bearing declaration, the Fly App Module shall report the conflicting choices.
7. If neither image source is declared for a required image, the Fly App Module shall report the missing source.
8. If the local build, publication, or image-availability check fails, the Fly App Module shall report failure and shall not report deployment success.

### Requirement 4: Independent flake-app deployment

**Objective:** As a Nix user, I want one Nix command per Fly app, so that I can deploy apps independently or orchestrate them from a script.

#### Acceptance Criteria
1. When a Fly app is declared, the Fly App Module shall expose an independently invokable `nix run '.#deploy-<app>'` command for that app.
2. When a caller invokes an app command, the Fly App Module shall target only the selected Fly app without requiring SSH access or a NixOS target.
3. When the declared Fly configuration changes without an image change, the Fly App Module shall apply the configuration without republishing an unchanged derivation-backed image.
4. If Fly rejects deployment, the Fly App Module shall return failure to the invoking command or script instead of success.

### Requirement 5: Token-only deployment authentication

**Objective:** As a Fly operator, I want one token to authorize image publication and deployment without interactive login.

#### Acceptance Criteria
1. When the operator supplies a Fly access token, the Fly App Module shall use it for Fly authentication during publication and deployment.
2. The Fly App Module shall not require interactive `flyctl auth login` or a second credential.
3. If the token is missing, empty, or rejected, the Fly App Module shall report authentication failure instead of success.

### Requirement 6: Token confidentiality

**Objective:** As a Fly operator, I want the access token kept out of build and configuration artifacts.

#### Acceptance Criteria
1. The Fly App Module shall not include the Fly token in Nix derivation inputs or store paths.
2. The Fly App Module shall not write the Fly token into generated app or Machine configurations or persistent publication state.
3. The Fly App Module shall not expose the Fly token in deployment command arguments or diagnostic output.
