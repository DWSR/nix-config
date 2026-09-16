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
  piSubagents = pkgs.callPackage ../../scripts/pi-subagents.nix { };
  rpivTodo = pkgs.callPackage ../../scripts/rpiv-todo.nix { };
  piLensLspPackages =
    with pkgs;
    [
      typescript-language-server
      typescript
      deno
      pyright
      python3Packages.jedi-language-server
      gopls
      rust-analyzer
      ruby-lsp
      solargraph
      rubocop
      intelephense
      powershell-editor-services
      powershell
      # csharp-ls is unavailable on Darwin; OmniSharp is pi-lens's fallback.
      omnisharp-roslyn
      fsautocomplete
      dotnet-sdk
      lua-language-server
      clang-tools
      zls
      beamPackages.expert
      gleam
      tinymist
      marksman
      clojure-lsp
      cue
      terraform-ls
      bash-language-server
      fish-lsp
      cmake-language-server
      dockerfile-language-server-nodejs
      yaml-language-server
      vscode-langservers-extracted
      taplo
      prisma-language-server
      vue-language-server
      svelte-language-server
      jdt-language-server
      jdk
      kotlin-language-server
      sourcekit-lsp
      swift
      dart
      haskell-language-server
      elixir-ls
      ocamlPackages.ocaml-lsp
      nixd
    ]
    ++ lib.optionals pkgs.stdenv.isLinux [ pkgs.csharp-ls ];
  kiroSkillNames = builtins.filter (name: lib.hasPrefix "kiro-" name) (
    builtins.attrNames (builtins.readDir "${config.programs.cc-sdd.skillsPackage}/skills")
  );
  piKiroAgent =
    pkgs.runCommand "pi-kiro-agents"
      {
        nativeBuildInputs = [ pkgs.gawk ];
      }
      ''
        mkdir -p "$out"
        ${pkgs.gawk}/bin/awk '
          NR == 1 {
            print
            print "name: kiro-spec-orchestrator"
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
        ' ${./agents/kiro-spec-orchestrator.md} > "$out/kiro-spec-orchestrator.md"
      '';
  kiroSkillPaths = map (
    name: "${config.programs.cc-sdd.skillsPackage}/skills/${name}"
  ) kiroSkillNames;
in
{
  imports = [ inputs.pi.homeModules.default ];

  xdg.configFile."pi/agent/agents/kiro-spec-orchestrator.md".source =
    "${piKiroAgent}/kiro-spec-orchestrator.md";

  home.packages = piLensLspPackages;

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
      "${piSubagents}/index.ts"
      "${rpivTodo}/index.ts"
      "git:github.com/DietrichGebert/ponytail"
      "https://github.com/apmantza/pi-lens"
    ];

    skills = kiroSkillPaths;
    settings.subagents.defaultThinking = "xhigh";
    settings.subagents.defaultExtensions = config.programs.pi.coding-agent.extensions;
  };
}
