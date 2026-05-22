{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.subagent-context-budget;
  subagent-context-budget = pkgs.callPackage ../../scripts/subagent-context-budget.nix { };
  subagent-context-budget-smoke-test =
    pkgs.callPackage ../../scripts/subagent-context-budget-smoke-test.nix
      {
        subagentContextBudget = subagent-context-budget;
      };
  budgetCatalog = import ./subagent-context-budget/budgets.nix { inherit lib; };
  unbudgeted = {
    kind = "unbudgeted";
    reason = "operator-escape-hatch";
  };

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

  isEnforced = agent: agent.state.kind == "enforced";
  isBuiltinAgent = agent: agent.source == "builtin";
  isRenderedMarkdownAgent = agent: builtins.hasAttr agent.name config.programs.opencode.agents;
  hostHasScopedAgent =
    scope:
    lib.any (agent: agent.hostScope == scope && isRenderedMarkdownAgent agent) budgetCatalog.hostAgents;
  inferredHostScope =
    if hostHasScopedAgent "shopify" then
      "shopify"
    else if hostHasScopedAgent "personal" then
      "personal"
    else
      "personal";
  currentHostScope = if cfg.hostScope == null then inferredHostScope else cfg.hostScope;
  agentAppliesToHost =
    agent: currentHostScope == "all" || agent.hostScope == "all" || agent.hostScope == currentHostScope;
  shouldRenderAgent =
    agent: isEnforced agent && (isBuiltinAgent agent || isRenderedMarkdownAgent agent);
  applyAgentControls =
    name: agent:
    let
      controls = cfg.agents.${name} or { };
    in
    if controls.disableBudget or false then agent // { state = unbudgeted; } else agent;
  scopedCatalogAgents = lib.filterAttrs (_: agentAppliesToHost) budgetCatalog.agents;
  effectiveAgents = lib.mapAttrs applyAgentControls scopedCatalogAgents;
  effectiveMetadata = budgetCatalog.metadata // {
    host = currentHostScope;
    enforcementEnabled = cfg.enforce;
    agents = effectiveAgents;
  };
  renderedAgentOverrides = lib.mapAttrs (_: agent: { permission = agent.permissionBudget; }) (
    lib.filterAttrs (_: shouldRenderAgent) effectiveAgents
  );
  hasInstructionProfile =
    agent: (agent.instructionProfile or null) != null && (agent.instructionProfile or "") != "";
  hasPermissionBudget = agent: (agent.permissionBudget or { }) != { };
  catalogValidationErrors = lib.flatten (
    lib.mapAttrsToList (
      name: agent:
      lib.optional (
        agent.name != name
      ) "subagent budget catalog entry '${name}' must use the same stable name as its key"
      ++ lib.optional (
        isEnforced agent && !hasInstructionProfile agent
      ) "subagent budget catalog entry '${name}' is enforced but has no instructionProfile"
      ++ lib.optional (
        isEnforced agent && !hasPermissionBudget agent
      ) "subagent budget catalog entry '${name}' is enforced but has no permissionBudget"
    ) budgetCatalog.agents
  );
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

    hostScope = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "all"
          "personal"
          "shopify"
        ]
      );
      default = null;
      description = ''
        Host scope for rendered budget metadata. When unset, the module infers
        the current host from configured host-specific OpenCode agents.
      '';
    };

    agents = lib.mkOption {
      type = lib.types.attrsOf agentBudgetType;
      default = { };
      description = ''
        Per-agent budget controls. Empty until the budget catalog is added.
      '';
    };

    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = subagent-context-budget;
      description = ''
        The built `subagent-context-budget` production CLI wrapper.
      '';
    };

    smokeTestPackage = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = subagent-context-budget-smoke-test;
      description = ''
        The built `subagent-context-budget-smoke-test` runtime verifier.
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

    minimalBaselinePath = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "opencode/subagent-context-budget/minimal-readonly-baseline.json";
      description = ''
        XDG config path containing the operator-readable minimal read-only baseline artifact.
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
          programs.subagent-context-budget.enable requires programs.opencode.enable.

          Subagent context budgets are rendered into the Home Manager managed
          OpenCode configuration. Without programs.opencode.enable = true,
          there is no OpenCode configuration for the budget metadata to
          accompany.
        '';
      }
      {
        assertion = catalogValidationErrors == [ ];
        message = lib.concatStringsSep "\n" catalogValidationErrors;
      }
    ];

    xdg.configFile.${cfg.metadataPath}.text = builtins.toJSON effectiveMetadata;

    xdg.configFile.${cfg.minimalBaselinePath}.source =
      ./subagent-context-budget/minimal-readonly-baseline.json;

    xdg.configFile."opencode/plugins/subagent-context-budget.ts".source =
      ./subagent-context-budget/plugin.ts;

    programs.opencode.settings = lib.mkIf cfg.enforce {
      agent = renderedAgentOverrides;
    };
  };
}
