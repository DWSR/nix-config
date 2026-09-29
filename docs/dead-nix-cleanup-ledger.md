# Dead Nix cleanup reachability ledger

The roots checked were both `flake.nix` Darwin hosts, flake apps and checks,
`overlays/default.nix`'s exported package merges, host and common Home Manager
imports, and manually invoked installed commands. Path references include
`callPackage`, `builtins.readFile`/`readDir`, plugin sources, and the Nix
package/fixture asset trees. `deadnix` detects unused expressions, not orphaned
files; the baseline `deadnix` and `statix` pre-commit hooks passed.

`overlays/agentmemory.nix` supplied an `agentmemory` attribute, but
`agentmemoryFlake` was merged last in `overlays/default.nix` and replaced it.
The superseded wrapper, fetch and lock bindings were removed from that file;
`pkgs.agentmemory` still comes from the flake with its retained patches and
`agentmemory-deps`. `pkgs.iii-engine` remains exported. The effective package
and both Darwin iii-engine releases are covered by
`tests/agentmemory-opencode/package-contract.test.js`.

| Removed file | Former consumer | Test disposition / reachability evidence |
|---|---|---|
| `home-manager/common/cavemem.nix` | Both host Home Manager defaults imported the module. | `backend-selection.test.js` removed; host/matrix and module-render tests now cover AgentMemory-only host imports. |
| `home-manager/common/opencode-plugins/cavemem.js` | The retired module installed the capture plugin. | Backend-selection removed; matrix and host-render tests assert the AgentMemory capture plugin. |
| `home-manager/common/agents-cavemem.md` | `opencode.nix` read it in the retired selector branch. | `instructions-contract.test.js` now checks only the live AgentMemory/global fragments. |
| `scripts/cavemem-smoke-test.nix` | The retired module put this command in `home.packages`. | Backend-selection's smoke-package assertions removed; host/package tests cover retained binaries. |
| `overlays/cavemem-14-hook-payload-shape.patch` | `mcp-servers.nix` applied it only to `pkgs.cavemem`. | The Cavemem smoke command and backend-selection test were removed. |
| `overlays/cavemem-25-search-alpha-doc.patch` | Same Cavemem package patch list. | Same smoke command and test disposition. |
| `overlays/cavemem-39-session-start-cwd-filter.patch` | Same Cavemem package patch list. | Same smoke command and test disposition. |
| `overlays/cavemem-data-dir-env.patch` | Same Cavemem package patch list; the module set its data directory. | Same smoke command and test disposition. |
| `scripts/agentmemory-import-cavemem.nix` | `agentmemory.nix` installed this one-shot command; `flake.nix` bound two fixture variants. | `import-cavemem.test.js` removed; module/host tests retain the Obsidian importer check. |
| `scripts/agentmemory-import-cavemem.ts` | Entrypoint of that one-shot command. | `import-cavemem.test.js` and its fixture removed. |
| `overlays/cavemem-importer-deps/package.json` | `mcp-servers.nix` used it for the Cavemem importer **and** the live Obsidian importer. | Replaced by `obsidian-importer-deps/package.json`; Obsidian tests check the js-yaml-only manifest and run real imports. |
| `overlays/cavemem-importer-deps/package-lock.json` | `importNpmLock` supplied better-sqlite3 and js-yaml for those importers. | Replaced by the js-yaml/argparse-only Obsidian lock; its package builds and import tests pass. |
| `tests/agentmemory-opencode/import-cavemem.test.js` | `tests/agentmemory-opencode/index.js` ran the retired one-shot importer suite. | Removed from the runner; `import-obsidian.test.js` remains and covers the installed command. |
| `tests/agentmemory-opencode/fixtures/cavemem-import-fixture.js` | Used only by `import-cavemem.test.js`. | Removed with its sole test consumer. |
| `tests/agentmemory-opencode/backend-selection.test.js` | `index.js` exercised the retired backend selector and rollback mode. | Removed from the runner; matrix, host-render and preflight tests cover the sole AgentMemory path. |
| `tests/session-compaction/cavemem-context-source.test.ts` | Tested the removed `fetchCavememContext` subprocess. | Removed; automatic/manual and threshold tests still cover native compaction. |
| `tests/session-compaction/integration/augmentation-disabled.test.ts` | `index.js` ran the removed augmentation hook's disabled branch. | Replaced in the feature runner by native automatic and manual integration flows. |
| `tests/opencode-nono-audit/fixtures/cavemem-data.db` | Optional `--cavemem-db` source tests and `make-fixtures.js` generation. | Fixture generation and optional-source assertions removed; audit-sources, capabilities, CLI, and end-to-end tests retain session-only coverage. |

The nono audit still has its flake app, Home Manager package, OpenCode SQLite
reader, partial-on-drift behavior, redaction, reports, and tests. The Obsidian
importer still has its installed wrapper, Node 22/js-yaml dependency tree, and
integration tests. AgentMemory's daemon, capture plugin, stock MCP registration,
Pi extension, and status command remain in both hosts. Session compaction
still has its threshold and `/compact` native-summarizer paths.

The Shopify remote-builder module, helper commands, specification and
`tests/shopify-remote-builder/` have standalone consumers and remain intact.
SQLite backup and the pre-existing local backup edits were outside this
cleanup. Historical `.kiro/specs/` and the source-fidelity decision fixture
remain as records of the earlier implementations.

## Verification

- Both Darwin `config.system.build.toplevel.drvPath` values evaluated before
  and after the nixpkgs lock refresh.
- At the original nixpkgs pin, built the `agentmemory-opencode-matrix`,
  `opencode-nono-audit-tests`, `opencode-nono-tests`, and `formatting`
  aarch64-darwin checks; the new `obsidian-importer-deps` and retained
  `iii-engine` packages also built.
- With Nix-provided Node 22, the standalone session-compaction suite (50
  tests), Pi compatibility (4 tests), and Obsidian importer (40 tests) passed.
  The cost-diagnosis suite also passed on Node 22 after its native dependency
  and runners were aligned to that runtime.
- The pre-commit gate originally failed only because `flake-checker` rejected
  the existing 33-day-old nixpkgs lock (30-day limit). Refreshing that input
  made the pre-commit and formatting checks pass; the nono-audit check also
  passed against the refreshed pin.
- Before the lock refresh, both `nix flake check --no-build --show-trace`
  and the full `nix flake check --show-trace` stopped evaluating the
  out-of-scope SQLite-backup check:
  the pre-existing Shopify edit sets `databases = []`, while
  `tests/sqlite-backup/default.nix` takes the head of the `opencode` entry.
