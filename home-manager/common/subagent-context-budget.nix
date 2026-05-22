{
  lib,
  config,
  ...
}:
let
  cfg = config.programs.subagent-context-budget;

  agentBudgetType = lib.types.submodule {
    options = {
      disableBudget = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Leave this agent unchanged even when budget enforcement is enabled.
        '';
      };

      instructionProfile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Instruction profile name to apply when this agent is budgeted.
        '';
      };

      permissionBudget = lib.mkOption {
        type = lib.types.attrs;
        default = { };
        description = ''
          OpenCode agent permission budget rendered for this agent when enforcement is enabled.
        '';
      };
    };
  };

  emptyBudgetMetadata = {
    version = 1;
    enforcementEnabled = false;
    agents = { };
  };
in
{
  options.programs.subagent-context-budget = {
    enable = lib.mkEnableOption ''
      subagent context budget metadata and enforcement wiring.

      Requires programs.opencode.enable = true on the same host; the
      assertion below enforces this at Home Manager evaluation time.
    '';

    enforce = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Apply rendered subagent budget changes. Disabled by default so the
        module can publish metadata without changing OpenCode behavior.
      '';
    };

    baselineAgent = lib.mkOption {
      type = lib.types.str;
      default = "minimal-readonly";
      description = ''
        Agent baseline name used by later audit and validation commands.
      '';
    };

    agents = lib.mkOption {
      type = lib.types.attrsOf agentBudgetType;
      default = { };
      description = ''
        Per-agent budget controls. Empty until the budget catalog is added.
      '';
    };

    metadataPath = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "opencode/subagent-context-budget/metadata.json";
      description = ''
        XDG config path containing rendered subagent budget metadata.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.subagent-context-budget.enable requires programs.opencode.enable.

          Subagent context budgets are rendered into the Home Manager managed
          OpenCode configuration. Without programs.opencode.enable = true,
          there is no OpenCode configuration for the budget metadata to
          accompany.
        '';
      }
      {
        assertion = !cfg.enforce;
        message = ''
          programs.subagent-context-budget.enforce is not implemented yet.

          Task 1.1 only enables metadata rendering. Leave enforce = false
          until the budget catalog, renderer, and runtime plugin tasks are
          implemented.
        '';
      }
    ];

    xdg.configFile.${cfg.metadataPath}.text = builtins.toJSON emptyBudgetMetadata;
  };
}
