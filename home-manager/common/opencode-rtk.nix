{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-rtk;
  defaultState = if cfg.defaultEnabled then "enabled" else "disabled";

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
