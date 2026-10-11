{
  inputs,
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.home.mcp) readKeychainSecret;
in
{
  imports = [
    # Local override of inputs.op-shell-plugins.hmModules.default to silence
    # the `programs.zsh.initExtra is deprecated` home-manager warning until
    # upstream migrates to `initContent`. See op-shell-plugins.nix for details.
    ./op-shell-plugins.nix

    ../../../home-manager/common
    ../../../home-manager/mcp
    ./deskflow.nix
    ./git.nix
    ./omlx.nix
    ./opencode.nix
    ./sqlite-backup.nix
  ];

  disabledModules = [
    # Replaced by ./op-shell-plugins.nix above.
    "${inputs.op-shell-plugins}/nix/home-manager.nix"
  ];

  home = {
    stateVersion = "26.05";

    omlx.enable = true;

    packages = with pkgs; [
      butane
      fastmail-mcp
      flyctl
      ghq
      git-issue-tracker
      hcloud
      kagimcp
      nh
      omlx
      slack-mcp-server
      vfkit
      wireshark
    ];

    mcp = {
      githubToken = readKeychainSecret "mcp-github-token";

      gitMcpSigning = {
        enable = true;
        identityLabel = "git-mcp-Brandons-MacBook-Pro";
        ctkPublicKeyHash = "1369125950525141027de79370edc83f4f38cd9a";
        sshPublicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBLn2sYSgv7JkEHM8P9AiF/ol5L9TQRqyTT9VNoARiUNHFpuuxUmmXjkPHRM1bC/OaCUKFbK29Ew1I9G0ra7QyssAAAAEc3NoOg==";
        sshFingerprint = "SHA256:O5RAWRtioDIJp8b8X4276kiZNrqz2qTdszTfkk1cc8I";
        githubSigningKeyRegistered = true;
      };

      keychainSecrets = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
        "mcp-kagi-token" = "op://Private/Kagi/API Token";
        "mcp-fastmail-token" = "op://Private/Fastmail/API Tokens/mcp";
        "mcp-fastmail-username" = "op://Private/Fastmail/username";
        "mcp-fastmail-caldav-password" = "op://Private/Fastmail/App Passwords/MCP";
        "mcp-beeper-token" = "op://Private/Beeper/Desktop API Access Tokens/mcphub";
        "mcp-hangops-xoxc" = "op://Private/HangOps/Tokens/xoxc";
        "mcp-hangops-xoxd" = "op://Private/HangOps/Tokens/xoxd";
        "agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
        # oMLX local inference server API key (secrets/mcp.personal.yaml
        # `omlx-api-key`). mcp-secrets-activate writes it to the Keychain
        # under -s mcpproxy -a omlx-api-key; the personal opencode wrapper
        # (configurations/personal/home-manager/opencode.nix) reads it and
        # exports OMLX_API_KEY for the provider.omlx `{env:...}` reference.
        "omlx-api-key" = "op://Private/oMLX/API Key";
        # LiteLLM proxy master key (home-manager/common/litellm.nix). The
        # Bearer value every local consumer (total-recall, fabro, curl)
        # presents to the loopback gateway. Generate one, e.g.
        # `openssl rand -hex 32`, in the LiteLLM 1Password item.
        "litellm-master-key" = "op://Private/LiteLLM/Master Key";
        # OpenCode subscription API key (one key covers both the Go
        # subscription catalog and Zen pay-as-you-go; the reverse proxy
        # address in programs.litellm selects the catalog). Sourced from
        # OpenCode Console; if opencode on this host is already connected,
        # the same key lives in ~/.local/share/opencode/auth.json.
        "opencode-api-key" = "op://Private/OpenCode/API Key";
      };

      # gh CLI auth token. Reuses the same PAT as mcp-github-token because
      # both consumers need the same GitHub repo / read scopes; the PAT is
      # already provisioned for mcphub's github MCP server. If you ever
      # need a separately-scoped gh CLI token, point this at a distinct
      # 1P item.
      ghAuthToken = "op://Private/GitHub/Tokens/Full Control";

      # Expose the same GitHub PAT to Nix as `access-tokens = github.com=…`
      # so `nix` / `darwin-rebuild` can fetch `github:` flake inputs and
      # tarballs without rate-limiting/auth failures. Reuses the existing
      # `mcp-github-token` secret; the sops bridge renders it into
      # /etc/nix/nix.conf.d/github-access-token.conf at activation.
      nixAccessTokenSecret = "mcp-github-token";

      extraServers = {
        kagi = {
          command = "${pkgs.kagimcp}/bin/kagimcp";
          env.KAGI_API_KEY = readKeychainSecret "mcp-kagi-token";
        };

        fastmail = {
          command = "${pkgs.fastmail-mcp}/bin/fastmail-mcp";
          env = {
            FASTMAIL_API_TOKEN = readKeychainSecret "mcp-fastmail-token";
            FASTMAIL_CALDAV_USERNAME = readKeychainSecret "mcp-fastmail-username";
            FASTMAIL_CALDAV_PASSWORD = readKeychainSecret "mcp-fastmail-caldav-password";
          };
        };

        grep-app = {
          command = "${pkgs.grep-app-mcp}/bin/grep-app-mcp";
        };

        ast-grep = {
          command = "${pkgs.ast-grep-mcp}/bin/ast-grep-mcp";
        };

        gh-stack-mcp = {
          command = "${pkgs.gh-stack-mcp}/bin/gh-stack-mcp";
        };

        beeper = {
          type = "http";
          url = "http://localhost:23373/v0/mcp";
          headers = {
            Authorization = "Bearer " + readKeychainSecret "mcp-beeper-token";
          };
        };

        slack-hangops = {
          command = "${pkgs.slack-mcp-server}/bin/slack-mcp-server";
          env = {
            SLACK_MCP_XOXC_TOKEN = readKeychainSecret "mcp-hangops-xoxc";
            SLACK_MCP_XOXD_TOKEN = readKeychainSecret "mcp-hangops-xoxd";
            SLACK_MCP_ENABLED_TOOLS = lib.strings.concatStringsSep "," [
              "conversations_history"
              "conversations_replies"
              "conversations_add_message"
              "reactions_add"
              "reactions_remove"
              "attachment_get_data"
              "conversations_search_messages"
              "channels_list"
              "usergroups_list"
              "usergroups_me"
              "usergroups_create"
              "usergroups_update"
              "usergroups_users_update"
            ];
          };
        };
      };
    };
  };

  programs.agentmemory = {
    enable = true;
    dataDir = "${config.xdg.dataHome}/agentmemory";
    runtimeDir = "${config.home.homeDirectory}/.agentmemory";
    logDir = "${config.home.homeDirectory}/Library/Logs/agentmemory";
    bearerReference = "agentmemory-bearer";
  };

  programs.fabro.enable = true;

  # LiteLLM proxy: one loopback OpenAI-compatible gateway in front of the
  # subscription-backed models, so local consumers (total-recall, fabro,
  # curl) can call them without per-provider integrations. Consumer usage
  # contract (base URL, auth, chatgpt sign-in) is documented in
  # home-manager/common/litellm.nix.
  #
  #   chatgpt/<model>      ChatGPT subscription (Codex backend; no API key —
  #                        OAuth device flow). Complete the one-time sign-in
  #                        with `litellm-chatgpt-login` in a terminal, then
  #                        restart the agent (litellm 1.86 HELD its first
  #                        startup on the login prompt). /v1/chat/completions
  #                        is bridged to the Responses API upstream.
  #   opencode-go/<model>  OpenCode Go subscription; one API key also steers
  #                        the Zen balance fallback. gpt/grok model ids go to
  #                        {api_base}/responses, the GLM/Kimi/DeepSeek/MiMo
  #                        ids to /chat/completions.
  #
  # The model ids mirror the servable catalog when this block landed
  # (litellm docs providers/chatgpt, opencode.ai/docs/go). Catalogs move:
  # trim or extend these lists as the subscriptions' offerings change.
  programs.litellm = {
    enable = true;

    providerKeys.OPENCODE_API_KEY = "opencode-api-key";

    settings = {
      model_list =
        # ChatGPT subscription (Codex) models.
        (map
          (m: {
            model_name = "chatgpt/${m}";
            model_info.mode = "responses";
            litellm_params.model = "chatgpt/${m}";
          })
          [
            "gpt-5.4"
            "gpt-5.4-pro"
            "gpt-5.3-codex"
            "gpt-5.3-codex-spark"
            "gpt-5.3-instant"
            "gpt-5.3-chat-latest"
          ]
        )
        # OpenCode Go: Responses-API wire models.
        ++ (map
          (m: {
            model_name = "opencode-go/${m}";
            model_info.mode = "responses";
            litellm_params = {
              model = "openai/${m}";
              api_base = "https://opencode.ai/zen/go/v1";
              api_key = "os.environ/OPENCODE_API_KEY";
            };
          })
          [
            "grok-4.7"
            "grok-4.6"
            "gpt-6-luna"
            "gpt-5.6-luna"
          ]
        )
        # OpenCode Go: chat/completions wire models ("open coding models").
        ++ (map
          (m: {
            model_name = "opencode-go/${m}";
            model_info.mode = "chat";
            litellm_params = {
              model = "openai/${m}";
              api_base = "https://opencode.ai/zen/go/v1";
              api_key = "os.environ/OPENCODE_API_KEY";
            };
          })
          [
            "glm-5.3-flash"
            "glm-5.3"
            "glm-5.2"
            "glm-5.1"
            "kimi-k3"
            "kimi-k2.7-code"
            "kimi-k2.6"
            "deepseek-v4-pro"
            "deepseek-v4-flash"
            "mimo-v2.6-flash"
            "mimo-v2.6-pro"
            "longcat-2.0"
          ]
        );
    };
  };

  programs.ssh = {
    includes = [ "~/.orbstack/ssh/config" ];

    settings = {
      "192.168.1.1" = {
        User = "root";
        IdentitiesOnly = true;
        IdentityFile = "~/.ssh/unifi.pub";
        SetEnv.TERM = "xterm-256color";

        PasswordAuthentication = "no";
        HostKeyAlgorithms = "+ssh-rsa";
      };

      "192.168.1.69" = {
        User = "root";
        SetEnv.TERM = "xterm-256color";
        PasswordAuthentication = "yes";
      };
    };
  };

  programs.atuin.settings.sync_address = "https://atuin.mcnama.family";

  programs._1password-shell-plugins = {
    enable = true;

    plugins = with pkgs; [
      flyctl
      gh
      hcloud
    ];
  };

}
