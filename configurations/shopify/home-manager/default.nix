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

    ./dev.nix
    ./git.nix
    ./opencode.nix
    ./sqlite-backup.nix
    ./tec.nix
    ./wish.nix
    ./zellij.nix
  ];

  home = {
    stateVersion = "25.11";

    cavemem.enable = true;

    packages = with pkgs; [
      gcloud
      mitmproxy
      podman
      stern
    ];

    mcp = {
      obsidianVaultPath = "${config.home.homeDirectory}/Library/CloudStorage/GoogleDrive-brandon.mcnama@shopify.com/My Drive/data-bank";
      githubToken = readKeychainSecret "mcp-github-token";

      keychainSecrets = {
        "mcp-github-token" = "op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub";
        "mcp-infra-central-token" = "op://Employee/Infra Central API Token/password";
        "mcp-explainify-token" = "op://Employee/explainify mcp api token/password";
        "mcp-buildkite-token" = "op://Employee/buildkite mcp api token/password";
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

        fellow-mcp = {
          type = "streamable-http";
          url = "https://fellow.app/mcp";
        };

        gt-mcp = {
          command = "${pkgs.unstable.graphite-cli}/bin/gt";
          args = [ "mcp" ];
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

        explainify-mcp = {
          type = "streamable-http";
          url = "https://explainify.shopifycloud.com/mcp";
          headers.Authorization = "Bearer " + readKeychainSecret "mcp-explainify-token";
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
      };
    };
  };

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
