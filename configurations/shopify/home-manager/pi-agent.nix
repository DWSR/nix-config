{
  pkgs,
  ...
}:
let
  shopifyInstructionPackage = pkgs.runCommand "pi-agent-shopify-instructions-1.0.0" { } ''
    mkdir -p "$out/share/pi-agent"
    cp ${../../../home-manager/common/pi-agent/instructions.md} "$out/share/pi-agent/instructions.md"
    cp ${../../../home-manager/common/subagent-context-budget/instructions/host-specific/shopify.md} "$out/share/pi-agent/shopify.md"
    chmod 0444 "$out/share/pi-agent/instructions.md" "$out/share/pi-agent/shopify.md"
  '';
in
{
  programs.pi-agent = {
    enable = true;

    agentMemory = {
      restPort = 3111;
      secretReference = "agentmemory-bearer";
    };

    provider = {
      mode = "shopify-gateway";
      enabledRoles = [
        "anthropic"
        "openai"
        "google"
        "groq"
        "xai"
      ];
      defaultModel = {
        provider = "openai";
        modelId = "gpt-5.6-sol";
      };
    };

    sandbox.defaultState = "audit";

    instructions = [
      {
        package = shopifyInstructionPackage;
        relativePath = "share/pi-agent/instructions.md";
      }
      {
        package = shopifyInstructionPackage;
        relativePath = "share/pi-agent/shopify.md";
      }
    ];
  };
}
