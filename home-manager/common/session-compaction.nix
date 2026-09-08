/*
  home-manager/common/session-compaction.nix — HM install pipeline
  for the opencode session-compaction plugin (Task 1.3 of the
  `session-compaction` spec; Requirements 1.3, 1.5, 1.6, 2.2, 2.4,
  2.6, 2.8, 3.6, 4.1, 5.1, 5.4, 7.1, 7.6).

  Mirrors `home-manager/common/opencode-cost-diagnosis.nix` exactly:
  options block at top, `config = lib.mkIf cfg.enable { … }` below,
  peer-module assertion in the same shape.

  Responsibilities (per design §Components and Interfaces /
  SessionCompactionModule):

    1. Symlink the plugin source file into opencode's plugin
       directory via `xdg.configFile."opencode/plugins/…".source`.
       opencode loads `~/.config/opencode/plugins/*.ts` at startup;
       no `bun install` is required because the plugin uses only
       `@opencode-ai/plugin` types (provided by opencode itself) and
       built-in runtime APIs.

    2. Declare a single `compact` slash command on
       `programs.opencode.commands` via HM attrset merge — does not
       conflict with the Shopify host's existing commands.

    3. Export runtime configuration to the plugin process through
       env vars composed into the opencode wrapper's --run block via
       `home.opencode.wrapperCommands`. The subagentAllowlist option
       preserves a deliberate trichotomy across the Nix → env-var →
       TS boundary:
         - null  → omit the env var entirely (plugin: "match any").
         - []    → export "__MATCH_NONE__" sentinel (plugin: "match none").
         - [...] → export "a,b,c" comma-list (plugin: "match listed").
       Conflating null with [] was the silent-misconfiguration mode
       this scheme exists to avoid (design review Critical Issue 1).

  Peer dependency: asserts `programs.opencode.enable` at HM
  evaluation time. Without it, the plugin file is dangling and the
  slash command points at nothing; the assertion fails the build
  instead. Mirrors the same assertion shape used by
  `home-manager/common/opencode-cost-diagnosis.nix` and
  `home-manager/common/memory-sync.nix`.

  Supported opencode version range: the plugin probes for
  `client.session.summarize` and `client.session.get` at startup
  (PluginSelfCheck, design §SessionCompactionPlugin). On a
  type-shape mismatch the plugin self-disables for the session and
  logs the missing API to `app.log`. The HM module ships no version
  pin of its own — opencode is selected by the opencode HM module
  at `home-manager/common/opencode.nix`.
*/
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.programs.session-compaction;

  # Task 3.7: the entry plugin file imports the impl module via a
  # relative path. `xdg.configFile.<path>.source = <file>` wraps
  # each file in its own per-file derivation (e.g.
  # `/nix/store/HASH-hm_sessioncompaction.ts`), and Bun resolves
  # relative imports against the symlink's REAL path, so a
  # `../session-compaction-internal/…` import from a per-file
  # derivation resolves to `/nix/store/session-compaction-internal/…`
  # — which does not exist.
  #
  # Workaround: bundle both files into a single directory
  # derivation so the symlinks point INTO the same parent on disk.
  # The entry's `../session-compaction-internal/…` then resolves
  # correctly inside the derivation tree.
  sessionCompactionTree = pkgs.runCommandLocal "session-compaction-plugin-tree" { } ''
    mkdir -p $out/plugins
    mkdir -p $out/session-compaction-internal
    install -m 0644 ${./opencode-plugins/session-compaction.ts} \
      $out/plugins/session-compaction.ts
    install -m 0644 ${./session-compaction-internal/session-compaction-impl.ts} \
      $out/session-compaction-internal/session-compaction-impl.ts
  '';
