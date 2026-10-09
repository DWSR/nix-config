# Requirements Document

## Introduction

The personal nix-darwin host runs the omlx inference server and opencode's
`provider.omlx` targets `http://localhost:8000/v1`. The old Homebrew service
that kept the server running was removed with the brew path. This feature adds
a personal-only Home Manager module that declares `omlx serve` as a launchd
user agent so the server starts at login, restarts on crash, and stays
reachable by opencode.

## Boundary Context

- **In scope**: launchd user agent for `omlx serve`, host/port/extra-args
  options, log capture under `~/Library/Logs/omlx/`, personal-host wiring,
  render tests.
- **Out of scope**: model provisioning, LAN host binding, API-key management,
  Swift app integration, shared-host or `home-manager/common/` wiring.
- **Adjacent expectations**: `pkgs.omlx` is installed via the existing
  `home.packages` entry; opencode's `provider.omlx` consumes
  `http://localhost:8000/v1`; the API key is a client-side opencode keychain
  env flow, not a service concern.

## Requirements

### Requirement 1: Service lifecycle

**Objective:** As the personal host user, I want the omlx server to start
automatically at login and stay running, so that opencode's omlx provider is
reachable without manual intervention.

#### Acceptance Criteria

1. When the user logs in, the omlx service shall start the omlx server.
2. If the omlx server process exits, the omlx service shall restart it.
3. The omlx service shall run the server as the logged-in user.

### Requirement 2: Server endpoint configuration

**Objective:** As the personal host user, I want to configure the server's
bind host and port, so that the server listens where opencode expects it.

#### Acceptance Criteria

1. The omlx service shall bind the server to host 127.0.0.1 by default.
2. The omlx service shall bind the server to port 8000 by default.
3. When the user configures a custom host or port, the omlx service shall bind
   the server to that host and port.
4. The omlx service shall pass additional command-line arguments through to
   the server.

### Requirement 3: Logging

**Objective:** As the personal host user, I want server output captured to
log files, so that I can diagnose server issues.

#### Acceptance Criteria

1. The omlx service shall capture the server's standard output to a log file
   under `~/Library/Logs/omlx/`.
2. The omlx service shall capture the server's standard error to a log file
   under `~/Library/Logs/omlx/`.
3. The omlx service shall create the log directory if it does not exist.

### Requirement 4: Module enablement and packaging

**Objective:** As the personal host user, I want to enable the service through
Home Manager configuration, so that the service is declaratively managed.

#### Acceptance Criteria

1. Where the omlx service module is enabled, the Home Manager configuration
   shall register the omlx launchd agent.
2. Where the omlx service module is disabled, the Home Manager configuration
   shall not register the omlx launchd agent.
3. The omlx service module shall use the omlx package installed on the host by
   default.

### Requirement 5: Render tests

**Objective:** As the repo maintainer, I want render tests for the module, so
that the generated agent configuration is verified.

#### Acceptance Criteria

1. The module's render test shall assert that the default configuration
   registers the launchd agent with host 127.0.0.1 and port 8000.
2. The module's render test shall assert that a custom configuration
   registers the launchd agent with the custom host and port.
3. The module's render test shall assert that the disabled configuration
   registers no launchd agent.
