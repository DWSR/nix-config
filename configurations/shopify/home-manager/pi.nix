{
  inputs,
  lib,
  pkgs,
  quickArchDiagramsSource,
  ...
}:
let
  piShopify = pkgs.callPackage ../../../scripts/pi-shopify.nix {
    pi = inputs.pi.packages.${pkgs.system}.coding-agent;
  };
  shopifyPiProxy = pkgs.callPackage ../../../scripts/shopify-pi-proxy.nix {
    src = ./extensions/shopify-pi-proxy;
  };
  shopifyAgentNames = builtins.filter (name: lib.hasSuffix ".md" name) (
    builtins.attrNames (builtins.readDir ./agents)
  );
  shopifyPiAgents =
    pkgs.runCommand "pi-shopify-agents"
      {
        nativeBuildInputs = [
          pkgs.coreutils
          pkgs.gawk
        ];
      }
      ''
        mkdir -p "$out"
        for source in ${./agents}/*.md; do
          name="$(basename "$source" .md)"
          ${pkgs.gawk}/bin/awk -v agentName="$name" '
            NR == 1 {
          print
          print "name: " agentName
          print "model: inherit"
          print "systemPromptMode: replace"
          print "inheritProjectContext: true"
          print "inheritSkills: true"
          next
            }
            /^mode:|^model:|^variant:|^temperature:/ { next }
            /^permission:/ { skip = 1; next }
            skip && /^---$/ { skip = 0; print; next }
            skip { next }
            { print }
          ' "$source" > "$out/$name.md"
        done
      '';
  ybIssuePiSkill = pkgs.writeTextDir "SKILL.md" (
    lib.replaceStrings
      [ "2. Cavemem: `search` with the issue number and symptom keywords." ]
      [
        "2. AgentMemory: use the stock memory search tool through mcpproxy with the issue number and symptom keywords."
      ]
      (builtins.readFile ./skills/validate-yb-issue/SKILL.md)
  );
  shopifyPiSkills = [
    ./skills/binks-pr-review
    ./skills/create-yb-fix-pr
    ./skills/graphite-pitfalls
    ybIssuePiSkill
    pkgs.quick-skills
    "${quickArchDiagramsSource}/skill"
  ];
in
{
  xdg.configFile = lib.listToAttrs (
    map (
      name:
      lib.nameValuePair "pi/agent/agents/${name}" {
        source = "${shopifyPiAgents}/${name}";
      }
    ) shopifyAgentNames
  );

  programs.pi.coding-agent = {
    package = piShopify;
    extensions = [ "${shopifyPiProxy}/index.ts" ];
    skills = shopifyPiSkills;
    promptTemplates = [ ./commands ];
    settings = {
      defaultProvider = "openai-1m";
      defaultModel = "gpt-5.6-sol";
      defaultThinkingLevel = "xhigh";
    };
  };
}
