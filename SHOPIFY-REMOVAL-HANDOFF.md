# Shopify Configuration Removal Handoff

## Objective

Retire the Shopify host and remove Shopify-specific code, configuration,
secrets, tests, and active operational documentation from this repository. Keep
the personal host and genuinely shared functionality working.

This is an implementation plan, not authorization to decommission external
machines, revoke credentials, or rewrite Git history.

## Scope Decisions

- Remove the `ShopifyLaptop` flake configuration and its host-only modules,
  integrations, workflows, and dependencies.
- Remove Shopify-specific branches from shared modules and scripts, but keep
  their personal-host behavior and non-Shopify consumers.
- Preserve `pkgs.shadowenv`: it is installed from
  `home-manager/common/default.nix` and used by the personal host. Its Shopify
  upstream origin does not make it Shopify-host-specific.
- Remove the `shadowenv.vim` overlay/plugin if it has no remaining consumers
  once the Shopify host is removed. It is sourced from Shopify's repository,
  but currently enabled only in Shopify configuration.
- Remove the generic Quick package-builder helper in
  `overlays/misc.nix` only after confirming it has no remaining callsites. Its
  sole known caller is the Shopify host.
- Update current documentation that describes active Shopify behavior. Keep
  historical design records unless a separate requirement calls for a
  zero-reference scrub. Remove the dedicated Shopify remote-builder spec with
  that feature.
- Retain common Pi, shared GitHub Stack support, shared SOPS infrastructure,
  the personal local binary cache, and other components with non-Shopify
  consumers.

## Implementation Steps

### 1. Confirm operational boundary

- Confirm the whole Shopify host is being retired, rather than only selected
  applications.
- Identify any account-managed services, machine state, or credentials that
  need separate external decommissioning.
- Check for repository changes made after this handoff was prepared; preserve
  unrelated work.

### 2. Remove Shopify from shared tests and host matrices

- In `flake.nix`, remove Shopify host projections and every check/test
  reference to `darwinConfigurations.ShopifyLaptop`. Keep personal-host
  coverage.
- In shared test suites, convert multi-host projections to personal-only
  while retaining assertions for shared behavior. Review at least:
  `tests/local-binary-cache/`, `tests/agentmemory-opencode/`,
  `tests/grep-app-mcp/`, `tests/opencode-nono/`, and host-matrix checks for
  Deskflow, Hammerspoon, Nixvim, and SQLite backup.
- Remove host-only tests such as
  `tests/agentmemory-opencode/shopify-agent-prompts.test.js` and
  `tests/binks-pr-review/` where they have no non-Shopify purpose.

### 3. Narrow shared cache and credential flows

- In `configurations/common-darwin/local-binary-cache.nix`, remove Shopify
  roles, publisher/consumer branches, token handling, and Shopify-specific
  assertions. Keep the personal cache endpoint and supported personal flows.
- In `configurations/personal/default.nix` and
  `scripts/local-binary-cache-bootstrap.nix`, remove Shopify token output and
  issuance paths while preserving personal token setup.
- Delete Shopify-only cache integration scripts under
  `tests/local-binary-cache/` and update shared cache render and publisher
  tests to verify the remaining personal configuration.
- Keep the generic SOPS bridge. Remove Shopify host examples/comments from
  `configurations/common-darwin/mcp-sops-bridge.nix` only where they describe
  retired active configuration.

### 4. Remove the Shopify host and its integrations

- Remove `configurations/shopify/` and its Home Manager tree, including its
  OpenCode, Pi, Deskflow, Git, dev, SQLite backup, Zellij, browser, agent,
  command, and skill configuration.
- Remove the Shopify-private `builtins.fetchGit` sources and Shopify-specific
  Homebrew taps/packages declared by that host.
- Remove the `bump-shopify-taps` flake app and `scripts/bump-shopify-taps.nix`
  registration in `flake.nix`.
- Remove Shopify-only Pi proxy/Aquifer and Binks review helpers, including
  `scripts/pi-shopify.nix`, `scripts/shopify-pi-proxy.nix`,
  `scripts/pi-aquifer.nix`, `scripts/binks-review.nix`, and their host-only
  tests/configuration.
