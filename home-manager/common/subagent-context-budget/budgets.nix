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

  memoryReadBudget = readOnlyBudget // {
    mcpproxy_call_tool_read = "allow";
    mcpproxy_retrieve_tools = "allow";
  };

  memoryWriteBudget = memoryReadBudget // {
    mcpproxy_call_tool_write = "allow";
  };

  mcpReadOnlyBudget = readOnlyBudget // {
    mcpproxy_retrieve_tools = "allow";
    mcpproxy_call_tool_read = "allow";
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
          nix = "allow";
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
        bash = "allow";
        task = "allow";
        mcpproxy_retrieve_tools = "allow";
        mcpproxy_call_tool_read = "allow";
        mcpproxy_call_tool_write = "allow";
      };
      instructionProfile = "shopify-stack";
      capabilityRationale = [
        "Graphite, GitHub, Buildkite, bash fallback, and subagent orchestration for stack operations"
      ];
      smokeClass = "shopify-stack-plan";
    })
    (mkAgent {
      name = "stack-status-sweeper";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = mcpReadOnlyBudget;
      instructionProfile = "shopify-stack-status-readonly";
      capabilityRationale = [ "GitHub MCP read access for stack-wide PR status collection" ];
      smokeClass = "shopify-stack-status";
    })
    (mkAgent {
      name = "ci-log-sleuth";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = mcpReadOnlyBudget;
      instructionProfile = "shopify-ci-log-readonly";
      capabilityRationale = [ "Buildkite and GitHub MCP read access for CI log diagnosis" ];
      smokeClass = "shopify-ci-log-analysis";
    })
    (mkAgent {
      name = "bot-thread-triager";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = mcpReadOnlyBudget;
      instructionProfile = "shopify-bot-thread-readonly";
      capabilityRationale = [ "GitHub MCP read access for bot review comment triage" ];
      smokeClass = "shopify-bot-thread-triage";
    })
    (mkAgent {
      name = "stack-preflight-auditor";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = mcpReadOnlyBudget;
      instructionProfile = "shopify-stack-preflight-readonly";
      capabilityRationale = [ "gt-mcp read access for Graphite stack preflight checks" ];
      smokeClass = "shopify-stack-preflight";
    })
    (mkAgent {
      name = "stack-fix-reviewer";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = readOnlyBudget // {
        lsp = "allow";
      };
      instructionProfile = "shopify-stack-fix-review";
      capabilityRationale = [ "read-only code and LSP access for mutation wave review" ];
      smokeClass = "shopify-fix-review";
    })
    (mkAgent {
      name = "binks-overrider";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = {
        mcpproxy_retrieve_tools = "allow";
        mcpproxy_call_tool_read = "allow";
        mcpproxy_call_tool_write = "allow";
      };
      instructionProfile = "shopify-binks-override";
      capabilityRationale = [
        "GitHub MCP label and comment writes for explicitly gated Binks overrides"
      ];
      smokeClass = "shopify-binks-override";
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
      capabilityRationale = [ "repository history inspection and upstream documentation lookup" ];
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
