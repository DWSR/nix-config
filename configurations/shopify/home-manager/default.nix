{
  pkgs,
  config,
  ...
}:
let
  gcloud = pkgs.unstable.google-cloud-sdk.withExtraComponents [
    pkgs.unstable.google-cloud-sdk.components.gke-gcloud-auth-plugin
  ];
  inherit (config.home.mcp) readKeychainSecret;
  gitCloneIsolation = config.programs.git-clone-isolation;
in
{
  imports = [
    ../../../home-manager/common
    ../../../home-manager/common/cavemem.nix
    ../../../home-manager/mcp

    ./binks-pr-review.nix
    ./deskflow.nix
    ./dev.nix
    ./git.nix
    ./opencode.nix
    ./pi.nix
    ./sqlite-backup.nix
    ./tec.nix
    ./wish.nix
    ./zellij.nix
  ];

  home = {
    stateVersion = "26.05";

    packages = with pkgs; [
      gcloud
      mitmproxy
      podman
      stern
    ];

    mcp = {
      githubToken = readKeychainSecret "mcp-github-token";

      gitMcpSigning = {
        enable = true;
        identityLabel = "git-mcp-ShopifyLaptop";
        ctkPublicKeyHash = "7d5463f4d483485cbf90497702036e722ecb2271";
        sshPublicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBB4WEp/Ag0LY6yYwzBCaDRjRU5qgIPMpBlCkGwf9ZL5+kbLvGq8sGOPJcijNU1iPzKeurg1m1p6LofslmCRiMtEAAAAEc3NoOg==";
        sshFingerprint = "SHA256:qhnFhZupVqXHi/o3gKYiI6oOa3d5JopIx/tERrIN/fQ";
        githubSigningKeyRegistered = true;
      };

      keychainSecrets = {
        "mcp-github-token" = "op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub";
        "mcp-infra-central-token" = "op://Employee/Infra Central API Token/password";
        "mcp-buildkite-token" = "op://Employee/buildkite mcp api token/password";
        "agentmemory-bearer" = "op://Employee/AgentMemory/Bearer";
      };

      fileSourcedEnv.TOOL_GATEWAY_TOKEN = {
        path = "${config.home.homeDirectory}/.cache/tool-gateway-token";
        transform = "/usr/bin/cut -d= -f2-";
        triggersRestart = true;
      };

      # gh CLI auth token. Reuses the same PAT as mcp-github-token because
      # both consumers need the same GitHub repo / read scopes; the PAT is
      # already provisioned for mcphub's github MCP server. If you ever
      # need a separately-scoped gh CLI token, point this at a distinct
      # 1P item.
      ghAuthToken = "op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub";

      # Expose the same GitHub PAT to Nix as `access-tokens = github.com=…`
      # so `nix` / `darwin-rebuild` can fetch `github:` flake inputs and
      # tarballs without rate-limiting/auth failures. Reuses the existing
      # `mcp-github-token` secret; the sops bridge renders it into
      # /etc/nix/nix.conf.d/github-access-token.conf at activation.
      nixAccessTokenSecret = "mcp-github-token";

      extraServers = {
        infra-central-mcp = {
          type = "http";
          url = "https://infra-central.shopify.io/api/mcp";
          headers.Authorization = "Bearer " + readKeychainSecret "mcp-infra-central-token";
        };

        grep-app = {
          command = "${pkgs.grep-app-mcp}/bin/grep-app-mcp";
        };

        ast-grep = {
          command = "${pkgs.ast-grep-mcp}/bin/ast-grep-mcp";
        };

        buildkite = {
          command = "${pkgs.buildkite-mcp-server}/bin/buildkite-mcp-server";
          args = [
            "stdio"
            "--enabled-toolsets=all"
          ];
          env.BUILDKITE_API_TOKEN = readKeychainSecret "mcp-buildkite-token";
        };

        fellow = {
          type = "http";
          url = "https://fellow.app/mcp";
          # An empty object enables OAuth with Dynamic Client Registration.
          oauth = { };
        };

        tool-gateway = {
          type = "http";
          url = "https://tool-gateway.shopify.io/mcp";
          headers.Authorization = "Bearer " + "\${env:TOOL_GATEWAY_TOKEN}";
          # Re-index this upstream hourly, overriding the global "0s"
          # (disabled) sweep. The gateway's tool set changes over time, so
          # periodic re-discovery keeps the search index current.
          tool_discovery_interval = "1h";
        };

        gcloud-mcp = {
          command = "${pkgs.gcloud-mcp}/bin/gcloud-mcp";
        };

        observability-mcp-gcp = {
          command = "${pkgs.observability-mcp}/bin/observability-mcp";
        };

        storage-mcp = {
          command = "${pkgs.storage-mcp}/bin/storage-mcp";
        };

        chrome-devtools = {
          command = "${pkgs.chrome-devtools-mcp}/bin/chrome-devtools-mcp";
        };

        yugabyte-gh-issue-backlog-review = {
          command = "${config.home.homeDirectory}/.local/state/tec/profiles/base/current/global/bin/quick";
          args = [
            "mcp"
            "yugabyte-gh-issue-backlog-review"
          ];
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
    # AgentMemory's Anthropic provider appends /v1/messages to
    # ANTHROPIC_BASE_URL. Mint the short-lived Shopify gateway credentials for
    # each daemon launch rather than persisting them in launchd or Nix output.
    wrapperCommands = [
      ''
        # launchd does not inherit Home Manager's interactive sessionPath.
        export PATH="${config.home.homeDirectory}/.local/state/tec/toolchain/base_profile/share/dev/bin/user:$PATH"

        ANTHROPIC_API_KEY="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --key 2>/dev/null)" || {
          echo "Error: Failed to get ANTHROPIC_API_KEY from devx llm-gateway print-token --key within 15 seconds" >&2
          exit 1
        }
        export ANTHROPIC_API_KEY

        ANTHROPIC_BASE_URL="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --base 2>/dev/null)/apis/anthropic" || {
          echo "Error: Failed to get ANTHROPIC_BASE_URL from devx llm-gateway print-token --base within 15 seconds" >&2
          exit 1
        }
        export ANTHROPIC_BASE_URL

        export ANTHROPIC_MODEL="claude-haiku-4-5"

        OPENAI_API_KEY="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --key 2>/dev/null)" || {
          echo "Error: Failed to get OPENAI_API_KEY for embeddings from devx llm-gateway print-token --key within 15 seconds" >&2
          exit 1
        }
        export OPENAI_API_KEY
        # Keep the OpenAI credential scoped to embeddings; Anthropic remains
        # the AgentMemory LLM provider.
        export OPENAI_API_KEY_FOR_LLM="false"

        OPENAI_EMBEDDING_BASE_URL="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --base 2>/dev/null)/vendors/openai/v1" || {
          echo "Error: Failed to get OPENAI_EMBEDDING_BASE_URL from devx llm-gateway print-token --base within 15 seconds" >&2
          exit 1
        }
        export OPENAI_EMBEDDING_BASE_URL
        export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
        export EMBEDDING_PROVIDER="openai"

        export AGENTMEMORY_AUTO_COMPRESS="true"
        export GRAPH_EXTRACTION_ENABLED="true"
      ''
    ];
  };

  xdg.dataFile."orangemonkey/github-pr-review-chords.user.js".source =
    ./github-pr-review-chords.user.js;

  launchd.agents.git-clone-isolation-globaldb-yugabyte-refresh = {
    inherit (gitCloneIsolation) enable;
    config = {
      Label = "dev.dwsr.git-clone-isolation.globaldb-yugabyte-refresh";
      ProgramArguments = [
        "${gitCloneIsolation.package}/bin/git-cache-clone"
        "refresh"
        "--repo"
        "https://github.com/Shopify/globaldb-yugabyte"
        "--branch"
        "main"
        "--cache-root"
        gitCloneIsolation.cacheRoot
      ];
      RunAtLoad = true;
      StartInterval = 600;
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/git-clone-isolation-globaldb-yugabyte-refresh.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/git-clone-isolation-globaldb-yugabyte-refresh.error.log";
    };
  };

  launchd.agents.git-clone-isolation-terraform-the-cloud-refresh = {
    inherit (gitCloneIsolation) enable;
    config = {
      Label = "dev.dwsr.git-clone-isolation.terraform-the-cloud-refresh";
      ProgramArguments = [
        "${gitCloneIsolation.package}/bin/git-cache-clone"
        "refresh"
        "--repo"
        "https://github.com/Shopify/terraform-the-cloud"
        "--branch"
        "main"
        "--cache-root"
        gitCloneIsolation.cacheRoot
      ];
      RunAtLoad = true;
      StartInterval = 600;
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/git-clone-isolation-terraform-the-cloud-refresh.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/git-clone-isolation-terraform-the-cloud-refresh.error.log";
    };
  };

  nixvim-extra.shadowenv.enable = true;
}