- Remove Shopify-only overlay packages or integration modules after checking
  for remaining references. In particular, check the `shadowenv.vim` package
  in `overlays/misc.nix` and its Nixvim module before deleting either.
- Remove the Quick package-builder helper from `overlays/misc.nix` if the
  Shopify host is its only caller.
- Do not remove the `pi` flake input or common Pi configuration; both are used
  outside the Shopify host.

### 5. Remove the remote-builder feature as a unit

- Delete `configurations/common-darwin/shopify-remote-builder.nix`.
- Delete `scripts/shopify-remote-builder-*.nix` helpers and
  `tests/shopify-remote-builder/`.
- Delete `.kiro/specs/shopify-remote-builder/` and update
  `docs/dead-nix-cleanup-ledger.md` so it no longer recommends retaining the
  feature.
- Check for external or operator consumers before removing any separately
  documented interface; the module is not imported by the normal
  `common-darwin/default.nix` path, but it contains both Shopify and personal
  endpoint concepts.

### 6. Remove Shopify secrets and narrow generic scripts

- Delete `secrets/mcp.shopify.yaml`, `secrets/deskflow-cert.shopify.yaml`, and
  `secrets/local-binary-cache.shopify.yaml`.
- Remove the Shopify age recipient and file rules from `.sops.yaml` while
  retaining personal SOPS configuration.
- Narrow reusable scripts rather than deleting them where personal behavior
  remains: `scripts/mcp-sync-from-1password.nix`,
  `scripts/mcp-verify-secrets.nix`, `scripts/bootstrap-nix-github-token.sh`,
  and `scripts/deskflow-generate-cert.sh`.
- Remove Shopify-specific host records, environment variables, examples, and
  help text from those scripts. Keep generic support used by the personal
  configuration.
- Removing encrypted files does not revoke credentials or erase prior Git
  history. Handle credential revocation and any history rewrite separately.

### 7. Remove Shopify-only agent-budget data

- Remove Shopify agent budget entries and prompt/profile fragments from
  `home-manager/common/subagent-context-budget/budgets.nix`,
  `home-manager/common/subagent-context-budget/plugin.ts`, and
  `home-manager/common/subagent-context-budget/smoke-catalog.json`.
- Remove Shopify host-scope inference/validation from
  `home-manager/common/subagent-context-budget.nix` and
  `scripts/subagent-context-budget.js` if no remaining host uses it.
- Keep the shared budget framework and generic tests.

### 8. Update active documentation

- Update `secrets/README.md` to document only the remaining host setup.
- Update active `.kiro/specs/` and docs that promise Shopify host behavior or
  describe multi-host operation that will no longer exist. Review at least
  local binary cache, SQLite backup, Deskflow, AgentMemory, and
  `docs/agentmemory-performance-risks.md`.
- Remove or revise Shopify setup guidance in shared agent documentation such
  as `home-manager/common/agents/nix-pkg.md`.
- Keep historical records when clearly historical; do not leave obsolete
  Shopify runbooks presented as current instructions.

## Validation and Completion Criteria

- Search tracked source/config/docs for `ShopifyLaptop`,
  `configurations/shopify`, Shopify domains, `SHOPIFY_*`, Shopify cache-token
  identifiers, removed script/app names, and Shopify host-scope values.
- Review every remaining match and classify it as historical context, generic
  test data, upstream provenance, or an accidental active dependency. There
  should be no Shopify-specific active configuration or executable path.
- Evaluate the remaining personal Darwin configuration and run the applicable
  flake checks.
- Run affected tests for local binary cache, SOPS/secret tooling, AgentMemory,
  Deskflow, OpenCode integrations, and subagent context budgets.
- Confirm the Shopify host output is absent and no check or module evaluation
  still dereferences it.
- Confirm retained common and personal behavior, including `pkgs.shadowenv`,
  common Pi, personal cache operation, and personal secrets.
- Report any external decommissioning or credential revocation that remains
  outstanding; repository removal does not perform those actions.

## Key Risk

`flake.nix` contains many host-specific checks and consumers. Removing the
Shopify host before narrowing those references can break flake evaluation.
Remove or adapt host-matrix references first, then delete the host output and
host tree.
