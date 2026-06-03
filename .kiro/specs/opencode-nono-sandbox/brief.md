# Brief: opencode-nono-sandbox

## Problem
The operator runs OpenCode with broad filesystem, network, and command access on
personal and Shopify nix-darwin hosts. OpenCode can read files, write files, run
commands, and reach provider and MCP endpoints. Application-level permission
prompts and MCP quarantine reduce risk but do not provide kernel-enforced
containment when a prompt, dependency, tool, or model action goes wrong.

## Current State
OpenCode is installed declaratively through Home Manager. The common module wraps
`pkgs.opencode-pinned` with a `symlinkJoin`/`wrapProgram` layer for mcpproxy
preflight, LSP settings, and host-appended wrapper commands. Shopify also injects
provider proxy credentials through `devx llm-gateway`; both personal and Shopify
hosts route MCP through local mcpproxy.

No repo-owned nono integration exists. The repo has related audit surfaces:
`opencode-cost-report` reads OpenCode's SQLite session database, and cavemem
captures OpenCode tool activity through plugin hooks. These can inform which
tools, commands, paths, sockets, ports, and environment variables previous
sessions used before a sandbox profile is enforced.

## Desired Outcome
OpenCode launches through nono with a repo-managed profile suited to normal
coding sessions. The integration renders a small set of named profiles,
documents their intended risk levels, validates them during builds/checks, and
gives operators staged rollout state (disabled / compatibility-audit / enforced)
plus a per-launch override and rollback path. The historical-usage audit,
compatibility report, and tool-use replacement review live in the sibling spec
`opencode-nono-audit`, which consumes the profiles this feature renders.

## Approach
Declarative, audit-first nono integration. Consume `pkgs.unstable.nono`, add a
Home Manager module that renders nono profile files and the launch contract.

Launch topology (decided 2026-06-03): **preflight launcher → nono → opencode**.
The existing OpenCode preflight/credential/env setup (mcpproxy + obsidian +
cavemem health probes, Shopify `devx` token mint, LSP env/PATH) runs in the
outer launcher, host-privileged, OUTSIDE the sandbox; its results are exported
and passed into the sandbox as environment. `nono` then wraps the bare OpenCode
binary. This keeps `/usr/bin/security`, `/usr/bin/curl`, and macOS Keychain
access OUT of the sandbox — opencode-inside needs only a loopback connection to
mcpproxy (`127.0.0.1:8080`), provider network, `/nix/store` read+exec, and the
inherited env. This inverts the earlier "nono outermost" idea so the sandbox
surface is minimal and no Keychain/secret-tool grants are punched into profiles.

Considered alternatives:
- **nono outermost (preflight inside sandbox)**: the original idea; rejected
  because the fail-closed preflight would force Keychain/`security`/`curl`
  grants inside every profile.
- **Move only secrets to a nono `session_hooks.before` hook**: viable
  alternative that keeps nono outermost; deferred in favor of the simpler outer
  launcher.
- **Single direct wrapper / manual profile**: lose declarative reproducibility,
  host parity, and CI validation.

## Scope
- **In**: declarative nono installation, OpenCode launch wrapping (outer
  preflight launcher + nono), profile file rendering, profile
  validation/introspection checks, operator guide, rollout state + runtime
  override controls, declarative credential/network posture, and host defaults
  for personal and Shopify nix-darwin configurations.
- **Out**: historical usage audit, compatibility report, and tool-use
  replacement review (→ sibling spec `opencode-nono-audit`); modifying nono
  itself; replacing OpenCode permission rules; replacing mcpproxy quarantine;
  changing provider routing; changing cavemem capture; enforcing sandboxing for
  non-OpenCode commands; and Linux/WSL host support beyond avoiding unnecessary
  platform lock-in.

## Boundary Candidates
- **Wrapper integration**: who launches whom, how runtime overrides behave, and
  how existing OpenCode wrapper commands compose with nono.
- **Profile rendering**: declarative profile names, grants, environment policy,
  network posture, rollback/audit settings, and validation outputs.
- **Historical audit**: session/tool inventory, path/socket/network/environment
  extraction, profile compatibility classification, and report format.
- **Operator UX**: documentation, failure messages, one-launch overrides, and
  rollback from enforcing profiles.

## Out of Boundary
- nono upstream feature work or profile-pack publishing.
- New OpenCode permission model design.
- New MCP server authorization or quarantine policy.
- Full provenance for every subprocess, shared library, or dependency loaded by
  OpenCode tools.
- Guaranteeing that every historical session can run unchanged under the strict
  profile.

## Upstream / Downstream
- **Upstream**: `home-manager/common/opencode.nix`, host-specific OpenCode
  modules, `opencode-cost-report`, cavemem OpenCode plugin data, mcpproxy
  migration, RTK OpenCode plugin, session-compaction and subagent-context-budget
  plugins, nixpkgs `nono`, and nono's built-in `opencode` profile.
- **Downstream**: future stricter profile tuning, host-specific grants for
  Shopify workflows, possible credential-injection migration, and post-rollout
  nono audit review.

## Existing Spec Touchpoints
- **Extends**: none.
- **Adjacent**: `opencode-cost-diagnosis` for SQLite reader patterns,
  `mcpproxy-migration` for MCP routing assumptions, `rtk-install` for OpenCode
  wrapper/plugin rollout patterns, `session-compaction` and
  `subagent-context-budget` for OpenCode plugin coexistence.

## Constraints
- macOS/nix-darwin first.
- Declarative through Nix/Home Manager; no imperative profile setup as the source
  of truth.
- Preserve existing OpenCode behavior unless sandbox policy intentionally blocks
  it.
- Do not expose provider API keys or MCP API keys in generated files.
- Use nono's current profile schema and validation tools; avoid deprecated policy
  fields unless needed for compatibility with the packaged version.
- Historical audit must be schema-defensive because OpenCode session DB shapes
  can drift.
