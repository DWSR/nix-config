{
  pkgs,
  lib,
  ...
}:
let
  gcloud = pkgs.google-cloud-sdk.withExtraComponents [
    pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin
  ];
  readOpSecretCmd = x: "\${cmd: op read --no-newline '${x}'}";
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
      githubToken = readOpSecretCmd "op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub";

      extraServers = {
        vault-mcp = {
          type = "http";
          url = "https://vault.shopify.io/mcp";
          headers.Authorization = "Bearer " + readOpSecretCmd "op://Employee/Vault API Token/password";
        };

        incident-dashboard-mcp = {
          type = "http";
          url = "https://incidents.shopify.io/api/mcp";
          headers.Authorization =
            "Bearer " + readOpSecretCmd "op://Employee/Incident Dashboard API Token/password";
        };

        observe-mcp = {
          type = "http";
          url = "https://proxy-shopify-ai.local.shop.dev/mcp/observe-mcp";
        };

        infra-central-mcp = {
          type = "http";
          url = "https://infra-central.shopify.io/api/mcp";
          headers.Authorization =
            "Bearer " + readOpSecretCmd "op://Employee/Infra Central API Token/password";
        };

        fellow-mcp = {
          type = "http";
          url = "https://fellow.app/mcp";
        };

        gworkspace-mcp = {
          command = "uvx";
          args = [ "gworkspace-mcp" ];
        };

        gt-mcp = {
          command = "gt";
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
          command = "/opt/homebrew/bin/uvx"; # Need to specifically use homebrew uvx because of reasons?
          args = [ "shopify-mcp-bridge" ];
          env = {
            MCP_TARGET_URL = "https://explainify.shopify.io/mcp";
            MCP_API_TOKEN = readOpSecretCmd "op://Employee/explainify mcp api token/password";
          };
        };

        tool-gateway = {
          type = "http";
          url = "https://tool-gateway.shopify.io/mcp";
          headers.Authorization = "Bearer \${TOOL_GATEWAY_TOKEN}";
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
