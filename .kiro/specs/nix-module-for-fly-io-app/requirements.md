# Requirements Document

## Introduction

This document defines the user-observable requirements for the Fly App Module described in `brief.md`. It covers app and Machines API configuration, image sources, deployment, authentication, and supported platforms.

## Boundary Context (Optional)
- **In scope**: Declaring and deploying an existing Fly app through Nix; expressing Fly app settings and complete Machines API configurations, including multi-container machines; selecting an existing image or a remotely built Nix derivation; use from Darwin ARM and Linux x64 and ARM platforms.
- **Out of scope**: Creating or deleting Fly apps, provisioning or rotating the Fly access token, and deployment to non-Fly providers.
- **Adjacent expectations**: The operator supplies the Fly access token at deployment/runtime (**wiring**); Fly determines whether the token authorizes the requested operation (**verification**); creating, generating, or rotating the token remains operator-owned (**provisioning**). deploy-rs and Colmena consume the Nix configuration, and Fly defines supported app and Machines API behavior.

## Requirements

### Requirement 1: Fly app declaration and settings

**Objective:** As a Nix user, I want to declare a Fly app and its settings in Nix, so that the app configuration has a single declarative source.

#### Acceptance Criteria
1. When a user declares a Fly app, the Fly App Module shall make the app identity and declared app settings available to deployment.
2. Where a Fly app setting is supported, the Fly App Module shall allow the user to declare that setting for deployment.
3. Where a Fly Machines API feature has no dedicated convenience setting, the Fly App Module shall allow the user to express that feature in the app configuration.
4. When Fly accepts a deployment, the Fly app shall reflect the declared app settings.

### Requirement 2: Machines API and multi-container machines

**Objective:** As a Nix user, I want to describe Machines API behavior, including multiple containers in a machine, so that my Fly app can use the machine configurations it needs.

#### Acceptance Criteria
1. Where a machine configuration includes multiple containers, the Fly App Module shall allow the user to declare each container and its configuration.
2. When a Fly app with a multi-container machine configuration is deployed, the deployment shall apply the declared containers as part of that machine configuration.
3. Where the user declares other supported Machines API configuration, the deployment shall preserve that configuration.
4. When Fly accepts a declared machine configuration, the Fly app's machines shall reflect that configuration.

### Requirement 3: Container image sources

**Objective:** As a Nix user, I want to select either an existing container image or a Nix derivation built remotely, so that I can use the image source that fits my app.

#### Acceptance Criteria
1. Where the user selects an existing container image, the deployment shall use that image for the Fly app.
2. Where the user selects a Nix derivation, the deployment shall build the app image remotely from the derivation's output.
3. When the user selects a Nix derivation, the deployment shall use Nixpacks to build the image on a Fly.io remote builder.
4. If the user selects both an existing container image and a Nix derivation for the same app, then the Fly App Module shall report a configuration error identifying the conflicting image sources.
5. If the user selects neither an existing container image nor a Nix derivation for an app that requires an image, then the Fly App Module shall report a configuration error identifying the missing image source.
6. If a Fly.io remote builder cannot build the image from the selected Nix derivation, then the deployment shall report failure and shall not report the app as successfully deployed.

### Requirement 4: Deployment-tool compatibility

**Objective:** As a Nix user, I want to deploy my Fly app configuration through Nix deployment tooling, so that it fits into my existing deployment workflow.

#### Acceptance Criteria
1. When a user deploys a Nix configuration through deploy-rs, the Fly app declaration shall be available to deployment without requiring deploy-rs to understand Fly-specific options.
2. When a user deploys a Nix configuration through Colmena, the Fly app declaration shall be available to deployment without requiring Colmena to understand Fly-specific options.
3. When the declared Fly app configuration changes, the deployment shall apply the changed configuration to the corresponding Fly app.
4. If Fly rejects an app deployment, then the deployment shall report failure rather than report the app as successfully deployed.

### Requirement 5: Fly access token authentication

**Objective:** As a Fly app operator, I want deployment authenticated with only a Fly access token, so that deployment does not depend on an interactive login or another credential.

#### Acceptance Criteria
1. When a Fly access token is supplied for deployment, the Fly app deployment shall use it to authenticate with Fly.
2. The Fly app deployment shall not require an interactive `flyctl auth login` session.
3. The Fly app deployment shall not require a credential other than the Fly access token for authentication.
4. If the Fly access token is absent or Fly rejects it, then the deployment shall report an authentication failure and shall not report the app as successfully deployed.

### Requirement 6: Fly access token confidentiality

**Objective:** As a Fly app operator, I want the Fly access token kept out of app configuration artifacts, so that declaring and deploying an app does not expose the credential through those artifacts.

#### Acceptance Criteria
1. The Fly App Module shall not include the Fly access token in Nix derivation inputs or paths.
2. The Fly App Module shall not store the Fly access token in the Nix store.
3. The Fly App Module shall not include the Fly access token in generated app configuration artifacts.

### Requirement 7: Platform compatibility

**Objective:** As a Nix user, I want to configure and deploy Fly apps from the platforms I use, so that the Fly App Module is usable across my supported Nix systems.

#### Acceptance Criteria
1. The Fly App Module shall support declaring and deploying Fly apps from Darwin on ARM.
2. The Fly App Module shall support declaring and deploying Fly apps from Linux on x64.
3. The Fly App Module shall support declaring and deploying Fly apps from Linux on ARM.
4. When a Fly app is deployed from any supported platform, the deployment shall provide the same app configuration, Machines API, image-source, and authentication behavior.
