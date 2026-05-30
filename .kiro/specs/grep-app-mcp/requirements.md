# Requirements Document

## Introduction

This spec adds `ai-tools-all/grep_app_mcp` as a declarative grep.app MCP
upstream for this nix-darwin Home Manager config. Background and boundary
decisions are in `.kiro/specs/grep-app-mcp/brief.md`.

## Boundary Context

- **In scope**: reproducible Nix packaging, a stable stdio launcher,
  both-host mcpproxy upstream registration, and deterministic package /
  render checks.
- **Out of scope**: direct opencode MCP entries, new long-running HTTP
  service ownership, new secrets, mcpproxy daemon behaviour changes,
  AGENTS.md startup-gate changes, and live grep.app/GitHub API tests.
- **Adjacent expectations**: `mcpproxy-migration` remains authoritative
  for the daemon, retrieve_tools routing, launchd, and the opencode MCP
  endpoint. This spec only adds an upstream server through existing
  extension points.

## Requirements

### Requirement 1: Reproducible package

**Objective:** As the operator, I want `grep_app_mcp` packaged through the repo overlay so that it installs and builds reproducibly with the rest of the MCP toolchain.

#### Acceptance Criteria

1. When the package attribute is evaluated, the Nix overlay shall fetch `ai-tools-all/grep_app_mcp` from a pinned GitHub source.
2. When the package builds, the package derivation shall use locked npm dependencies or an equivalent fixed-output dependency hash.
3. The package shall expose a stable executable for the grep.app MCP server.
4. The package metadata shall include a description, homepage, license, and main program.
5. The package shall not require any operator-local checkout or imperative `npm install` step.

### Requirement 2: mcpproxy upstream registration

**Objective:** As an opencode user, I want the grep.app MCP server available through mcpproxy on both hosts so that public-code search tools are discoverable through the existing four-tool surface.

#### Acceptance Criteria

1. When the personal host configuration renders mcpproxy config, the config shall include a `grep-app` upstream server entry.
2. When the Shopify host configuration renders mcpproxy config, the config shall include a `grep-app` upstream server entry.
3. The `grep-app` upstream shall run through stdio unless a later design finding proves stdio cannot support the required tools.
4. The upstream registration shall not add or modify any direct `programs.opencode.settings.mcp` entry.
5. The upstream registration shall not add any new required Keychain or file-sourced secret.

### Requirement 3: Tool discovery and invocation contract

**Objective:** As an agent, I want grep.app tools reachable through mcpproxy's existing read-call path so that code search does not expand the primary MCP schema surface.

#### Acceptance Criteria

1. When mcpproxy is running with the rendered host config, `retrieve_tools` shall be able to discover the grep.app upstream tools by a query that mentions grep.app or public GitHub code search.
2. When a grep.app search tool is invoked, the call shall route through `call_tool_read`, not through write or destructive tool wrappers.
3. The grep.app upstream shall expose search and file-retrieval tools without changing mcpproxy's `routing_mode` value.
4. The integration shall preserve mcpproxy's existing hidden-upstream-schema contract; opencode still sees the four mcpproxy wrapper tools rather than raw grep.app tool schemas.

### Requirement 4: Deterministic verification

**Objective:** As the operator, I want local checks to prove the package and rendered configuration without depending on live third-party services.

#### Acceptance Criteria

1. The flake shall expose a check that builds or smoke-tests the grep.app MCP package.
2. The verification shall prove the package executable exists and can reach a non-network startup or help/version path when upstream supports one.
3. The verification shall render both host mcpproxy configurations and assert that `grep-app` points at the packaged executable.
4. The verification shall not call grep.app, GitHub raw file endpoints, or other live network APIs.
5. The verification shall run under `nix flake check` on `aarch64-darwin`.

### Requirement 5: Operator boundaries

**Objective:** As the operator, I want the integration to stay isolated from existing MCP and opencode contracts so that adding public-code search does not destabilize memory, Shopify, or local tooling.

#### Acceptance Criteria

1. The integration shall preserve existing upstream server entries for obsidian, github, mcp-nixos, cavemem, and host-specific servers.
2. The integration shall preserve the opencode wrapper preflight semantics and shall not make grep.app a startup-gate dependency.
3. If the upstream package cannot start or build, the failure shall identify the grep.app package or upstream entry instead of failing through unrelated MCP components.
4. The integration shall not introduce a new launchd agent, TCP port, or background service outside mcpproxy.
5. The integration shall document any upstream limitation discovered during packaging or verification that affects operator use.
