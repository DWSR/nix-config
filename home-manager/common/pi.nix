{
  config,
  inputs,
  pkgs,
  ...
}:
let
  piAgentMemory = "${pkgs.agentmemory}/lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts";
  piMcpproxyGo = pkgs.callPackage ../../scripts/pi-mcpproxy-go.nix {
    src = ./extensions/pi-mcpproxy-go;
  };
in
{
  imports = [ inputs.pi.homeModules.default ];

  programs.pi.coding-agent = {
    enable = true;

    environment = {
      PI_OFFLINE.value = "true";
      PI_SKIP_VERSION_CHECK.value = "true";
      PI_CODING_AGENT_DIR.value = "${config.xdg.configHome}/pi/agent";
      PI_CODING_AGENT_SESSION_DIR.value = "${config.xdg.stateHome}/pi/sessions";
      PI_CACHE_RETENTION.value = "long";
    };

    extensions = [
      piAgentMemory
      "${piMcpproxyGo}/index.ts"
    ];
  };
}
