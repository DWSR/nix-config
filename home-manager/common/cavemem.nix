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

  This task only declares the option surface and a minimal `config`
  block that contributes `pkgs.cavemem` to `home.packages` when enabled
  (Req 2.3). Settings.json rendering, plugin file emission, mcphub
  wiring, opencode wiring, and wrapper-command extension all land in
  later tasks (4.1, 4.2, 5.1, 5.2, 5.3) which append to the same
  `config = lib.mkIf cfg.enable { ... }` block.

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
          selected provider needs it (Req 3.5, Req 3.6). Ignored when
          `embedding.provider` is `local` or `none`.
        '';
      };

      apiKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = ''
          Optional API key for the `openai` provider (Req 3.3).
          Consumed by the settings.json renderer (Task 4.1); written
          to `embedding.apiKey` only when `embedding.provider` is
          `openai` (Req 3.6). The settings.json renderer also emits a
          `lib.warn` at evaluation time when `provider == "openai"`
          and this value is null (Req 3.6 / design.md
          §CavememModule → Implementation Notes).

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

  # Minimal config block for Task 3.1: contribute the patched cavemem
  # package to the operator's PATH (Req 2.3) when the module is
  # enabled, and contribute nothing when disabled (Req 2.7). Tasks
  # 4.1, 4.2, 5.1, 5.2, and 5.3 will append to this same block to
  # render settings.json, ship the vendored opencode plugin, register
  # the mcphub `cavemem` server, register opencode's
  # `mcpServers.cavemem` entry, and append the wrapper health check.
  config = lib.mkIf cfg.enable {
    home.packages = [ pkgs.cavemem ];
  };
}
