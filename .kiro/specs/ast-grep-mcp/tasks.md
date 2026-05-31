# Implementation Plan

- [ ] 1. Add deterministic ast-grep MCP package support
- [x] 1.1 Package the upstream stdio server (P)
  - Add `pkgs.ast-grep-mcp` to `overlays/mcp-servers.nix` from a pinned `ast-grep/ast-grep-mcp` source.
  - Install a stable `ast-grep-mcp` wrapper that runs the upstream Python entrypoint with Python dependencies and `pkgs.ast-grep` on `PATH`.
  - Include package metadata for description, homepage, license, and main program.
  - Completed when `nix build` can build the package and the output contains `bin/ast-grep-mcp` with expected metadata.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - _Boundary: Package_
- [x] 1.2 Verify startup and configuration behavior
  - Verify `ast-grep-mcp --help` exits cleanly and no server startup requires a project path, secret, or writable CWD.
  - Document optional `--config` / `AST_GREP_CONFIG` behavior only if packaging exposes it cleanly.
  - Completed when the package has a finite non-search smoke path and any operator-facing limitation is captured.
  - _Requirements: 1.3, 2.6, 4.2, 5.3, 5.5_
  - _Boundary: Package_
  - _Depends: 1.1_

- [ ] 2. Register ast-grep through mcpproxy host configs
- [x] 2.1 Add the personal host upstream entry (P)
  - Add `home.mcp.extraServers.ast-grep` in the personal Home Manager config using the packaged stdio command.
  - Preserve existing personal upstream entries and do not add secrets, direct opencode MCP entries, or launchd services.
  - Completed when the personal rendered mcpproxy config contains a stdio `ast-grep` server pointing at `pkgs.ast-grep-mcp`.
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 3.3, 3.4, 5.1, 5.2, 5.4_
  - _Boundary: Host Registration_
  - _Depends: 1.2_
- [x] 2.2 Add the Shopify host upstream entry (P)
  - Add `home.mcp.extraServers.ast-grep` in the Shopify Home Manager config using the packaged stdio command.
  - Preserve all existing Shopify upstream entries and file-sourced env behavior.
  - Completed when the Shopify rendered mcpproxy config contains a stdio `ast-grep` server pointing at `pkgs.ast-grep-mcp`.
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 3.3, 3.4, 5.1, 5.2, 5.4_
  - _Boundary: Host Registration_
  - _Depends: 1.2_

- [ ] 3. Add render and package verification
- [x] 3.1 Create the ast-grep MCP test suite
  - Add `tests/ast-grep-mcp/hm-render.test.js` with Nix eval helpers local to the suite.
  - Assert package metadata/output shape, `--help` smoke behavior, personal and Shopify rendered upstream entries, preservation of existing required upstreams, absence of direct opencode MCP entries, and absence of new required secrets.
  - Completed when `node --test tests/ast-grep-mcp/` runs without invoking ast-grep search tools against the repo.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3_
  - _Boundary: Validation_
  - _Depends: 1.2, 2.1, 2.2_
- [ ] 3.2 Add the flake check
  - Wire `checks.aarch64-darwin.ast-grep-mcp` in `flake.nix` to run the new test suite in a copied writable source with Nix flakes enabled.
  - Keep the check deterministic and free of live tool invocations.
  - Completed when `nix build .#checks.aarch64-darwin.ast-grep-mcp` passes.
  - _Requirements: 4.1, 4.4, 4.5_
  - _Boundary: Validation_
  - _Depends: 3.1_

- [ ] 4. Integration verification and operator notes
- [ ] 4.1 Verify repository checks and upstream limitations
  - Run the targeted ast-grep check and `nix flake check --show-trace`.
  - Document any upstream limitation that affects operator use in `tests/ast-grep-mcp/README.md`.
  - Completed when the full check suite passes and limitations are captured.
  - _Requirements: 4.5, 5.3, 5.5_
  - _Boundary: Validation_
  - _Depends: 3.2_
- [ ] 4.2 Add post-switch mcpproxy smoke guidance
  - Add concise operator guidance in `tests/ast-grep-mcp/README.md` for discovering ast-grep tools through mcpproxy `retrieve_tools` after `darwin-rebuild switch` restarts mcpproxy.
  - Include the expected discovery shape: ast-grep tools are returned with a `call_with` value and invoked only through the matching mcpproxy wrapper.
  - Document that file-search tools require an explicit absolute `project_folder` chosen by the operator.
  - Keep ast-grep out of the mandatory opencode startup gate and avoid automated repository searches.
  - Completed when the repo documents how to verify that `ast-grep` is connected and discoverable through mcpproxy after activation.
  - _Requirements: 3.1, 3.2, 3.4, 3.5, 5.2, 5.5_
  - _Boundary: Validation_
  - _Depends: 3.2_

## Implementation Notes

- Upstream is Python 3.13, package name `sg-mcp`, version `0.1.0`, MIT license, and current researched commit `732c339c3812a44e9111e6c3aefec64894acd58f`.
- Upstream defaults to stdio and `--help` exits through argparse before starting the MCP server.
- The MCP search tools require explicit absolute `project_folder` values; tests must not run them against the user's repo.
- Task 1.1: upstream `pyproject.toml` has no `[build-system]`; package uses a wrapper derivation with `python313.withPackages` and prepends `pkgs.ast-grep` to `PATH`.
- Task 1.2: `ast-grep-mcp --help` is the finite smoke path; default stdio starts from read-only CWD with closed stdin, and nonexistent `--config` / `AST_GREP_CONFIG` paths exit 1 at startup.
