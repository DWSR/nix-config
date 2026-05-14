/*
  home-manager/common/cavemem.nix — option surface for cavemem ambient
  memory capture (Task 3.1 of the cavemem-integration spec).

  This module exposes the `home.cavemem.*` option surface that downstream
  tasks consume to render `${dataDir}/settings.json` (Task 4.1), the
  vendored opencode plugin (Task 4.2), the mcphub `cavemem` server entry
  (Task 5.1), the opencode `mcpServers.cavemem` entry (Task 5.2), and
  the opencode wrapper's cavemem health check (Task 5.3). The option
  surface is the cross-task contract: per spec Req 10.1 and 10.5,
  `dataDir` and the `embedding.*` shape are read by the future
  sqlite-backup extension and the one-shot importer (Task 8.x), and a
  rename here is treated as a breaking change.

  Locked downstream contracts (Req 10.1, 10.2, 10.5):
    * `home.cavemem.dataDir` — canonical SQLite database / pidfile /
      logs location. Read by the importer, the future sqlite-backup
      extension, and cavemem itself.
    * `home.cavemem.embedding.{provider,model,endpoint,apiKey}` —
      consumed by the settings.json renderer (Task 4.1). The shape
      mirrors cavemem's `~/.cavemem/settings.json` `embedding` block.
    * `home.cavemem.compression.intensity` — consumed by the
      settings.json renderer (Task 4.1). Mirrors cavemem's
      `compression.intensity` enum verbatim.
    * mcphub server name (Task 5.1) — the literal string `cavemem`. Not
      an option; documented in the `dataDir` description so the
      future synthesizer-agent's tool allow-list can target it without
      ambiguity.

  Tasks 3.1 and 4.1 of the spec land here:

  - 3.1 declares the option surface above and contributes
    `pkgs.cavemem` to `home.packages` when enabled (Req 2.3).
  - 4.1 renders `${dataDir}/settings.json` from the option values
    (Req 2.4, 3.4, 3.5, 3.6, 3.7) via `home.file`.

  Plugin file emission, mcphub wiring, opencode wiring, and
  wrapper-command extension still land in later tasks (4.2, 5.1, 5.2,
  5.3), which append to the same `config = lib.mkIf cfg.enable { ... }`
  block.

  Spec: .kiro/specs/cavemem-integration/{requirements,design,tasks}.md
*/
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;

  cfg = config.home.cavemem;
