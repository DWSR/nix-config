{ lib }:

let
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

  memoryReadBudget = readOnlyBudget // {
    mcpproxy_call_tool_read = "allow";
    mcpproxy_retrieve_tools = "allow";
  };

  memoryWriteBudget = memoryReadBudget // {
    mcpproxy_call_tool_write = "allow";
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
          nix = "allow";
          nixos-rebuild = "ask";
        };
      };
      instructionProfile = "nix-package";
      capabilityRationale = [ "nix evaluation and dry-run commands" ];
      smokeClass = "nix-package-evaluation";
    })
    (mkAgent {
      name = "nvim-tailor";
      source = "common-markdown";
      permissionBudget = researchBudget;
      instructionProfile = "nvim-config";
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
      capabilityRationale = [ "repository history inspection" ];
      smokeClass = "security-fixture-audit";
    })
    (mkAgent {
      name = "vault-curator";
      source = "common-markdown";
      permissionBudget = memoryWriteBudget;
      instructionProfile = "vault-curation";
      capabilityRationale = [ "curated Obsidian memory writes" ];
      smokeClass = "vault-dedup-plan";
    })
    (mkAgent {
      name = "vault-synthesizer";
      source = "common-markdown";
      permissionBudget = memoryWriteBudget // {
        mcpproxy_call_tool_destructive = "ask";
      };
      instructionProfile = "vault-synthesis";
      capabilityRationale = [ "cavemem reads and synthesized Obsidian memory writes" ];
      smokeClass = "cavemem-to-memory-draft";
    })
  ];

  hostAgents = [
    (mkAgent {
      name = "stack-captain";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = researchBudget // {
        bash = {
          git = "allow";
          gh = "allow";
        };
        mcpproxy_retrieve_tools = "allow";
        mcpproxy_call_tool_write = "ask";
      };
      instructionProfile = "shopify-stack";
      capabilityRationale = [ "Graphite and GitHub stack operations" ];
      smokeClass = "shopify-stack-plan";
    })
    (mkAgent {
      name = "yb-sleuth";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = researchBudget // {
        bash = {
          git = "allow";
        };
      };
      instructionProfile = "shopify-yugabyte-readonly";
      capabilityRationale = [ "repository history inspection" ];
      smokeClass = "shopify-source-trace";
    })
  ];

  agents = listToAttrsByName (commonAgents ++ hostAgents);
in
{
  metadata = {
    version = 1;
    host = "all";
    enforcementEnabled = false;
    inherit agents;
  };

  inherit agents commonAgents hostAgents;
}
