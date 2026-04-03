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

        gcp-mcp-server = {
          command = "/opt/homebrew/bin/uvx"; # Need to specifically use homebrew uvx because of reasons?
          args = [ "shopify-mcp-bridge" ];
          env = {
            MCP_TARGET_URL = "https://gcp.shopifycloud.com/mcp";
            GCP_IAP_CLIENT_ID = "13501465310-0288jvqmn87i69ra0ab95pj6ak7b1p6r.apps.googleusercontent.com";
            GCP_IAP_CLIENT_SECRET_PATH = "projects/13501465310/secrets/gcp-mcp-server-production-oauth-client-secret";
          };
        };

        browsermcp = {
          command = "${pkgs.browsermcp}/bin/mcp-server-browsermcp";
        };

        buildkite = {
          type = "http";
          url = "https://mcp.buildkite.com/mcp";
        };

        explainify-mcp = {
          type = "streamable-http";
          url = "https://explainify.shopify.io/mcp";
          headers.Authorization =
            "Bearer " + readOpSecretCmd "op://Employee/explainify mcp api token/password";
        };

        tool-gateway = {
          type = "http";
          url = "https://tool-gateway.shopify.io/mcp";
          headers.Authorization = "Bearer $${TOOL_GATEWAY_TOKEN}";
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

  programs.nixvim.extraPlugins = [
    (pkgs.vimUtils.buildVimPlugin {
      name = "Shopify/shadowenv.vim";

      src = pkgs.fetchFromGitHub {
        owner = "Shopify";
        repo = "shadowenv.vim";
        rev = "c306d272b2280b7163b160fc27630eb9c16a3f4a";
        hash = "sha256-MEcZfUmjXsBXuyeMTUNS778Kq4g4+lJ/NkeXVawoQpA=";
      };
    })
  ];

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
