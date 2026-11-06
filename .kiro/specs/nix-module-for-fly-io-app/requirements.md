# Requirements Document

## Introduction

This document specifies the user-observable requirements for the reusable Fly.io app module described in `brief.md`. It covers app and Machines API configuration, image sources, deployment-tool compatibility, and Fly access token handling.

## Boundary Context (Optional)
- **In scope**: declaring a Fly app and its Machines API configuration, including multi-container machines; selecting an existing container image or a remotely built Nix derivation; using a Fly access token for deployment through deploy-rs or Colmena.
- **Out of scope**: Fly account or organization lifecycle; managing resources other than Fly apps; provisioning or rotating the Fly access token; a general-purpose Nix-to-OCI platform or non-Fly deployment support.
- **Adjacent expectations**: The operator supplies the Fly access token for deployment/runtime (**wiring**); Fly determines whether that token authorizes the requested operation (**verification**); creating, generating, or rotating the token remains operator-owned (**provisioning**). deploy-rs and Colmena consume the Nix configuration, and Fly defines the supported app and Machines API behavior.

## Requirements

### Requirement 1: Fly app declaration and settings
**Objective:** As a Nix user, I want to declare a Fly app and its settings in Nix, so that the app configuration has a single declarative source.

#### Acceptance Criteria
1. When a user declares a Fly app, the Fly App Module shall make the app's identity and declared app settings available to deployment.
2. Where the Fly Machines API supports an app setting, the Fly App Module shall allow the user to declare that setting and shall include it in the Fly app configuration used for deployment.
3. Where a Fly Machines API feature has no dedicated convenience setting, the Fly App Module shall still allow the user to express that feature in the Fly app configuration.
4. When a deployment applies a Fly app configuration, the Fly app shall reflect the declared settings accepted by Fly.

### Requirement 2: Machines API and multi-container machines
**Objective:** As a Nix user, I want to describe Machines API behavior, including multiple containers in a machine, so that my Fly app can use the machine configurations it needs.

#### Acceptance Criteria
1. Where a machine configuration includes multiple containers, the Fly App Module shall allow the user to declare each container and its configuration.
2. When a Fly app with a multi-container machine configuration is deployed, the deployment shall apply the declared containers as part of that machine configuration.
3. Where the user declares other supported Machines API configuration, the Fly app configuration used for deployment shall preserve that declared configuration.

### Requirement 3: Container image sources
**Objective:** As a Nix user, I want to select either an existing container image or a Nix derivation built remotely, so that I can use the image source that fits my app.

#### Acceptance Criteria
1. Where the user selects an existing container image, the Fly app configuration used for deployment shall identify that image as the app's image source.
2. Where the user selects a Nix derivation, the deployment shall use an image produced by building that derivation remotely.
3. If the user selects both an existing container image and a Nix derivation for the same app, then the Fly App Module shall report a configuration error identifying the conflicting image sources.
4. If the user selects neither an existing container image nor a Nix derivation for an app that requires an image, then the Fly App Module shall report a configuration error identifying the missing image source.

### Requirement 4: Deployment-tool compatibility
**Objective:** As a Nix user, I want to deploy my Fly app configuration through Nix deployment tooling, so that it fits into my existing deployment workflow.

#### Acceptance Criteria
1. When a user deploys a Nix configuration through deploy-rs, the Fly app declaration shall be available to the deployment without requiring deploy-rs to understand Fly-specific options.
2. When a user deploys a Nix configuration through Colmena, the Fly app declaration shall be available to the deployment without requiring Colmena to understand Fly-specific options.
3. When the deployed Fly app configuration changes, the deployment shall apply the changed declared configuration to the corresponding Fly app.
4. If Fly rejects an app deployment, then the deployment shall report failure rather than report the app as successfully deployed.

### Requirement 5: Fly access token authentication
**Objective:** As a Fly app operator, I want deployment authenticated with only a Fly access token, so that deployment does not depend on an interactive login or another credential.

#### Acceptance Criteria
1. When a Fly access token is supplied for deployment/runtime, the Fly app deployment shall use it to authenticate with Fly.
2. The Fly app deployment shall not require an interactive `flyctl auth login` session.
3. The Fly app deployment shall not require a credential other than the Fly access token for authentication.
4. If the Fly access token is absent or Fly rejects it, then the deployment shall report an authentication failure and shall not report the app as successfully deployed.

### Requirement 6: Fly access token confidentiality
**Objective:** As a Fly app operator, I want the Fly access token kept out of Nix configuration artifacts, so that declaring and deploying an app does not expose the credential through those artifacts.

#### Acceptance Criteria
1. The Fly App Module shall not place the Fly access token in a Nix derivation input or derivation path.
2. The Fly App Module shall not place the Fly access token in the Nix store.
3. The Fly App Module shall not include the Fly access token in generated app configuration artifacts.
