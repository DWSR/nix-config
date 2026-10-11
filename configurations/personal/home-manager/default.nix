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
        # mcpproxy daemon bearer (its `${env:MCP_PROXY_API_KEY}` top-level
        # api_key; formerly a bridge-owned non-1Password entry that the
        # 1Password sync silently dropped — now an ordinary item). One-time
        # seeding: copy the deployed value out of the Keychain
        # (`security find-generic-password -s mcpproxy -a mcpproxy-api-key -w`)
        # into the 1Password item, then run the sync as usual.
        "mcpproxy-api-key" = "op://Private/MCP Proxy/API Key";
        # OpenCode subscription API key (one key covers both the Go
        # subscription catalog and Zen pay-as-you-go; the reverse proxy
        # address in programs.litellm selects the catalog). Sourced from
        # OpenCode Console; if opencode on this host is already connected,
        # the same key lives in ~/.local/share/opencode/auth.json.
        "opencode-api-key" = "op://Private/OpenCode/API Key";
        # Fabro launchd agent dev-token auth pair
        # (home-manager/common/fabro.nix keychainSecrets). The launchd
        # wrapper exports them into the agent environment at start, so
        # no secret value lands in the launchd plist and the pair
        # survives reboots (launchctl setenv does not). Seed the 1Password
        # Fabro item once with the values currently carried by
        # `launchctl getenv`, then run the usual 1Password keychain sync:
        # the fabro CLI and web sessions are bound to this pair, so
        # reusing them avoids a re-auth; rotating requires re-login.
        "fabro-session-secret" = "op://Private/Fabro/Session Secret";
        "fabro-dev-token" = "op://Private/Fabro/Dev Token";
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

  # Fabro routes its models through the local LiteLLM gateway
  # (docs.fabro.sh/integrations/litellm). Fabro model id → LiteLLM
  # model_name:
  #
  #   gpt-6-luna        chatgpt/gpt-6-luna          (xhigh via litellm default)
  #   gpt-6-luna-none   chatgpt/gpt-6-luna-none     (no thinking; litellm default)
  #   gpt-6-astra       chatgpt/gpt-6-astra         (xhigh)
  #   gpt-6.1-sol       chatgpt/gpt-6.1-sol         (xhigh)
  #   go-gpt-6-luna     opencode-go/gpt-6-luna
  #   glm-5.3-flash     opencode-go/glm-5.3-flash
  #   longcat-2.5       opencode-go/longcat-2.5-preview-free
  #   big-pickle        opencode-zen/big-pickle
  #
  # Effort is constrained per model (capabilities.reasoning_effort) rather
  # than defaulted here: runs that request no effort still inherit the
  # litellm deployment default, and fabro can never send an effort outside
  # the pinned level.
  #
  # Runs need LITELLM_API_KEY in the fabro server vault (env vars are
  # stripped from run workers). One-time setup from the Keychain:
  #   fabro secret set LITELLM_API_KEY "$(/usr/bin/security \
  #     find-generic-password -s mcpproxy -a litellm-master-key -w)"
  # This settings block REPLACES the wizard-written settings.toml at the
  # next switch (fabro.nix owns the file once settings are declared), so
  # the wizard's server.* sections must be maintained here rather than
  # re-recorded by re-running the wizard.
  programs.fabro = {
    enable = true;

    # fabro refuses to start its dev-token auth without this pair (the
    # "auth is configured but SESSION_SECRET is not set" start failure).
    # The launchd wrapper resolves each from the Keychain at start, so a
    # reboot no longer depends on hand-set launchctl setenv values.
    keychainSecrets = {
      SESSION_SECRET = "fabro-session-secret";
      FABRO_DEV_TOKEN = "fabro-dev-token";
    };

    settings = {
      llm.providers.litellm = {
        enabled = true;
        base_url = "http://127.0.0.1:4000/v1";
        default_model = "gpt-6-luna";

        models = {
          "gpt-6-luna" = {
            display_name = "GPT-6 Luna (ChatGPT, xhigh)";
            api_model = "chatgpt/gpt-6-luna";
            limits = {
              context_tokens = 1050000;
              max_output_tokens = 128000;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
              reasoning_effort = {
                xhigh = true;
              };
            };
          };
          "gpt-6-luna-none" = {
            display_name = "GPT-6 Luna (ChatGPT, no thinking)";
            api_model = "chatgpt/gpt-6-luna-none";
            limits = {
              context_tokens = 1050000;
              max_output_tokens = 128000;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
              # lithos has no `none` effort (minimal..max), so no-think
              # stays the unset default: fabro sends no effort and
              # litellm's deployment default (`reasoning_effort = "none"`)
              # applies.
            };
          };
          "gpt-6-astra" = {
            display_name = "GPT-6 Astra (ChatGPT, xhigh)";
            api_model = "chatgpt/gpt-6-astra";
            limits = {
              context_tokens = 1050000;
              max_output_tokens = 128000;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
              reasoning_effort = {
                xhigh = true;
              };
            };
          };
          "gpt-6.1-sol" = {
            display_name = "GPT-6.1 Sol (ChatGPT, xhigh)";
            api_model = "chatgpt/gpt-6.1-sol";
            limits = {
              context_tokens = 1050000;
              max_output_tokens = 128000;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
              reasoning_effort = {
                xhigh = true;
              };
            };
          };
          "go-gpt-6-luna" = {
            display_name = "GPT-6 Luna (OpenCode Go)";
            api_model = "opencode-go/gpt-6-luna";
            limits = {
              context_tokens = 1050000;
              max_output_tokens = 128000;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
              reasoning_effort = {
                low = true;
                medium = true;
                high = true;
                xhigh = true;
                max = true;
              };
            };
          };
          "glm-5.3-flash" = {
            display_name = "GLM-5.3 Flash (OpenCode Go)";
            api_model = "opencode-go/glm-5.3-flash";
            small_default = true;
            limits = {
              context_tokens = 1000000;
              max_output_tokens = 131072;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
              reasoning_effort = {
                low = true;
                high = true;
                max = true;
              };
            };
          };
          "longcat-2.5" = {
            display_name = "LongCat 2.5 Preview Free (OpenCode Go)";
            api_model = "opencode-go/longcat-2.5-preview-free";
            # Same family tier and chat-model window as longcat-2.0's
            # serving; upstream publishes no separate hard output cap.
            limits = {
              context_tokens = 1000000;
              max_output_tokens = 131072;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
            };
          };
          "big-pickle" = {
            display_name = "Big Pickle (OpenCode Zen)";
            api_model = "opencode-zen/big-pickle";
            limits = {
              context_tokens = 200000;
              max_output_tokens = 32000;
            };
            capabilities = {
              text = true;
              tools = true;
              reasoning = true;
            };
          };
        };
      };

      # Wizard-recorded values (fabro owns this file at runtime; the
      # switch-installed copy above carries the same content).
      cli = {
        exec.model = {
          provider = "litellm";
          name = "gpt-6-luna";
        };

        target = {
          type = "http";
          url = "http://127.0.0.1:32276/api/v1";
        };
      };

      run = {
        environment.id = "default";
        model.name = "gpt-6-luna";
      };

      server = {
        api.url = "http://127.0.0.1:32276/api/v1";

        artifacts = {
          prefix = "artifacts";
          provider = "local";
          local.root = "/Users/brandonmcnama/.local/share/fabro/objects";
        };

        auth.methods = [ "dev-token" ];

        integrations.github.strategy = "token";

        listen = {
          address = "127.0.0.1:32276";
          type = "tcp";
        };

        sandbox.providers = {
          daytona.enabled = false;
          docker.enabled = true;
          local.enabled = true;
        };

        web = {
          enabled = true;
          url = "http://127.0.0.1:32276";
        };
      };
    };
  };

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
        # OpenAI subscription (ChatGPT Work/Codex backend, chatgpt/ OAuth
        # device flow — see litellm-chatgpt-login). Reasoning effort is
        # pinned per deployment so the effort travels with the model id;
        # duplicated litellm_params.model entries are fine because model
        # names are distinct (same named upstream model + different
        # default params load-balances instead of pinning).
        [
          {
            model_name = "chatgpt/gpt-6-luna";
            model_info.mode = "responses";
            litellm_params = {
              model = "chatgpt/gpt-6-luna";
              reasoning_effort = "xhigh";
            };
          }
          {
            model_name = "chatgpt/gpt-6-luna-none";
            model_info.mode = "responses";
            litellm_params = {
              model = "chatgpt/gpt-6-luna";
              reasoning_effort = "none";
            };
          }
          {
            model_name = "chatgpt/gpt-6-astra";
            model_info.mode = "responses";
            litellm_params = {
              model = "chatgpt/gpt-6-astra";
              reasoning_effort = "xhigh";
            };
          }
          {
            model_name = "chatgpt/gpt-6.1-sol";
            model_info.mode = "responses";
            litellm_params = {
              model = "chatgpt/gpt-6.1-sol";
              reasoning_effort = "xhigh";
            };
          }
        ]
        # OpenCode Go Responses-API wire models.
        ++ (map (m: {
          model_name = "opencode-go/${m}";
          model_info.mode = "responses";
          litellm_params = {
            model = "openai/${m}";
            api_base = "https://opencode.ai/zen/go/v1";
            api_key = "os.environ/OPENCODE_API_KEY";
          };
        }) [ "gpt-6-luna" ])
        # OpenCode Go chat/completions wire models.
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
            "longcat-2.5-preview-free"
          ]
        )
        # Big Pickle is not part of the Go catalog (opencode.ai/docs/go):
        # the stealth model serves on the Zen balance endpoint, which the
        # OpenCode API key reaches unchanged (usage draws from the balance
        # behind the Go subscription).
        ++ [
          {
            model_name = "opencode-zen/big-pickle";
            model_info.mode = "chat";
            litellm_params = {
              model = "openai/big-pickle";
              api_base = "https://opencode.ai/zen/v1";
              api_key = "os.environ/OPENCODE_API_KEY";
            };
          }
        ];
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
