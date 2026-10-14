# OpenCode v1 web console on the fabro host: the repo's pinned
# `opencode-pinned` package served headless as a systemd DynamicUser
# service, listening on loopback and advertised on the tailnet as
# `svc:opencode` (./tailscale.nix). This is a vanilla opencode install —
# no nono wrapper and no wrapper preflights; none of the mac host's
# mcpproxy / AgentMemory / git-mcp machinery exists on the guest.
#
#   * Models come from the local LiteLLM gateway
#     (http://127.0.0.1:4000/v1, ./litellm.nix). The provider id
#     (`opencode-litellm`) deliberately starts with "opencode": opencode
#     emits its dynamic `x-opencode-session` header only for provider ids
#     with that prefix (v1.19.0 header logic), and litellm's
#     `forward_client_headers_to_llm_api` carries the header upstream for
#     the opencode-* model groups. Do NOT add static provider headers —
#     that is the entire mechanism.
#   * A dedicated GitHub PAT (sops `opencode-github-token`) is exported as
#     GITHUB_TOKEN and GH_TOKEN; git pushes authenticate through
#     `gh auth git-credential`, and commits are SSH-signed with the key
#     provisioned from the sops `opencode-signing-key` secret via a
#     systemd credential (the key never enters the Nix store or the
#     service environment).
#   * The workspace is guest-local (/var/lib/opencode/workspace): a
#     DynamicUser cannot write the Lima virtiofs state share (VZ maps it
#     to the cidata user), so repos are cloned in-VM and GitHub is the
#     sync point. It is lost if the Lima instance is recreated.
#
# The declarative-wins config tree is reinstalled from the Nix store on
# every start: `$XDG_CONFIG_HOME` is /var/lib/opencode/config and opencode
# resolves its global config at `$XDG_CONFIG_HOME/opencode/`, so the tree
# carries that subdirectory and ExecStartPre copies it to
# /var/lib/opencode/config/opencode (settings, AGENTS.md, agents/,
# skills/). The gh extension lands at `$XDG_DATA_HOME/gh/extensions/`,
# mirroring home-manager's `programs.gh.extensions` layout
# (modules/programs/gh.nix).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  opencodeHome = "/var/lib/opencode";
  opencodeStateDir = "${opencodeHome}/state";
  opencodeConfigDir = "${opencodeHome}/config";
  opencodeDataDir = "${opencodeHome}/share";
  opencodeCacheDir = "${opencodeHome}/cache";

  # The per-project cc-sdd bootstrap helper (materialises .kiro/settings
  # template trees); shipped on PATH like the mac module's `cc-sdd-init`.
  ccSddInit = import ../../scripts/cc-sdd-init.nix {
    inherit pkgs;
    inherit (pkgs) cc-sdd-skills;
  };

  # Vendored Cocoon-AI skill fetches: process-flow-diagram is the rev
  # pinned by home-manager/common/opencode.nix, architecture-diagram the
  # rev pinned by configurations/personal/home-manager/opencode.nix.
  processFlowDiagramSkill = pkgs.fetchFromGitHub {
    owner = "Cocoon-AI";
    repo = "process-flow-diagram-generator";
    rev = "6e0c72a3b4b46f87ac01ed1291f646bf77beafb0";
    hash = "sha256-uKMCItuqK7JXeGeXvG3RiUg7xWLzlO93K3XMbVEn8ZI=";
  };
  architectureDiagramSkill = pkgs.fetchFromGitHub {
    owner = "Cocoon-AI";
    repo = "architecture-diagram-generator";
    rev = "4b9087d55268c79a935105439dbcd37b630fc3f3";
    hash = "sha256-r1ABUPDqT1SEe9QSEsA/GcN2J5PQmhuxlXMl4EBi9Ro=";
  };

  # Subagent prompts: the common four, each with the caveman-lite snippet
  # appended (parity with the personal host's `enableCaveman = true`).
  # The helper mirrors `home.opencode.agentWithCaveman`.
  cavemanSnippet = builtins.readFile ../../home-manager/common/opencode/caveman-lite.md;
  agentWithCaveman =
    base: pkgs.writeText (baseNameOf base) (builtins.readFile base + "\n\n" + cavemanSnippet);
  opencodeAgents = {
    nix-pkg = agentWithCaveman ../../home-manager/common/agents/nix-pkg.md;
    kiro-spec-orchestrator = agentWithCaveman ../../home-manager/common/agents/kiro-spec-orchestrator.md;
    nvim-tailor = agentWithCaveman ../../home-manager/common/agents/nvim-tailor.md;
    security-auditor = agentWithCaveman ../../home-manager/common/agents/security-auditor.md;
  };

  # Server-variant AGENTS.md: the guest chunk plus the cc-sdd SDD rules
  # appended verbatim (the cc-sdd chunk contains no sandbox/memory
  # references and applies unchanged).
  opencodeAgentsMd = pkgs.writeText "opencode-AGENTS.md" (
    builtins.readFile ./opencode/AGENTS.md
    + "\n\n"
    + builtins.readFile ../../home-manager/common/agents-cc-sdd.md
  );

  # opencode settings, adapted from home-manager/common/opencode.nix:
  # same LSP overrides and disabled title/summary agents, but the bash
  # permission stays fully open (git is a first-class tool on this host;
  # there is no git-mcp to route around the sandbox) and the provider is
  # the loopback LiteLLM gateway. Model ids in the picker read
  # `opencode-litellm/<model-id>`.
  opencodeJsonFormat = pkgs.formats.json { };
  opencodeSettings = opencodeJsonFormat.generate "opencode.json" {
    "$schema" = "https://opencode.ai/config.json";
    model = "opencode-litellm/opencode-go/deepseek-v4.1-flash";
    subagent_depth = 10;
    snapshot = false;
    autoupdate = false;
    agent.title.disable = true;
    agent.summary.disable = true;
    lsp.eslint.command = [
      "vscode-eslint-language-server"
      "--stdio"
    ];
    lsp.typescript.command = [
      "typescript-language-server"
      "--stdio"
    ];
    skills.paths = [ ".claude/skills" ];
    permission = {
      bash."*" = "allow";
      external_directory = "allow";
    };
    provider.opencode-litellm = {
      npm = "@ai-sdk/openai-compatible";
      name = "OpenCode (LiteLLM)";
      options = {
        baseURL = "http://127.0.0.1:4000/v1";
        apiKey = "{env:LITELLM_MASTER_KEY}";
      };
      models = {
        "chatgpt/gpt-6-luna" = {
          name = "GPT-6 Luna (ChatGPT, xhigh)";
        };
        "chatgpt/gpt-6-luna-none" = {
          name = "GPT-6 Luna (ChatGPT, no thinking)";
        };
        "chatgpt/gpt-6-astra" = {
          name = "GPT-6 Astra (ChatGPT, xhigh)";
        };
        "chatgpt/gpt-6.1-sol" = {
          name = "GPT-6.1 Sol (ChatGPT, xhigh)";
        };
        "opencode-go/gpt-6-luna" = {
          name = "GPT-6 Luna (OpenCode Go)";
        };
        "opencode-go/deepseek-v4.1-flash" = {
          name = "DeepSeek V4.1 Flash (OpenCode Go)";
        };
        "opencode-go/glm-5.3-flash" = {
          name = "GLM-5.3 Flash (OpenCode Go)";
        };
        "opencode-go/longcat-2.5-preview-free" = {
          name = "LongCat 2.5 Preview Free (OpenCode Go)";
        };
        "opencode-zen/big-pickle" = {
          name = "Big Pickle (OpenCode Zen)";
        };
      };
    };
  };

  # Git identity + signing for the service (loaded as ~/.gitconfig via
  # HOME). The SSH signing key is installed by ExecStartPre from the
  # systemd credential; ssh-keygen's default signer resolves the .pub
  # path's sibling private key file. URLs are rewritten to HTTPS so the
  # token-based `gh auth git-credential` helper covers every remote.
  opencodeGitconfig = pkgs.writeText "opencode-gitconfig" ''
    [user]
      name = Brandon McNama
      email = brandonmcnama@outlook.com
      signingkey = ${opencodeHome}/.ssh/opencode_signing_key.pub
    [init]
      defaultBranch = main
    [pull]
      rebase = true
    [push]
      autoRemoteSetup = true
    [credential "https://github.com"]
      helper = !gh auth git-credential
    [url "https://github.com/"]
      insteadOf = "git@github.com:"
    [commit]
      gpgsign = true
    [gpg]
      format = ssh
    [branch]
      sort = -committerdate
    [rerere]
      enabled = true
  '';

  # The config tree copied into place on every start. It carries the
  # `opencode/` subdirectory opencode resolves under $XDG_CONFIG_HOME
  # (see the module comment). Skills: the two vendored repo skills, the
  # personal host's Cocoon-AI diagram skill, and every kiro-* skill from
  # cc-sdd-skills. github-native-stacks is deliberately excluded (its
  # workflow depends on MCP Stack tooling this host does not have). The
  # kiro tree is copied with a build-time glob rather than an eval-time
  # `builtins.readDir`: cc-sdd-skills here is an aarch64-linux derivation,
  # and reading its output during evaluation would force building it on
  # the mac (no Linux builder), failing the darwin guest-eval check.
  opencodeConfig = pkgs.runCommand "opencode-config" { } ''
    mkdir -p $out/opencode/agents $out/opencode/skills
    cp ${opencodeSettings} $out/opencode/opencode.json
    cp ${opencodeAgentsMd} $out/opencode/AGENTS.md
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (name: src: "cp ${src} $out/opencode/agents/${name}.md") opencodeAgents
    )}
    cp -r ${../../home-manager/common/skills/fabro-workflow} $out/opencode/skills/fabro-workflow
    cp -r ${processFlowDiagramSkill}/process-flow-diagram $out/opencode/skills/process-flow-diagram
    cp -r ${architectureDiagramSkill}/architecture-diagram $out/opencode/skills/architecture-diagram
    cp -r ${pkgs.cc-sdd-skills}/skills/* $out/opencode/skills/
  '';

  # ExecStartPost health gate (same contract as fabro.nix's/
  # litellm.nix's gates): poll the server root so "active" means the
  # listener answers. With OPENCODE_SERVER_PASSWORD set the root demands
  # basic auth, so 401 also counts as listening (the password never
  # enters argv).
  opencodeHealthGate = pkgs.writeShellApplication {
    name = "opencode-health-gate";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
    ];
    text = ''
      attempts=30
      for (( i = 1; i <= attempts; i++ )); do
        code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 'http://127.0.0.1:4096/' || true)"
        if [ "$code" = "200" ] || [ "$code" = "401" ]; then
          exit 0
        fi
        echo "opencode-health-gate: probe $i/$attempts got ''${code:-none}, retrying" >&2
        sleep 2
      done
      echo "opencode-health-gate: http://127.0.0.1:4096/ never returned 200 or 401" >&2
      exit 1
    '';
  };
in
{
  systemd.services.opencode = {
    description = "OpenCode v1 server (web console + API)";
    wantedBy = [ "multi-user.target" ];

    # Soft dependency: a stopped litellm should not take opencode down
    # (unlike fabro's hard requires); unbounded retries surface the
    # downgraded provider as per-request failures until litellm returns.
    after = [ "litellm.service" ];
    wants = [ "litellm.service" ];

    environment = {
      HOME = opencodeHome;
      XDG_CONFIG_HOME = opencodeConfigDir;
      XDG_DATA_HOME = opencodeDataDir;
      XDG_CACHE_HOME = opencodeCacheDir;
      XDG_STATE_HOME = opencodeStateDir;
      # Same runtime flags the mac wrapper exports (opencode's own LSP
      # tool plus no auto-downloads / no ~/.claude auto-discovery; the
      # common LSP set below is the provisioning path).
      OPENCODE_EXPERIMENTAL_LSP_TOOL = "true";
      OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "true";
    };

    # PATH for the service and everything it spawns (systemd applies it
    # to all Exec* and child processes): the CLIs sessions use (git, gh
    # with gh-stack, nix, ripgrep, ssh-keygen), the cc-sdd toolset, and
    # the common LSP set so opencode resolves servers via `which()`
    # instead of downloading them (same list as the mac module's
    # `home.opencode.lspPackages`).
    path = [
      pkgs.git
      pkgs.gh
      pkgs.nix
      pkgs.ripgrep
      pkgs.openssh
      pkgs.unstable.gh-stack
      pkgs.cc-sdd
      ccSddInit
      pkgs.bash-language-server
      pkgs.clang-tools
      pkgs.gopls
      pkgs.nixd
      pkgs.pyright
      pkgs.rubocop
      pkgs.rust-analyzer
      pkgs.terraform-ls
      pkgs.typescript-language-server
      pkgs.vscode-langservers-extracted
      pkgs.yaml-language-server
    ];

    serviceConfig = {
      DynamicUser = true;

      # /var/lib/opencode and the workspace subdir; systemd creates and
      # chowns both to the dynamic user before any Exec* runs (nested
      # StateDirectory paths need systemd >= 256; NixOS 26.05 ships
      # 257+). The workspace is the service cwd; repos are cloned here.
      StateDirectory = [
        "opencode"
        "opencode/workspace"
      ];
      WorkingDirectory = "${opencodeHome}/workspace";

      # GITHUB_TOKEN + GH_TOKEN (the dedicated PAT), LITELLM_MASTER_KEY
      # (the provider's `{env:…}` api key), and OPENCODE_SERVER_PASSWORD
      # (basic auth; user defaults to `opencode`) from the sops-nix
      # template (see default.nix). systemd reads the root-only file
      # before dropping to the service user.
      EnvironmentFile = config.sops.templates."opencode-env".path;

      # The SSH commit-signing key: sops decrypts it to /run/secrets at
      # activation and LoadCredential copies it into the unit's private
      # credential dir; ExecStartPre installs it as the git signing key.
      LoadCredential = "opencode-signing-key:${config.sops.secrets."opencode-signing-key".path}";

      ExecStartPre = [
        # Runtime scaffolding the state dir does not provide (idempotent;
        # runs as the service user).
        "${pkgs.coreutils}/bin/mkdir -p ${opencodeHome}/.ssh ${opencodeDataDir}/gh/extensions"

        # Declarative-wins config: wipe and re-copy the tree each start.
        # The chmod restores owner-write on the store's read-only modes so
        # runtime settings writes succeed (and are reset next start).
        "${pkgs.coreutils}/bin/rm -rf ${opencodeConfigDir}"
        "${pkgs.coreutils}/bin/cp -r ${opencodeConfig} ${opencodeConfigDir}"
        "${pkgs.coreutils}/bin/chmod -R u+w ${opencodeConfigDir}/opencode"

        # The gh-stack extension, mirrored from home-manager's
        # `programs.gh.extensions` layout (a `bin/` symlink under
        # $XDG_DATA_HOME/gh/extensions).
        "${pkgs.coreutils}/bin/ln -sfn ${pkgs.unstable.gh-stack}/bin ${opencodeDataDir}/gh/extensions/gh-stack"

        "${pkgs.coreutils}/bin/install -m 0644 ${opencodeGitconfig} ${opencodeHome}/.gitconfig"

        # Install the signing key from the credential and derive its
        # .pub (ssh-keygen resolves the .pub path's sibling private key;
        # the redirect needs a shell — systemd does not provide one).
        # Single quotes keep systemd from expanding $CREDENTIALS_DIRECTORY
        # itself; bash expands it from the service environment.
        "${pkgs.bash}/bin/bash -c '${pkgs.coreutils}/bin/install -m 0600 \"$CREDENTIALS_DIRECTORY/opencode-signing-key\" ${opencodeHome}/.ssh/opencode_signing_key && ${pkgs.openssh}/bin/ssh-keygen -y -f ${opencodeHome}/.ssh/opencode_signing_key > ${opencodeHome}/.ssh/opencode_signing_key.pub'"
      ];

      ExecStart = "${pkgs.opencode-pinned}/bin/opencode serve --hostname 127.0.0.1 --port 4096";
      ExecStartPost = lib.getExe opencodeHealthGate;

      Restart = "on-failure";
      RestartSec = 5;
      LimitNOFILE = 65536;

      # Hardening in the fabro-service style. StateDirectory already
      # implies the state-dir write path; ReadWritePaths is kept explicit
      # for legibility.
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
      ];
      ReadWritePaths = [ opencodeHome ];
    };
  };
}
