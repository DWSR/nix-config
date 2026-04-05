{
  pkgs,
  lib,
  config,
  ...
}:
let
  gcloud = pkgs.unstable.google-cloud-sdk.withExtraComponents [
    pkgs.unstable.google-cloud-sdk.components.gke-gcloud-auth-plugin
  ];
  readKeychainSecret = config.home.mcp.readKeychainSecret;
in
{

  home = {
    stateVersion = "25.11";
    preferXdgDirectories = true;

    packages = with pkgs; [
      podman
      atuin
      kubectl
      k9s
      direnv
      shadowenv
      openssh
      dyff
      cloc
      cosign
      crane
      curl
      entr
      rclone
      rsync
      readline
      stern
      tree
      viddy
      karabiner-elements
      alejandra
      apple-sdk
      lazygit
      xz
      gcloud
      unstable.slack
      raycast
      uv
    ];

    mcp = {
      githubToken = readKeychainSecret "mcp-github-token";

      keychainSecrets = {
        "mcp-github-token" = "op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub";
        "mcp-vault-token" = "op://Employee/Vault API Token/password";
        "mcp-incident-dashboard-token" = "op://Employee/Incident Dashboard API Token/password";
        "mcp-infra-central-token" = "op://Employee/Infra Central API Token/password";
        "mcp-explainify-token" = "op://Employee/explainify mcp api token/password";
      };

      extraServers = {
        vault-mcp = {
          type = "http";
          url = "https://vault.shopify.io/mcp";
          headers.Authorization = "Bearer " + readKeychainSecret "mcp-vault-token";
        };

        incident-dashboard-mcp = {
          type = "http";
          url = "https://incidents.shopify.io/api/mcp";
          headers.Authorization =
            "Bearer " + readKeychainSecret "mcp-incident-dashboard-token";
        };

        observe-mcp = {
          type = "http";
          url = "https://proxy-shopify-ai.local.shop.dev/mcp/observe-mcp";
        };

        infra-central-mcp = {
          type = "http";
          url = "https://infra-central.shopify.io/api/mcp";
          headers.Authorization =
            "Bearer " + readKeychainSecret "mcp-infra-central-token";
        };

        fellow-mcp = {
          type = "http";
          url = "https://fellow.app/mcp";
        };

        gworkspace-mcp = {
          command = "${pkgs.uv}/bin/uvx";
          args = [ "gworkspace-mcp" ];
        };

        gt-mcp = {
          command = "${pkgs.unstable.graphite-cli}/bin/gt";
          args = [ "mcp" ];
        };


        browsermcp = {
          command = "${pkgs.browsermcp}/bin/mcp-server-browsermcp";
        };

        buildkite = {
          type = "http";
          url = "https://mcp.buildkite.com/mcp";
        };

        explainify-mcp = {
          command = "${pkgs.uv}/bin/uvx"; # Need to specifically use homebrew uvx because of reasons?
          args = [ "shopify-mcp-bridge" ];
          env = {
            MCP_TARGET_URL = "https://explainify.shopify.io/mcp";
            MCP_API_TOKEN = readKeychainSecret "mcp-explainify-token";
          };
        };

        tool-gateway = {
          type = "http";
          url = "https://tool-gateway.shopify.io/mcp";
          headers.Authorization = "Bearer \${cmd: cut -d= -f2- ~/.cache/tool-gateway-token}";
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
      };
    };
  };

  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    extraConfig = "IdentityAgent \"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";

    matchBlocks = {
      "*" = {
        forwardAgent = false;
        addKeysToAgent = "no";
        controlMaster = "auto";
        controlPath = "~/.ssh/master-%r@%n:%p";
        controlPersist = "no";
        hashKnownHosts = false;
        userKnownHostsFile = "~/.ssh/known_hosts";
        serverAliveInterval = 0;
        serverAliveCountMax = 3;
        compression = true;
      };
    };
  };

  nixvim-extra.shadowenv.enable = true;

  nixpkgs.config.allowUnfreePredicate =
    pkg:
    builtins.elem (lib.getName pkg) [
      "1password-cli"
      "1password"
      "graphite-cli"
      "raycast"
      "keymapp"
      "slack"
    ];

  imports = [
    ../../../home-manager/common
    ../../../home-manager/mcp

    ./dev.nix
    ./git.nix
    ./wish.nix
  ];
}
