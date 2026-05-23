{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-rtk;
  defaultState = if cfg.defaultEnabled then "enabled" else "disabled";
  pluginPath = "opencode/plugins/rtk.ts";
  operatorGuidePath = "opencode/rtk/README.md";
  rtkMetadata = {
    feature = "rtk-install";
    packageName = cfg.package.pname or "rtk";
    packageVersion = cfg.package.version;
    sourceOwner = cfg.package.src.owner;
    sourceRepo = cfg.package.src.repo;
    sourceRev = cfg.package.src.tag or cfg.package.src.rev;
    inherit (cfg) defaultEnabled;
    overrideEnv = "OPENCODE_RTK";
    effectiveEnv = "OPENCODE_RTK_EFFECTIVE";
    usageTagEnv = "OPENCODE_RTK_USAGE_TAG";
    telemetryEnv = "RTK_TELEMETRY_DISABLED";
    inherit pluginPath;
  };
  operatorGuide = ''
    # OpenCode RTK operator guide

    The RTK integration is managed by Home Manager for OpenCode. It installs the
    `rtk` package from `rtk-ai/rtk`, renders local metadata, and prepares the
    repository-owned plugin path `opencode/plugins/rtk.ts` for the plugin task.

    ## Restart behavior

    After applying a host rebuild, restart OpenCode before expecting RTK state,
    metadata, telemetry posture, or plugin behavior to change in new sessions.
    Existing OpenCode processes keep the environment they started with.

    ## Host default and launch overrides

    The host default is rendered by `programs.opencode-rtk.defaultEnabled` and is
    included in the rendered section below.

    Use `OPENCODE_RTK` for one launch without rebuilding:

    - `OPENCODE_RTK=1`, `OPENCODE_RTK=true`, or `OPENCODE_RTK=enabled` requests RTK.
    - `OPENCODE_RTK=0`, `OPENCODE_RTK=false`, or `OPENCODE_RTK=disabled` disables RTK.

    The wrapper exports these values before OpenCode starts:

    - `OPENCODE_RTK_EFFECTIVE`: `enabled` or `disabled` after host default and
      `OPENCODE_RTK` resolution.
    - `OPENCODE_RTK_USAGE_TAG`: `rtk:enabled` or `rtk:disabled` for provider usage
      attribution.
    - `OPENCODE_RTK_DISABLE_REASON`: local reason text when the wrapper disables RTK.
    - `RTK_TELEMETRY_DISABLED`: always `1` for the RTK telemetry posture.

    ## Rollback

    Use the smallest rollback that matches the situation:

    - For one launch, start OpenCode with `OPENCODE_RTK=0`.
    - For a host default rollback, set `programs.opencode-rtk.defaultEnabled = false`
      and rebuild the host.
    - For full removal, disable `programs.opencode-rtk.enable` in repository-managed
      configuration and rebuild the host.

    Restart OpenCode after a rebuild so the wrapper environment and plugin scan state
    come from the new Home Manager generation.

    ## Before and after measurement

    Measure Bash-heavy OpenCode sessions with the existing local diagnostic:

    1. Run `opencode-cost-report` before enabling or using RTK.
    2. Rebuild the host and restart OpenCode.
    3. Run a comparable Bash-heavy session.
    4. Run `opencode-cost-report` again and compare Bash tool attribution only.

    Do not expect RTK to reduce native Read, Grep, Glob, WebFetch, Task, or LSP tool
    output. This feature keeps generated state, metadata, logs, and guidance local to
    the host unless external sync is configured outside the RTK integration.

    ## Rendered host defaults

    - `programs.opencode-rtk.defaultEnabled`: `${lib.boolToString cfg.defaultEnabled}`
    - Host default state for OpenCode launches: `${defaultState}`
    - Metadata path: `${cfg.metadataPath}`
    - Plugin path: `${pluginPath}`
  '';

  rtk-opencode-smoke-test = pkgs.callPackage ../../scripts/rtk-opencode-smoke-test.nix {
    rtk = cfg.package;
  };
in
{
  options.programs.opencode-rtk = {
    enable = lib.mkEnableOption ''
      RTK integration for OpenCode Bash/shell tool calls.

      Requires programs.opencode.enable = true on the same host; the
      assertion below enforces this at Home Manager evaluation time.
    '';

    defaultEnabled = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Host default RTK state for OpenCode launches. Later runtime wiring
        resolves this default with the OPENCODE_RTK per-launch override.
      '';
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.rtk;
      defaultText = lib.literalExpression "pkgs.rtk";
      description = ''
        RTK package made available to the OpenCode integration.
      '';
    };

    metadataPath = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "opencode/rtk/metadata.json";
      description = ''
        XDG config path reserved for rendered RTK integration metadata.
      '';
    };

    usageTag = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "{env:OPENCODE_RTK_USAGE_TAG}";
      description = ''
        OpenCode provider usage-tag contract consumed by host-specific
        attribution wiring. Runtime state resolution exports this value as
        either rtk:enabled or rtk:disabled.
      '';
    };

    smokeTestPackage = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = rtk-opencode-smoke-test;
      description = ''
        The built rtk-opencode-smoke-test runtime verifier package.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [
      cfg.package
      cfg.smokeTestPackage
    ];

    xdg.configFile = {
      ${cfg.metadataPath}.text = builtins.toJSON rtkMetadata;
      ${pluginPath}.source = ./opencode-plugins/rtk.ts;
      ${operatorGuidePath}.text = operatorGuide;
    };

    # Resolver contract for `.kiro/specs/rtk-install/design.md` Runtime State.
    # This snippet is embedded into the OpenCode wrapper with makeWrapper
    # `--run`, so avoid shell single quotes anywhere inside the snippet body.
    home.opencode.wrapperCommands = [
      ''
        export PATH="${lib.makeBinPath [ cfg.package ]}:$PATH"
        opencode_rtk_default="${defaultState}"
        opencode_rtk_override="''${OPENCODE_RTK:-}"
        opencode_rtk_disable_reason=""

        case "$opencode_rtk_override" in
          "")
            opencode_rtk_requested="$opencode_rtk_default"
            if [ "$opencode_rtk_requested" = "disabled" ]; then
              opencode_rtk_disable_reason="host-default"
            fi
            ;;
          "1"|"true"|"enabled")
            opencode_rtk_requested="enabled"
            ;;
          "0"|"false"|"disabled")
            opencode_rtk_requested="disabled"
            opencode_rtk_disable_reason="override"
            ;;
          *)
            export OPENCODE_RTK_EFFECTIVE="disabled"
            export OPENCODE_RTK_USAGE_TAG="rtk:disabled"
            export OPENCODE_RTK_DISABLE_REASON="invalid-override"
            export RTK_TELEMETRY_DISABLED="1"
            echo "ERROR: invalid OPENCODE_RTK value: $opencode_rtk_override. Use 1, true, enabled, 0, false, or disabled." >&2
            exit 1
            ;;
        esac

        export RTK_TELEMETRY_DISABLED="1"
        if [ "''${RTK_TELEMETRY_DISABLED:-}" != "1" ]; then
          opencode_rtk_requested="disabled"
          opencode_rtk_disable_reason="telemetry-unsafe"
          echo "ERROR: RTK telemetry could not be disabled explicitly; starting OpenCode with RTK disabled." >&2
        fi

        if [ "$opencode_rtk_requested" = "enabled" ] && ! command -v rtk >/dev/null 2>&1; then
          opencode_rtk_requested="disabled"
          opencode_rtk_disable_reason="missing-binary"
          echo "ERROR: RTK requested for OpenCode but the rtk binary is unavailable; starting with RTK disabled." >&2
        fi

        export OPENCODE_RTK_EFFECTIVE="$opencode_rtk_requested"
        export OPENCODE_RTK_USAGE_TAG="rtk:$opencode_rtk_requested"
        export OPENCODE_RTK_DISABLE_REASON="$opencode_rtk_disable_reason"
      ''
    ];

    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.opencode-rtk.enable requires programs.opencode.enable.

          The RTK OpenCode integration installs repository-managed OpenCode
          integration surface for Bash/shell tool routing. Without
          programs.opencode.enable = true, there is no Home Manager managed
          OpenCode configuration for RTK to accompany.

          To fix: set programs.opencode.enable = true; alongside
          programs.opencode-rtk.enable = true; in the same home-manager
          configuration.
        '';
      }
    ];
  };
}
