# Requirements Document

## Introduction
This feature adds a Home Manager module that declaratively renders Deskflow's
macOS settings from a typed options schema supporting client and server roles.
Problem, approach, and scope live in `.kiro/specs/deskflow-config/brief.md`; this
document specifies operator-observable behavior only.

## Boundary Context
- **In scope**: a role-aware Deskflow Home Manager module; rendering a curated
  settings file and, for the server role, an external screen-layout file;
  pinning the TLS identity certificate path + key size and read-only pre-seeding
  of trusted-peer fingerprints; read-only delivery at Deskflow's macOS paths;
  ShopifyLaptop client wiring; evaluation-time and flake-check validation.
- **Out of scope**: the Homebrew cask install (owned by `common-darwin`);
  generating or encrypting the certificate material itself and the sops/age key
  lifecycle; runtime interactive trust additions and certificate auto-generation
  when a managed cert is supplied; the GUI-managed `internalConfig` layout blob;
  server tuning keys Deskflow 1.26 stores only inside `internalConfig`
  (lock-to-computer, switch delay, grid, protocol); non-macOS platforms;
  core/daemon autostart; the full settings surface beyond the curated subset.
- **Adjacent expectations**: Deskflow 1.26.0 is installed via the existing cask and
  reads `~/Library/Deskflow/Deskflow.conf` (`QSettings` IniFormat). The module
  relies on Deskflow ignoring absent keys and applying its built-in defaults for
  any key the module omits, and on Deskflow purging empty-valued keys on launch.
  Certificate material is provided as a decrypted file path by a host-level
  secrets mechanism (sops-nix); the module references that path and never holds
  the private key. The trusted-peer store is a text file of `v2:sha256:<hex>` lines.

## Requirements

### Requirement 1: Module enablement and role selection
**Objective:** As an operator, I want to enable Deskflow configuration per host and choose its role, so that each machine gets exactly the client or server configuration it needs.

#### Acceptance Criteria
1. The Deskflow module shall be disabled by default and shall render no Deskflow files while disabled.
2. Where the module is enabled, the Deskflow module shall require exactly one role with the value `client` or `server`.
3. If the module is enabled without a valid role, the Deskflow module shall fail evaluation with a message naming the required option.
4. While the module is enabled, the Deskflow module shall render exactly one `~/Library/Deskflow/Deskflow.conf` for the host.

### Requirement 2: Curated shared settings
**Objective:** As an operator, I want a curated set of common Deskflow preferences rendered from options, so that the settings I care about are reproducible and the file stays free of volatile churn.

#### Acceptance Criteria
1. While the module is enabled, the Deskflow module shall render `Deskflow.conf` containing only the curated keys it manages.
2. When an operator sets a managed preference (computer name, network port, TLS enablement, peer-fingerprint checking, log level, log-to-file destination, GUI auto-hide, close-to-tray, start-core-with-GUI), the Deskflow module shall write the corresponding Deskflow key with that value.
3. The Deskflow module shall omit any curated key whose value is unset rather than writing an empty value.
4. Where the operator does not set the computer name, the Deskflow module shall omit the computer-name key so Deskflow falls back to the machine hostname.
5. The Deskflow module shall default TLS to enabled and peer-fingerprint checking to enabled.
6. The Deskflow module shall not write keys outside the curated set, including volatile keys such as window geometry and first-run message flags.

### Requirement 3: Client role
**Objective:** As an operator of a client host, I want the machine configured to connect to a Deskflow server, so that it receives shared keyboard and mouse input.

#### Acceptance Criteria
1. While the role is `client`, the Deskflow module shall set Deskflow to client mode (`core/coreMode=1`).
2. When the operator sets the server-address option, the Deskflow module shall write it to the client remote-host key.
3. While the role is `client` and the server address is unset, the Deskflow module shall omit the remote-host key, render a visible TODO placeholder indicating the address must be supplied, and still evaluate successfully.
4. Where the role is `client`, the Deskflow module shall expose scroll options (invert horizontal, invert vertical, horizontal scale, vertical scale) and language sync, each defaulting to Deskflow's default (no inversion, scale 1.0, language sync enabled).

