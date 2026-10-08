{ lib }:

let
  minimalBaseline = builtins.fromJSON (builtins.readFile ./minimal-readonly-baseline.json);

  enforced = reason: {
    kind = "enforced";
    inherit reason;
  };

  readOnlyBudget = {
    read = "allow";
    glob = "allow";
    grep = "allow";
    list = "allow";
    todowrite = "allow";
    question = "allow";
    skill = "allow";
  };

  researchBudget = readOnlyBudget // {
    webfetch = "allow";
    lsp = "allow";
  };

  mkAgent =
    {
      name,
      source,
      hostScope ? "all",
      state ? enforced "default",
      permissionBudget,
      instructionProfile,
      capabilityRationale ? [ ],
      smokeClass,
    }:
    {
      inherit
        name
        source
        hostScope
        state
        permissionBudget
        instructionProfile
        capabilityRationale
        smokeClass
        ;
    };

  listToAttrsByName =
    agents: lib.listToAttrs (map (agent: lib.nameValuePair agent.name agent) agents);

  commonAgents = [
    (mkAgent {
      name = "general";
      source = "builtin";
      permissionBudget = researchBudget;
      instructionProfile = "general-research";
      capabilityRationale = [ "web research using upstream documentation" ];
      smokeClass = "general-research";
    })
    (mkAgent {
      name = "explore";
      source = "builtin";
      permissionBudget = readOnlyBudget // {
        lsp = "allow";
      };
      instructionProfile = "readonly-codebase";
      smokeClass = "readonly-codebase-question";
    })
    (mkAgent {
      name = "nix-pkg";
      source = "common-markdown";
      permissionBudget = researchBudget // {
        bash = {
          "nix *" = "allow";
          nixos-rebuild = "ask";
        };
      };
      instructionProfile = "nix-package";
      capabilityRationale = [
        "nix evaluation, dry-run commands, and upstream package documentation lookups"
      ];
      smokeClass = "nix-package-evaluation";
    })
    (mkAgent {
      name = "kiro-spec-orchestrator";
      source = "common-markdown";
      permissionBudget = researchBudget // {
        edit = "allow";
        task = "allow";
        bash = {
          cc-sdd-init = "allow";
          git = "allow";
        };
      };
      instructionProfile = "kiro-spec-orchestration";
      capabilityRationale = [
        "Kiro skill orchestration, spec document edits, bounded research, and optional template bootstrap"
      ];
      smokeClass = "kiro-spec-orchestration";
    })
    (mkAgent {
      name = "nvim-tailor";
      source = "common-markdown";
      permissionBudget = researchBudget;
      instructionProfile = "nvim-config";
      capabilityRationale = [ "Neovim plugin and upstream documentation lookups" ];
      smokeClass = "nvim-config-inspection";
    })
    (mkAgent {
      name = "security-auditor";
      source = "common-markdown";
      permissionBudget = researchBudget // {
        bash = {
          git = "allow";
        };
      };
      instructionProfile = "security-readonly";
      capabilityRationale = [ "repository history inspection and upstream advisory lookups" ];
      smokeClass = "security-fixture-audit";
    })
  ];

  hostAgents = [ ];

  agents = listToAttrsByName (commonAgents ++ hostAgents);
in
{
  metadata = {
    version = 1;
    host = "all";
    enforcementEnabled = false;
    inherit minimalBaseline;
    inherit agents;
  };

  inherit
    minimalBaseline
    agents
    commonAgents
    hostAgents
    ;
}
