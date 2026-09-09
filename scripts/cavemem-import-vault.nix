/*
  scripts/cavemem-import-vault.nix — wrapper for the one-shot
  Obsidian → cavemem.db migration script (Task 7.2 of the
  cavemem-integration spec; Requirements 8.1–8.8).

  Why a writeShellApplication wrapping a Node script (and not a single
  inlined shell heredoc):

  - The importer is non-trivial Node logic (~400 LOC: better-sqlite3
    transactions, YAML frontmatter parsing, sha256-based idempotency,
    deterministic session id synthesis). Shipping it as a real `.js`
    file under `scripts/` lets it be linted (eslint-style review),
    diffed, and unit-tested in isolation. Inlining it into a Nix
    string would obscure all of that.
  - `writeShellApplication` brings shellcheck against the shell entry
    point (the env-var setup + node exec line) for free, while leaving
    the JS body free of Nix-string escaping concerns.

  Why per-host parameterisation (`vaultPath`, `dataDir`) and not env
  vars at runtime:

  - The Shopify and personal hosts have different
    `home.mcp.obsidianVaultPath` values (one points at Google Drive,
    the other at iCloud). Baking the values in at HM evaluation time
    means the operator just runs `cavemem-import-vault` with no flags
    and the right paths flow through without per-shell-session
    bookkeeping. The HM module in `home-manager/common/cavemem.nix`
    calls this derivation via `pkgs.callPackage` with the resolved
    `config.home.mcp.obsidianVaultPath` and `cfg.dataDir`.
  - The Node script reads CAVEMEM_VAULT_PATH / CAVEMEM_DATA_DIR from
    the environment, set by this wrapper, so the shape stays simple
    enough to debug by hand: `CAVEMEM_VAULT_PATH=... CAVEMEM_DATA_DIR=...
    node scripts/cavemem-import-vault.js` works from a checkout.

  NODE_PATH wiring:

  - `cavemem-importer-deps` (built in `overlays/mcp-servers.nix`,
    Task 7.1) ships a flat `node_modules/` tree at
    `${out}/lib/node_modules/`. Setting NODE_PATH to that directory
    is the documented escape hatch for a node script that does not
    live inside a node project. We deliberately do NOT reuse the
    cavemem package's bundled better-sqlite3 because it sits under
    the cavemem private node_modules and is not addressable from
    outside that tree.
*/
{
  lib,
  writeShellApplication,
  nodejs_22,
  cavemem-importer-deps,
  vaultPath,
  dataDir,
}:
writeShellApplication {
  name = "cavemem-import-vault";
  runtimeInputs = [ nodejs_22 ];
  text = ''
    # Baked at HM build time from `config.home.mcp.obsidianVaultPath`
    # (Shopify: Google Drive path; personal: iCloud path) and
    # `home.cavemem.dataDir`. lib.escapeShellArg defends against
    # spaces and other shell metacharacters in either path — the
    # Shopify Google Drive path is "My Drive/data-bank" with a
    # literal space.
    export CAVEMEM_VAULT_PATH=${lib.escapeShellArg (toString vaultPath)}
    export CAVEMEM_DATA_DIR=${lib.escapeShellArg (toString dataDir)}

    # Resolve `require('better-sqlite3')` and `require('js-yaml')`
    # against the vendored deps tree from Task 7.1. The deps
    # derivation produces a flat $out/lib/node_modules/ layout
    # specifically for this kind of NODE_PATH-based consumption.
    export NODE_PATH=${cavemem-importer-deps}/lib/node_modules

    exec ${nodejs_22}/bin/node ${./cavemem-import-vault.js} "$@"
  '';
}
