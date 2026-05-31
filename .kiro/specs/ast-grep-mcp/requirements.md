# Requirements Document

## Introduction

This spec adds `ast-grep/ast-grep-mcp` as a declarative structural-code-search MCP upstream for this nix-darwin Home Manager config. Background and boundary decisions are in `.kiro/specs/ast-grep-mcp/brief.md`.

## Boundary Context

- **In scope**: reproducible Nix packaging, `ast-grep` CLI runtime availability, a stable stdio launcher, both-host mcpproxy upstream registration, and deterministic package/render checks.
- **Out of scope**: direct opencode MCP entries, new long-running HTTP/SSE service ownership, new secrets, mcpproxy daemon behavior changes, AGENTS.md startup-gate changes, and automated searches over the operator's repositories.
- **Adjacent expectations**: `mcpproxy-migration` remains authoritative for the daemon, retrieve_tools routing, launchd, and the opencode MCP endpoint. This spec only adds an upstream server through existing extension points.

## Requirements

### Requirement 1: Reproducible package

**Objective:** As the operator, I want `ast-grep-mcp` packaged through the repo overlay so that it installs and starts reproducibly with the rest of the MCP toolchain.

#### Acceptance Criteria

1. When the package attribute is evaluated, the Nix overlay shall fetch `ast-grep/ast-grep-mcp` from a pinned GitHub source.
2. When the package builds, the package shall use Nix-resolved Python dependencies with fixed inputs.
3. The package shall make the `ast-grep` CLI available to the MCP server at runtime.
4. The package shall expose a stable executable for the ast-grep MCP stdio server.
5. The package metadata shall include a description, homepage, license, and main program.
6. The package shall not require an operator-local checkout, `uv sync`, or imperative Python environment setup.

### Requirement 2: mcpproxy upstream registration

**Objective:** As an opencode user, I want the ast-grep MCP server available through mcpproxy on both hosts so that structural search tools are discoverable through the existing four-tool surface.

#### Acceptance Criteria

1. When the personal host configuration renders mcpproxy config, the config shall include an `ast-grep` upstream server entry.
2. When the Shopify host configuration renders mcpproxy config, the config shall include an `ast-grep` upstream server entry.
3. The `ast-grep` upstream shall run through stdio unless a later design finding proves stdio cannot support the required tools.
4. The upstream registration shall not add or modify any direct `programs.opencode.settings.mcp` entry.
5. The upstream registration shall not add any new required Keychain or file-sourced secret.
6. The upstream registration shall not require a default project path argument.

### Requirement 3: Tool discovery and invocation contract

**Objective:** As an agent, I want ast-grep tools reachable through mcpproxy's existing wrapper calls so that structural search does not expand the primary MCP schema surface.

#### Acceptance Criteria

1. When mcpproxy is running with the rendered host config, `retrieve_tools` shall be able to discover the ast-grep upstream tools by a query that mentions ast-grep or structural code search.
2. When an ast-grep read-only tool is invoked, the call shall route through the mcpproxy wrapper indicated by the tool's `call_with` field.
3. The ast-grep upstream shall expose syntax-tree, rule-test, pattern-search, and YAML-rule-search capabilities without changing mcpproxy's `routing_mode` value.
4. The integration shall preserve mcpproxy's hidden-upstream-schema contract; opencode still sees the four mcpproxy wrapper tools rather than raw ast-grep tool schemas.
5. Tools that search files shall require an explicit absolute project path from the caller.

### Requirement 4: Deterministic verification

**Objective:** As the operator, I want local checks to prove the package and rendered configuration without running live searches over my repositories.

#### Acceptance Criteria

1. The flake shall expose a check that builds or smoke-tests the ast-grep MCP package.
2. The verification shall prove the package executable exists and has a finite startup/help path when upstream supports one.
3. The verification shall render both host mcpproxy configurations and assert that `ast-grep` points at the packaged executable.
4. The verification shall not call `find_code`, `find_code_by_rule`, or any other tool against the user's repository tree.
5. The verification shall run under `nix flake check` on `aarch64-darwin`.

### Requirement 5: Operator boundaries

**Objective:** As the operator, I want the integration isolated from existing MCP and opencode contracts so that adding structural search does not destabilize memory, Shopify, or local tooling.

#### Acceptance Criteria

1. The integration shall preserve existing upstream server entries for obsidian, github, mcp-nixos, cavemem, grep-app, and host-specific servers.
2. The integration shall preserve the opencode wrapper preflight semantics and shall not make ast-grep a startup-gate dependency.
3. If the upstream package cannot start or build, the failure shall identify the ast-grep MCP package or upstream entry instead of failing through unrelated MCP components.
4. The integration shall not introduce a new launchd agent, TCP port, or background service outside mcpproxy.
5. The integration shall document any upstream limitation discovered during packaging or verification that affects operator use.
