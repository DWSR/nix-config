# Requirements Document

## Introduction

The personal Tailscale service feature makes tailnet-private local service exposure declarative for the personal macOS laptop. See `brief.md` for the problem statement, approach, and scope constraints.

## Boundary Context

- **In scope**: Tailnet-private port and localhost proxy entries declared in Home Manager, activation-time convergence when entries exist, configurable Tailscale CLI path, personal-host dormant coverage, and render tests for disabled and declared states.
- **Out of scope**: Selecting or declaring initial personal service entries, installing or managing `tailscaled`, replacing Tailscale.app, Tailscale Funnel/public exposure, file or directory serving, first-run Serve/HTTPS consent, login state, tailnet ACLs, certificates, device authorization, and broad cleanup of unmanaged Serve state.
- **Adjacent expectations**: Tailscale.app is installed and logged in before activation. Any first-run Serve/HTTPS consent is completed outside the Home Manager switch.

## Requirements

### Requirement 1: Declarative tailnet-private entries
**Objective:** As the personal laptop owner, I want local service exposure declared in Home Manager, so that desired Tailscale Serve state is visible in Nix configuration.

#### Acceptance Criteria
1. When one or more Serve entries are declared, the Tailscale Serve configuration shall represent each entry as desired tailnet-private proxy exposure state.
2. Where a Serve entry is included, the Tailscale Serve configuration shall support proxying to a local TCP port or localhost URL target.
3. If a declaration requests Funnel, file serving, directory serving, or a non-local target, then the Tailscale Serve configuration shall reject the declaration before activation.
4. While no Serve entries are declared, the Tailscale Serve configuration shall emit no Serve convergence behavior.
5. The Tailscale Serve configuration shall keep the Tailscale CLI path configurable for supported macOS app variants.

### Requirement 2: Personal host readiness
**Objective:** As the personal laptop owner, I want `Brandons-MacBook-Pro` to have the declarative Serve module available without exposing a service yet, so that service declarations can be added later with bounded configuration changes.

#### Acceptance Criteria
1. When the personal Home Manager configuration is evaluated, the personal host configuration shall have the Tailscale Serve option namespace available through its common Home Manager imports.
2. While no personal Serve entries are declared, the personal host configuration shall render no Serve convergence behavior.
3. The personal host configuration shall not expose any local service until a later configuration change declares entries.
4. The personal host configuration shall leave Tailscale login state, tailnet ACLs, certificates, and device authorization as external prerequisites.

### Requirement 3: Activation-time convergence
**Objective:** As the personal laptop owner, I want Home Manager activation to apply declared Serve entries, so that switching configuration reconciles the laptop's tailnet exposure.

#### Acceptance Criteria
1. When Home Manager activation runs with supported Serve entries, the Tailscale Serve configuration shall converge each declared entry through the existing macOS Tailscale app.
2. If the configured Tailscale CLI is unavailable, then the Tailscale Serve configuration shall fail activation with a message identifying the missing CLI path.
3. If applying a declared Serve entry fails, then the Tailscale Serve configuration shall fail activation with a message identifying the affected entry.
4. While activation runs noninteractively, the Tailscale Serve configuration shall not prompt for first-run consent, login, or device authorization.
5. The Tailscale Serve configuration shall not install, stop, start, or replace `tailscaled`.
6. The Tailscale Serve configuration shall not clear unmanaged Serve state outside the declared entries.

### Requirement 4: Rendered verification
**Objective:** As the repository maintainer, I want automated checks for the declarative Serve behavior, so that future changes do not silently change exposure semantics.

#### Acceptance Criteria
1. When the feature is disabled or has no entries, the repository checks shall verify that no Serve convergence behavior is rendered.
2. When supported Serve entries are declared, the repository checks shall verify that the rendered Home Manager state contains the expected entries and activation behavior.
3. If unsupported exposure declarations are evaluated, then the repository checks shall verify that evaluation fails before activation.
4. When the personal host configuration is evaluated, the repository checks shall verify that the Tailscale Serve option namespace is available and dormant without personal entries.
