{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-rtk;

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
