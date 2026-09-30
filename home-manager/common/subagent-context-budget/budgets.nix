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

  mcpReadOnlyBudget = readOnlyBudget // {
    mcpproxy_code_execution = "deny";
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

  hostAgents = [
    (mkAgent {
      name = "stack-captain";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = researchBudget // {
        # Nix serializes permission keys lexicographically. OpenCode's
        # last-match-wins Bash rules therefore apply these explicit CLI denies
        # after the broad allow.
        bash = {
          "*" = "allow";
          "gh stack" = "deny";
          "gh stack *" = "deny";
          "git" = "deny";
          "git *" = "deny";
        };
        task = "allow";
        mcpproxy_retrieve_tools = "allow";
        mcpproxy_call_tool_read = "allow";
        mcpproxy_call_tool_write = "allow";
        mcpproxy_call_tool_destructive = "ask";
        mcpproxy_code_execution = "deny";
      };
      instructionProfile = "shopify-stack";
      capabilityRationale = [
        "GitHub-native Stack, Buildkite, local repair, and subagent orchestration"
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
      capabilityRationale = [ "GitHub and Git MCP read access for native Stack preflight checks" ];
      smokeClass = "shopify-stack-preflight";
    })
    (mkAgent {
      name = "stack-fix-reviewer";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = readOnlyBudget // {
        lsp = "allow";
        mcpproxy_retrieve_tools = "allow";
        mcpproxy_call_tool_read = "allow";
        mcpproxy_code_execution = "deny";
      };
      instructionProfile = "shopify-stack-fix-review";
      capabilityRationale = [ "read-only code, LSP, and startup memory checks for mutation wave review" ];
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
      name = "binks-reviewer";
      source = "host-markdown";
      hostScope = "shopify";
      state = enforced "host-override";
      permissionBudget = {
        read = "allow";
        glob = "allow";
        grep = "allow";
        list = "allow";
        external_directory = "allow";
        skill = "allow";
        bash = {
          "*" = "deny";
          binks-review = "allow";
          "binks-review *" = "allow";
          "mktemp -d *" = "allow";
        };
        mcpproxy_retrieve_tools = "allow";
        mcpproxy_call_tool_read = "allow";
      };
      instructionProfile = "shopify-binks-local-review";
      capabilityRationale = [
        "local Binks execution, git-mcp reads, temporary artifact reads, and structured finding triage"
      ];
      smokeClass = "shopify-binks-review";
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