in
{
  options.programs.session-compaction = {
    enable = lib.mkEnableOption "opencode session compaction plugin";

    thresholdTokens = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = 500000;
      description = "Cumulative input tokens per session above which compaction triggers. Null or zero disables.";
    };

    thresholdWallTimeHours = lib.mkOption {
      type = lib.types.nullOr lib.types.numbers.positive;
      default = 24;
      description = "Wall-clock hours since session start (or last compaction) above which compaction triggers. Null or zero disables.";
    };

    cooldownMinutes = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 30;
      description = "Minimum minutes between successive automatic compactions on the same session.";
    };

    augmentationEnabled = lib.mkOption {
      type = lib.types.bool;
      default = config.home.opencode.memoryBackend == "cavemem";
      description = "Whether to augment opencode's continuation prompt with cavemem context. Defaults off for AgentMemory and on for cavemem rollback; explicit values override the backend default. When false, compaction still fires on threshold but no cavemem query is made (R3.6).";
    };

    watchSubagents = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Apply threshold logic to subagent sessions in addition to main-thread (R5.1, R5.2).";
    };

    subagentAllowlist = lib.mkOption {
      type = lib.types.nullOr (lib.types.listOf lib.types.str);
      default = null;
      description = ''
        When watchSubagents = true, limit threshold logic to subagent
        sessions whose agent name matches an entry. Three distinct
        states are honored (R5.4, R5.5):
          - null    → "match any" (option not supplied; default).
          - []      → "match none" (operator explicitly suppressed all subagents).
          - [...]   → "match listed agents only".
        The install step encodes these three states into the env var
        surface using sentinel values; the plugin's parser MUST honor
        the same trichotomy. Conflating null with [] (silent
        misconfiguration) is the documented failure mode this option
        shape exists to avoid.
      '';
    };

    cavememContextTimeoutMillis = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2000;
      description = "Maximum time the cavemem context query is allowed to take during pre-compaction augmentation. On timeout, augmentation is skipped (R3.3).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Both files reference the SAME directory derivation
    # (`sessionCompactionTree`), so the symlinks point into one
    # on-disk parent. Bun follows the symlink for the entry,
    # lands at `<tree>/plugins/session-compaction.ts`, and the
    # entry's `../session-compaction-internal/session-compaction-impl.ts`
    # import resolves to `<tree>/session-compaction-internal/…`
    # — which exists. See `sessionCompactionTree` declaration
    # above for the full rationale.
    #
    # The impl is deployed OUTSIDE the `opencode/plugins/` scan
    # path (`opencode/session-compaction-internal/…`) so
    # opencode's user-plugin loader never iterates its exports —
    # see .kiro/specs/session-compaction/design.md §Components /
    # SessionCompactionPlugin / Plugin File Export Constraint.
    xdg.configFile."opencode/plugins/session-compaction.ts".source =
      "${sessionCompactionTree}/plugins/session-compaction.ts";
    xdg.configFile."opencode/session-compaction-internal/session-compaction-impl.ts".source =
      "${sessionCompactionTree}/session-compaction-internal/session-compaction-impl.ts";

    programs.opencode.commands.compact = ./commands/compact.md;

    # Threshold values exported as env vars for the plugin to read,
    # via the home.opencode.wrapperCommands surface, to avoid hard-coding
    # config-file lookup paths in the plugin source.
    #
    # subagentAllowlist sentinel scheme (preserves the null vs [] vs
    # [...] trichotomy across the Nix → env-var → TS boundary):
    #   - cfg.subagentAllowlist == null → unset the env var entirely
    #     (plugin treats absence as "match any").
    #   - cfg.subagentAllowlist == []   → export "__MATCH_NONE__"
    #     (plugin treats this sentinel as "match no subagent").
    #   - cfg.subagentAllowlist == [a,b]→ export "a,b" (plugin parses
    #     comma-list and matches only those agent names).
    # Plugin parser MUST distinguish all three. Conflating null with []
    # was the failure mode (silent misconfig) that motivated this scheme.
    home.opencode.wrapperCommands = [
      (
        ''
          export SESSION_COMPACTION_THRESHOLD_TOKENS="${toString (cfg.thresholdTokens or 0)}"
          export SESSION_COMPACTION_THRESHOLD_WALL_HOURS="${toString (cfg.thresholdWallTimeHours or 0)}"
          export SESSION_COMPACTION_COOLDOWN_MINUTES="${toString cfg.cooldownMinutes}"
          export SESSION_COMPACTION_AUGMENTATION_ENABLED="${if cfg.augmentationEnabled then "1" else "0"}"
          export SESSION_COMPACTION_WATCH_SUBAGENTS="${if cfg.watchSubagents then "1" else "0"}"
          export SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS="${toString cfg.cavememContextTimeoutMillis}"
        ''
        + (
          if cfg.subagentAllowlist == null then
            ""
          else if cfg.subagentAllowlist == [ ] then
            ''
              export SESSION_COMPACTION_SUBAGENT_ALLOWLIST="__MATCH_NONE__"
            ''
          else
            ''
              export SESSION_COMPACTION_SUBAGENT_ALLOWLIST="${lib.concatStringsSep "," cfg.subagentAllowlist}"
            ''
        )
      )
    ];

    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.session-compaction.enable requires programs.opencode.enable.
          The plugin loads into the opencode TUI process via xdg.configFile.
          Without programs.opencode.enable = true, opencode itself is not
          installed and the plugin file is dangling.

          To fix: set programs.opencode.enable = true; alongside
          programs.session-compaction.enable = true; in the same home-manager
          configuration.
        '';
      }
    ];
  };
}