### Requirement 4: Server role
**Objective:** As an operator of a server host, I want the screen layout and server behavior defined declaratively, so that the server shares input across a reviewable, reproducible computer arrangement.

#### Acceptance Criteria
1. While the role is `server`, the Deskflow module shall set Deskflow to server mode (`core/coreMode=2`).
2. While the role is `server`, the Deskflow module shall enable external server configuration and point Deskflow at a module-managed external layout file.
3. Where the role is `server`, the Deskflow module shall render the external layout file in Deskflow's textual server-config format from screen, link, alias, and option inputs.
4. If the role is `server` and no screens are defined, the Deskflow module shall fail evaluation with a message naming the required layout option.
5. If a link or alias references a screen that is not defined, the Deskflow module shall fail evaluation identifying the unknown screen.

### Requirement 5: Read-only delivery and filesystem coexistence
**Objective:** As an operator, I want the configuration owned by Nix at Deskflow's real config path, so that the declared settings are the source of truth and first-connection security still works.

#### Acceptance Criteria
1. While the module is enabled, the Deskflow module shall deliver its rendered file(s) under Deskflow's macOS user settings location (`~/Library/Deskflow/`).
2. The Deskflow module shall deliver the rendered settings file as read-only, so that changing settings in the Deskflow GUI does not overwrite the declared configuration.
3. The Deskflow module shall leave `~/Library/Deskflow/` writable for Deskflow's runtime files (logs, and the TLS trust store when it is not managed under Requirement 8).
4. The Deskflow module shall never write a certificate private key into the Nix store; managed certificates are referenced by path only.

### Requirement 6: Host wiring
**Objective:** As the operator, I want ShopifyLaptop configured as a Deskflow client, so that the feature is actually applied to a real machine.

#### Acceptance Criteria
1. When the ShopifyLaptop configuration is evaluated, the Deskflow module shall be enabled in the client role.
2. While ShopifyLaptop has no server address set, the configuration shall evaluate successfully with the TODO placeholder.
3. The Deskflow module shall remain disabled on any other host unless that host explicitly opts in.
4. When either `darwinConfigurations` host is evaluated, the configuration shall complete without error.

### Requirement 7: Verification
**Objective:** As a reviewer, I want automated checks of the rendered configuration, so that regressions in rendering or wiring are caught before a rebuild.

#### Acceptance Criteria
1. The configuration build shall provide a flake check asserting that the ShopifyLaptop rendered settings contain client mode and the expected curated keys.
2. Where the server role is exercised by a fixture, the flake check shall assert the external layout renders the expected screens and links.
3. If rendering emits a curated key with an empty value, the flake check shall fail.
4. Where trusted-peer fingerprints are exercised by a fixture, the flake check shall assert the trust file renders the expected `v2:sha256:` lines, and that an invalid fingerprint fails evaluation.

### Requirement 8: Certificate and trusted-peer management
**Objective:** As an operator, I want Deskflow's TLS identity certificate and trusted peers defined declaratively, so that fingerprints are stable across rebuilds and the first connection needs no interactive approval.

#### Acceptance Criteria
1. Where a certificate path is provided, the Deskflow module shall set `security/certificate` to that path, without embedding the certificate or its private key in the Nix store.
2. The Deskflow module shall expose a key-size option constrained to 2048 or 4096 and write it to `security/keySize`.
3. Where trusted-peer fingerprints are provided, the Deskflow module shall render them read-only to the role-appropriate trust file (`tls/trusted-servers` for client, `tls/trusted-clients` for server), one per line as `v2:sha256:<hex>`.
4. If a provided fingerprint is not a valid SHA-256 (64 hex) or SHA-1 (40 hex) value, the Deskflow module shall fail evaluation identifying the offending entry.
5. While no trusted-peer fingerprints are provided, the Deskflow module shall not manage the trust file, leaving Deskflow's interactive trust behavior intact.
6. While no certificate path is provided, the Deskflow module shall omit `security/certificate`, leaving Deskflow to self-generate its certificate.
