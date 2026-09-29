{
  inputs,
  lib,
  pkgs,
  piAquiferSource,
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
  aquifer = pkgs.callPackage ../../../scripts/pi-aquifer.nix {
    src = piAquiferSource;
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
  shopifyPiSkills = [
    ./skills/binks-pr-review
    ./skills/create-yb-fix-pr
    ./skills/validate-yb-issue
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

  home.file.".pi/agent/extensions/aquifer/config.json".text =
    builtins.toJSON {
      gateway = "https://aquifer.shopify.io";
      profile = "riverbed";
    }
    + "\n";

  programs.pi.coding-agent = {
    package = piShopify;
    extensions = [
      "${aquifer}/index.ts"
      "${shopifyPiProxy}/index.ts"
    ];
    skills = shopifyPiSkills;
    promptTemplates = [ ./commands ];
    settings = {
      defaultProvider = "openai-1m";
      defaultModel = "gpt-5.6-sol";
      defaultThinkingLevel = "xhigh";
    };
  };
}