in
{
  options.home.cavemem = {
    enable = lib.mkEnableOption "cavemem ambient memory capture for opencode sessions";

    dataDir = mkOption {
      type = types.path;
      default = "${config.xdg.dataHome}/cavemem";
      defaultText = lib.literalExpression ''"''${config.xdg.dataHome}/cavemem"'';
      description = ''
        Directory cavemem uses for its SQLite database, the rendered
        `settings.json`, the worker pidfile, downloaded embedding
        models, and logs (Req 2.2).

        This path is the canonical, read-back-able cross-spec contract
        (Req 10.1): the future sqlite-backup extension targets the
        SQLite file under this directory, the one-shot vault importer
        (Task 8.x) reads the same database, and the cavemem CLI binary
        invoked by mcphub and by the opencode wrapper resolves
        `~/.cavemem`-relative paths against this value.

        The mcphub server registered for cavemem under
        `home.mcp.extraServers` (Task 5.1) is named with the literal
        string `cavemem` — that name is also a locked downstream
        contract (Req 10.2) so the future vault-synthesizer-agent's
        tool allow-list can target `hub_cavemem__*` without ambiguity.
      '';
    };

    embedding = {
      provider = mkOption {
        type = types.enum [
          "local"
          "ollama"
          "openai"
          "none"
        ];
        default = "local";
        description = ''
          Embedding provider cavemem uses for vector search (Req 3.1).

          Consumed by the settings.json renderer (Task 4.1) to set the
          `embedding.provider` key in `${"$"}{dataDir}/settings.json`.

          - `local` (default) — cavemem's worker lazy-imports
            `@xenova/transformers` and runs ONNX inference in-process.
            The transformers runtime (~50 MB) is NOT bundled by the
            patched `pkgs.cavemem` derivation; cavemem downloads or
            otherwise sources it on first worker start. Operators
            running entirely offline should pre-stage the model under
            `${"$"}{dataDir}` or select a non-`local` provider.
          - `ollama` — calls a local Ollama HTTP endpoint; requires
            `embedding.endpoint`.
          - `openai` — calls the OpenAI embeddings API; requires
            `embedding.endpoint` and `embedding.apiKey`.
          - `none` — disables embedding entirely; cavemem falls back to
            BM25-only search.
        '';
      };

      model = mkOption {
        type = types.str;
        default = "Xenova/all-MiniLM-L6-v2";
        description = ''
          Embedding model identifier (Req 3.2). Consumed by the
          settings.json renderer (Task 4.1) to set `embedding.model`.

          The default value is the `local`-provider-appropriate ONNX
          model that cavemem ships defaults for. For `ollama` /
          `openai`, set this to a value the chosen endpoint accepts
          (e.g., `nomic-embed-text` for Ollama,
          `text-embedding-3-small` for OpenAI).
        '';
      };

      endpoint = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          Optional remote endpoint URL for the `ollama` and `openai`
          providers (Req 3.3). Consumed by the settings.json renderer
          (Task 4.1); written to `embedding.endpoint` only when the
          selected provider needs it AND the value is non-null
          (Req 3.5, Req 3.6). When null, the key is OMITTED from the
          rendered settings.json rather than emitted as `null` —
          cavemem's Zod schema declares `endpoint` as
          `z.string().optional()` under a `.strict()` parent and
          rejects an explicit null at worker startup. Ignored when
          `embedding.provider` is `local` or `none`. The renderer
          also emits a `lib.warn` at evaluation time when
          `provider == "ollama"` and this value is null, since
          ollama mode cannot do useful work without an endpoint.
        '';
      };

      apiKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          Optional API key for the `openai` provider (Req 3.3).
          Consumed by the settings.json renderer (Task 4.1); written
          to `embedding.apiKey` only when `embedding.provider` is
          `openai` AND the value is non-null (Req 3.6). When null,
          the key is OMITTED from the rendered settings.json rather
          than emitted as `null` — cavemem's Zod schema declares
          `apiKey` as `z.string().optional()` under a `.strict()`
          parent and rejects an explicit null at worker startup. The
          settings.json renderer also emits a `lib.warn` at
          evaluation time when `provider == "openai"` and this value
          is null (Req 3.6 / design.md §CavememModule →
          Implementation Notes); cavemem will start but the worker
          will fail on the first embed request when it cannot
          authenticate.

          NOTE: this option is a plain string today. Per Task 6.x it
          will be re-routed through the existing sops + 1Password +
          macOS Keychain bridge so the literal key never lands in the
          Nix store; the option name and shape are stable.
        '';
      };
    };

    compression = {
      intensity = mkOption {
        # Source of truth: cavemem v0.2.x
        # `packages/config/src/schema.ts` — `CompressionIntensity =
        # z.enum(['lite', 'full', 'ultra'])` with default `full`. The
        # spec's working notes mention `low/medium/high/ultra`; the
        # cavemem-architecture memory mentions `medium/full/ultra`;
        # neither matches what cavemem's strict Zod schema actually
        # accepts. The task description explicitly directs us to use
        # cavemem's enum and document the divergence — selecting any
        # value cavemem's schema rejects would cause the worker to
        # fail at startup with a Zod validation error.
        type = types.enum [
          "lite"
          "full"
          "ultra"
        ];
        default = "full";
        description = ''
          Caveman-grammar compression intensity applied to observation
          bodies before they are stored. Consumed by the settings.json
          renderer (Task 4.1) to set `compression.intensity`.

          Trade-off (per cavemem upstream docs):
          - `lite`  — ~30% size savings, highest fidelity.
          - `full`  — ~60% size savings (cavemem default).
          - `ultra` — ~75% size savings, most aggressive.

          The enum values are pinned to cavemem's strict Zod schema in
          `packages/config/src/schema.ts`; a cavemem version bump that
          renames or extends these values is a Revalidation Trigger
          (design.md §Revalidation Triggers).
        '';
      };
    };
  };

  # Config block for Task 3.1 (package on PATH, Req 2.3) and Task 4.1
  # (settings.json render, Req 2.4 + 3.4-3.7). Task 4.2/5.1/5.2/5.3
  # will append further attributes (plugin file, mcphub entry,
  # opencode mcpServers entry, wrapper health check) to this same
  # block. When `enable` is false the module contributes nothing
  # (Req 2.7).
  config = lib.mkIf cfg.enable (
    let
      e = cfg.embedding;

      # Task 7.2 (Req 8.1-8.8; design.md §ImporterScript): the
      # one-shot Obsidian → cavemem migration tool. The wrapper in
      # `scripts/cavemem-import-vault.nix` bakes
      # `home.mcp.obsidianVaultPath` and `cfg.dataDir` into the
      # derivation at HM evaluation time so the operator runs
      # `cavemem-import-vault` with no flags. callPackage feeds the
      # standard `pkgs.cavemem-importer-deps` (Task 7.1) plus the
      # two per-host parameters; the per-host vault path is read
      # from `home.mcp.obsidianVaultPath` (defined in
      # `home-manager/mcp/default.nix`) and differs between the
      # Shopify Google-Drive vault and the personal iCloud vault.
      cavememImportVault = pkgs.callPackage ../../scripts/cavemem-import-vault.nix {
        vaultPath = config.home.mcp.obsidianVaultPath;
        inherit (cfg) dataDir;
      };

      # Task 8.1 (Req 9.1-9.6, 10.6; design.md §SmokeTestScript): the
      # runtime verifier for the four upstream patches carried by
      # `pkgs.cavemem`. Lives in scripts/ rather than overlays/ because
      # it consumes the already-overlaid `pkgs.cavemem` (so a freshly
      # built cavemem can be exercised end-to-end), takes no per-host
      # parameters (it stages a temp `CAVEMEM_DATA_DIR` itself, never
      # touching `cfg.dataDir`), and has no other consumers — keeping
      # it as a `callPackage`d shell application here is the simpler
      # path versus adding a fifth overlay entry. Operators run
      # `cavemem-smoke-test` after a `nix flake update` to confirm a
      # cavemem version bump didn't silently regress any of the four
      # bugs (Revalidation Trigger per design.md).
      cavememSmokeTest = pkgs.callPackage ../../scripts/cavemem-smoke-test.nix { };

      # Per-provider embedding subsection. cavemem's Zod schema
      # (`packages/config/src/schema.ts`) accepts `provider`, `model`,
      # `endpoint`, `apiKey`, and `idleShutdownMs` under `embedding`;
      # the spec exposes the first four as module options (Req 3.1-3.3)
      # and lets cavemem's runtime defaults take over for the rest.
      #
      # The conditional shape is the meat of Req 3.4-3.7:
      #   local  -> provider + model
      #   ollama -> provider + model [+ endpoint if non-null]
      #   openai -> provider + model [+ endpoint if non-null] [+ apiKey if non-null]
      #   none   -> provider only
      #
      # cavemem's Zod schema declares `endpoint` and `apiKey` as
      # `z.string().optional()` under a `.strict()` parent. In Zod
      # `.optional()` accepts `string | undefined`, NOT `null` —
      # emitting `"endpoint": null` or `"apiKey": null` would cause
      # the worker to fail at startup with a Zod validation error.
      # We therefore use `lib.optionalAttrs` to OMIT the keys
      # entirely when the corresponding option is null, rather than
      # emitting them with a null value.
      #
      # Nix attrset selection (`.${e.provider}`) is lazy, so only the
      # selected branch is forced. The `lib.warn` calls therefore
      # fire only when the corresponding provider is selected AND
      # the relevant credential/endpoint is null, never spuriously
      # on disabled hosts or other providers (Req 3.5, 3.6,
      # design.md §SettingsJson).
      embedding =
        let
          base = { inherit (e) provider; };
          withModel = base // {
            inherit (e) model;
          };
        in
        {
          local = withModel;
          ollama =
            withModel
            // (
              if e.endpoint == null then
                lib.warn ''
                  home.cavemem.embedding.provider is "ollama" but
                  home.cavemem.embedding.endpoint is unset. The
                  rendered ${cfg.dataDir}/settings.json will OMIT
                  the endpoint field; cavemem will start but the
                  worker will fail on the first embed request when
                  it has no Ollama HTTP endpoint to call. Set
                  home.cavemem.embedding.endpoint to your local
                  Ollama URL (typically http://127.0.0.1:11434).
                '' { }
              else
                { inherit (e) endpoint; }
            );
          openai =
            withModel
            // (lib.optionalAttrs (e.endpoint != null) { inherit (e) endpoint; })
            // (
              if e.apiKey == null then
                lib.warn ''
                  home.cavemem.embedding.provider is "openai" but
                  home.cavemem.embedding.apiKey is unset. The
                  rendered ${cfg.dataDir}/settings.json will OMIT
                  the apiKey field; cavemem will start but the
                  worker will fail on the first embed request when
                  it cannot authenticate against the OpenAI
                  endpoint. Per Task 6.x of the cavemem-integration
                  spec, source the key via the existing SOPS +
                  1Password + macOS Keychain bridge before invoking
                  cavemem.
                '' { }
              else
                { inherit (e) apiKey; }
            );
          none = base;
        }
        .${e.provider};

      # Top-level settings.json shape. Mirrors cavemem's
      # `~/.cavemem/settings.json` schema for the keys the module
      # exposes; cavemem's Zod schema fills in defaults for everything
      # we omit (`workerPort`, `logLevel`, `privacy.*`, `search.*`,
      # `compression.expandForModel`, `embedding.idleShutdownMs`),
      # which keeps the rendered file forward-compatible across
      # cavemem patch releases (design.md §SettingsJson State
      # Management).
      settings = {
        inherit (cfg) dataDir;
        inherit embedding;
        compression = {
          inherit (cfg.compression) intensity;
        };
      };
    in
    {
      home.packages = [
        pkgs.cavemem
        # Task 7.2: per-host wrapper around the Node importer; vault
        # path and dataDir are baked in at HM build time so the
        # operator just runs `cavemem-import-vault` (no flags).
        cavememImportVault
        # Task 8.1: runtime verifier for the four upstream patches
        # (bugs #14, #25, #39, and the data-dir env override). Always
        # ships alongside cavemem so an operator can re-run it after
        # any `pkgs.cavemem` change to confirm the patches survived.
        cavememSmokeTest
      ];

      # `home.file` (not `xdg.dataFile`) because `cfg.dataDir` is a
      # fully-qualified path (default `${xdg.dataHome}/cavemem`) and
      # `home.file` accepts absolute paths. `builtins.toJSON` is
      # deterministic, so identical option values produce a
      # byte-stable file across rebuilds (Req 2.4 idempotency).
      home.file."${cfg.dataDir}/settings.json".text = builtins.toJSON settings;

      # Task 4.2 (Req 2.5, design.md §OpencodePlugin): ship the opencode
      # plugin file from the vendored source under
      # `home-manager/common/opencode-plugins/cavemem.js` instead of
      # invoking `cavemem install` (Req 2.6 forbids imperative
      # subcommand activation). `xdg.configFile."opencode/plugins/cavemem.js"`
      # writes to `${config.xdg.configHome}/opencode/plugins/cavemem.js`
      # — the path opencode reads plugins from. Using `.source` (not
      # `.text`) keeps HM's symlink semantics: the rendered file in the
      # Nix store is a single shared store path, not a re-emitted copy
      # bloating the store on every rebuild. The relative path
      # `./opencode-plugins/cavemem.js` resolves against this module
      # file's directory (`home-manager/common/`), which is where the
      # vendored plugin lives (committed in 4e868a7).
      xdg.configFile."opencode/plugins/cavemem.js".source = ./opencode-plugins/cavemem.js;

      # Task 5.1 (Req 4.1, 4.2, 4.4, 10.2; design.md §McphubExtraServers):
      # register cavemem with mcphub via the `home.mcp.extraServers`
      # extension surface (defined in `home-manager/mcp/default.nix`).
      # The renderer there merges this attrset into
      # `~/.config/mcphub/servers.json` alongside the built-in obsidian,
      # github, and nixos entries.
      #
      # Server name is the literal string `cavemem` (Req 10.2 / Req 4.2)
      # — a locked downstream contract so the future
      # vault-synthesizer-agent's tool allow-list can target the four
      # `hub_cavemem__{list_sessions,timeline,get_observations,search}`
      # tools (Req 10.6) without ambiguity. Renaming this attribute key
      # is a breaking contract change.
      #
      # Command is the wrapped binary built in task 1.2
      # (`overlays/mcp-servers.nix` `cavemem` derivation). The wrapper
      # is `makeWrapper ${nodejs}/bin/node ... --add-flags
      # ${out}/lib/node_modules/cavemem/dist/index.js`, so
      # `cavemem mcp` is equivalent to upstream's own opencode-installer
      # invocation `node <cliPath> mcp` (verified against the patched
      # `packages/installers/src/opencode.ts` and against
      # `apps/cli/src/commands/mcp.ts` in cavemem v0.2.1, both of which
      # treat `mcp` as the canonical MCP-server subcommand).
      #
      # The `env.CAVEMEM_DATA_DIR` entry below is honored by the
      # `cavemem-data-dir-env.patch` overlay landed in task 1.3
      # (commit 01373e7), which introduces a single-bottleneck
      # `resolveDataDir()` helper in `packages/config/src/loader.ts`
      # that reads `process.env.CAVEMEM_DATA_DIR` (when set and
      # non-empty after trim) before falling back to the hardcoded
      # `~/.cavemem` default. Without this env entry, cavemem v0.2.1
      # would still read settings.json and write data.db at
      # `~/.cavemem` regardless of `cfg.dataDir`, making the
      # `home.cavemem.dataDir` option (Req 10.1, locked downstream
      # contract) a no-op for the mcphub-launched server. Setting
      # the env here closes that loop so the mcphub-spawned cavemem
      # process reads the same settings.json that this module
      # renders at `${"$"}{cfg.dataDir}/settings.json` (Task 4.1)
      # and writes its SQLite database under the same directory the
      # future sqlite-backup extension and the one-shot importer
      # (Task 8.x) target.
      #
      # The `home.mcp.extraServers` option type (defined in
      # `home-manager/mcp/default.nix` as `attrsOf attrs`) accepts
      # arbitrary per-server attributes, and the renderer there
      # serializes the whole attrset via `builtins.toJSON` into
      # `~/.config/mcphub/servers.json`; the existing `github`
      # server's `env.GITHUB_PERSONAL_ACCESS_TOKEN` entry confirms
      # mcphub propagates `env` to the spawned process.
      home.mcp.extraServers.cavemem = {
        command = "${pkgs.cavemem}/bin/cavemem";
        args = [ "mcp" ];
        env = {
          CAVEMEM_DATA_DIR = cfg.dataDir;
        };
      };

      # Task 5.2 (Req 4.3, 4.5; design.md §OpencodeSettings): expose
      # cavemem to opencode as a second MCP surface, alongside the
      # mcphub registration above. Opencode reads MCP servers directly
      # from its rendered `~/.config/opencode/opencode.json` and
      # spawns them itself; mcphub is a separate hub that opencode
      # ALSO talks to via its own MCP entry. So cavemem ends up
      # reachable through two paths: (a) opencode → cavemem directly,
      # and (b) opencode → mcphub → cavemem. Both spawn the same
      # binary with the same args; both must therefore set the same
      # CAVEMEM_DATA_DIR env (see split-brain note below).
      #
      # Per Req 4.5 the cavemem module MUST NOT write opencode.json
      # directly. We contribute through `programs.opencode.settings`,
      # the freeform attrset that the nix-community
      # `programs.opencode` HM module serializes into opencode.json.
      #
      # Shape: opencode's config schema (per
      # https://opencode.ai/docs/mcp-servers/#local and the HM
      # module's transformer at modules/programs/opencode.nix:20-41)
      # uses the top-level key `mcp` (NOT `mcpServers`), with each
      # entry shaped as:
      #   { type = "local";
      #     command = [ <binary> <arg>... ];      # single array
      #     environment = { ... };                # NOT `env`
      #     enabled = true; }
      # The task brief's `mcpServers.cavemem = { command; args; env; }`
      # phrasing is the mcphub-extraServers shape (correct for
      # `home.mcp.extraServers` above, NOT for opencode); the brief
      # explicitly hedges with "or the equivalent shape opencode
      # expects" for exactly this case. Verified against
      # nix-community/home-manager rev cc09c0f
      # (modules/programs/opencode.nix:209-212) and against the
      # mcp-integration test fixture
      # (tests/modules/programs/opencode/mcp-integration.json) which
      # both render `mcp.<name>.{type,command-as-array,environment}`.
      #
      # The `environment.CAVEMEM_DATA_DIR` entry mirrors the mcphub
      # entry's `env.CAVEMEM_DATA_DIR` for the same reason it was
      # added there in the task 5.1 amendment: cavemem v0.2.1 (with
      # the cavemem-data-dir-env.patch from task 1.3, commit 01373e7)
      # honors `process.env.CAVEMEM_DATA_DIR` via a single-bottleneck
      # `resolveDataDir()` helper before falling back to the
      # hardcoded `~/.cavemem` default. Without this env entry on the
      # opencode-spawned process, opencode-spawned cavemem would
      # read settings.json and write data.db at `~/.cavemem` while
      # mcphub-spawned cavemem reads/writes under `${cfg.dataDir}` —
      # a split-brain dataDir resolution that would corrupt the
      # observation timeline (two SQLite databases, two settings.json
      # files, two embedding caches) and silently break Req 10.1's
      # locked-downstream-contract guarantee that `home.cavemem.dataDir`
      # is the canonical location for the future sqlite-backup
      # extension and the one-shot vault importer (Task 8.x).
      programs.opencode.settings.mcp.cavemem = {
        type = "local";
        command = [
          "${pkgs.cavemem}/bin/cavemem"
          "mcp"
        ];
        environment = {
          CAVEMEM_DATA_DIR = cfg.dataDir;
        };
        enabled = true;
      };

      # Task 5.3 (Req 5.1-5.5; design.md §OpencodeWrapperHealthCheck):
      # append a cavemem-specific readiness probe to the opencode
      # wrapper's pre-launch checks. Mirrors the existing obsidian
      # probe in `home-manager/common/opencode.nix` (lines 54-62) in
      # style — same `/usr/bin/curl --max-time 2` invocation, same
      # `echo ... >&2; exit 1` failure path, same
      # `launchctl kickstart gui/$(id -u)/com.ravitemer.mcp-hub`
      # recovery hint — but probes the cavemem-server-specific
      # endpoint instead of the generic `/api/health` so that
      # mcphub-up-but-cavemem-down still hard-fails the wrapper
      # (Req 5.1, 5.2). The error message names cavemem explicitly
      # (Req 5.3).
      #
      # Endpoint: `POST http://localhost:37373/api/servers/info` with
      # body `{"server_name": "cavemem"}` returns the cavemem server's
      # registration + connection state. mcp-hub does NOT expose a
      # `GET /api/servers/<name>` route — that path returns 404 — so
      # we use the documented `/info` POST endpoint and grep for
      # `"status":"connected"` in the response. (The original prototype
      # of this probe used the non-existent GET path; that 404'd in
      # production and trivially aborted the wrapper. Hotfixed to the
      # POST endpoint after task 9.2 surfaced the bug live.)
      #
      # `home.opencode.wrapperCommands` is `listOf lines`; HM list-merge
      # semantics concatenate this entry after the obsidian snippet
      # contributed by `home-manager/common/opencode.nix`. Snippets run
      # sequentially inside the wrapper's `--run` block (joined by
      # `lib.concatStringsSep "\n"`), so either snippet's `exit 1`
      # halts the wrapper before the underlying opencode binary is
      # exec'd. Both checks therefore run in order and either failure
      # is fatal (Req 5.5) without one snippet needing knowledge of
      # the other.
      #
      # Gating: the entire `config = lib.mkIf cfg.enable { ... }`
      # block is enable-gated, so disabled hosts contribute nothing
      # to `wrapperCommands` and the cavemem probe is absent from
      # the rendered wrapper (Req 5.4).
      #
      # Quoting note: this snippet is composed into the opencode wrapper
      # via `wrapProgram ... --run STR`, where STR is the joined list of
      # all wrapperCommands wrapped in shell single-quotes by makeWrapper.
      # That means a single quote anywhere inside the snippet would close
      # the outer single-quoted string and break wrapper composition.
      # Use double quotes (with backslash-escaped inner double quotes
      # where needed) throughout. The obsidian probe in
      # `home-manager/common/opencode.nix` follows the same convention.
      home.opencode.wrapperCommands = [
        ''
          cavemem_body="{\"server_name\":\"cavemem\"}"
          cavemem_info=$(/usr/bin/curl -sf --max-time 2 -X POST -H "Content-Type: application/json" -d "$cavemem_body" http://localhost:37373/api/servers/info 2>/dev/null) || cavemem_info=""
          if ! printf "%s" "$cavemem_info" | grep -q "\"status\":\"connected\""; then
            echo "ERROR: cavemem MCP server is not reachable via mcphub. Ambient memory capture is unavailable." >&2
            echo "Start it with: launchctl kickstart gui/$(id -u)/com.ravitemer.mcp-hub" >&2
            exit 1
          fi
        ''
      ];
    }
  );
}
