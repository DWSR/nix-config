# Requirements Document

## Introduction

This document defines observable requirements for the Fly.io app capability described in `brief.md`. It specifies what operators can declare, deploy, and expect without prescribing the module's implementation.

## Boundary Context

- **In scope**: Declaring and deploying Fly app and Machine settings; selecting an existing image or a locally built image; publishing changed local images only when needed; using the capability through deploy-rs and Colmena.
- **Out of scope**: Fly account, organization, and user lifecycle; changes to deploy-rs or Colmena; unrelated Fly resources; general-purpose image publishing beyond deployment to Fly.
- **Adjacent expectations**: Fly determines which app and Machine settings it accepts. Operators supply a Fly access token at deployment runtime. Token handling is **wiring**; live deployment checks that need a token are **verification**; obtaining or provisioning the token is operator-owned **provisioning** and is outside this feature.

## Requirements

### Requirement 1: Declarative app and Machine configuration

**Objective:** As a Nix user, I want to declare my Fly app and Machine settings in one place, so that the deployed app reflects the configuration I maintain.

#### Acceptance Criteria

1. When an operator deploys an app declaration, the system shall apply the declared app and Machine settings to the target Fly app.
2. Where an app or Machine setting supported by Fly is declared, the system shall preserve that setting in the deployed app state.
3. Where a Machine declaration includes multiple containers, the deployed Machine shall include each declared container with its declared settings.
4. If Fly rejects a declared setting, the system shall report deployment failure and identify the rejected setting.

### Requirement 2: Image selection and publication

**Objective:** As a Nix user, I want to use an existing image or a locally built image for my Fly app, so that I can deploy the image source I declare.

#### Acceptance Criteria

1. When an existing image reference is selected, the deployed app shall use that reference.
2. When a local image derivation is selected, the system shall build the image locally and make it available to Fly before deploying the app with it.
3. When a local image derivation changes after its image was successfully published, the system shall publish the changed image before deploying the app with it.
4. When deployment is repeated with an unchanged local image derivation whose image was successfully published, the system shall not publish that image again.
5. If building or publishing a local image fails, the system shall report deployment failure and shall not report the app as successfully deployed.

### Requirement 3: Nix deployment tooling compatibility

**Objective:** As an operator using Nix deployment tooling, I want to deploy the Fly app through my normal deployment workflow, so that Fly deployment fits the rest of my Nix-managed configuration.

#### Acceptance Criteria

1. Where deploy-rs is used, the operator shall be able to deploy the Fly app through deploy-rs's normal deployment flow.
2. Where Colmena is used, the operator shall be able to deploy the Fly app through Colmena's normal deployment flow.
3. When deployment succeeds or fails, the invoking deployment tool shall report the corresponding result to the operator without requiring a separate interactive Fly deployment step.

### Requirement 4: Token-only authentication

**Objective:** As an operator, I want to authenticate Fly deployments with only a Fly access token, so that deployment does not depend on an interactive login or another credential service.

#### Acceptance Criteria

1. When a valid Fly access token is supplied at deployment runtime, the system shall authenticate the deployment without requiring an interactive Fly login.
2. The system shall require no credential other than the Fly access token to authenticate with Fly.
3. If the token is missing or rejected, the system shall report an authentication failure and shall not report deployment success.
4. The system shall keep the Fly access token out of derivation inputs, Nix store paths, generated configuration artifacts, and published images.
