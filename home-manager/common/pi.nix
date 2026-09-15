{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  piAgentMemorySecretFile = "${config.programs.agentmemory.runtimeDir}/pi-bearer";
  piAgentMemory = "${pkgs.agentmemory}/lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts";
  piMcpproxyGo = pkgs.callPackage ../../scripts/pi-mcpproxy-go.nix {
    src = ./extensions/pi-mcpproxy-go;
  };
in
{
  imports = [ inputs.pi.homeModules.default ];

  home.activation.piAgentMemorySecret = lib.mkIf config.programs.agentmemory.enable (
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      secret_file=${lib.escapeShellArg piAgentMemorySecretFile}
      secret_dir=${lib.escapeShellArg config.programs.agentmemory.runtimeDir}
      mkdir -p "$secret_dir"
      secret=$(${pkgs.coreutils}/bin/timeout --kill-after=2s 5s /usr/bin/security find-generic-password \
        -s mcpproxy \
        -a ${lib.escapeShellArg config.programs.agentmemory.bearerReference} \
        -w 2>/dev/null) || secret=""
      if [ -n "$secret" ]; then
        umask 077
        printf '%s\n' "$secret" > "$secret_file"
        chmod 600 "$secret_file"
      else
        rm -f "$secret_file"
      fi
      unset secret
    ''
  );

  programs.pi.coding-agent = {
    enable = true;

    environment = {
      PI_OFFLINE.value = "true";
      PI_SKIP_VERSION_CHECK.value = "true";
      PI_CODING_AGENT_DIR.value = "${config.xdg.configHome}/pi/agent";
      PI_CODING_AGENT_SESSION_DIR.value = "${config.xdg.stateHome}/pi/sessions";
      PI_CACHE_RETENTION.value = "long";
      AGENTMEMORY_URL.value = "http://127.0.0.1:${toString config.programs.agentmemory.restPort}";
      AGENTMEMORY_SECRET.file = piAgentMemorySecretFile;
    };

    extensions = [
      piAgentMemory
      "${piMcpproxyGo}/index.ts"
    ];
  };
}
