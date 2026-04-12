{
  pkgs,
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
  imports = [
    ../../../home-manager/common
    ../../../home-manager/mcp

    ./dev.nix
    ./git.nix
    ./opencode.nix
    ./wish.nix
  ];

  home = {
    stateVersion = "25.11";

    packages = with pkgs; [
      gcloud
      podman
      stern
      uv
    ];

    mcp = {
      obsidianVaultPath = "${config.home.homeDirectory}/Library/CloudStorage/GoogleDrive-brandon.mcnama@shopify.com/My Drive/data-bank";
      githubToken = readKeychainSecret "mcp-github-token";

      keychainSecrets = {
        "mcp-github-token" = "op://Employee/GitHub - Shopify/PATs/shopify laptop mcphub";
        "mcp-vault-token" = "op://Employee/Vault API Token/password";
        "mcp-incident-dashboard-token" = "op://Employee/Incident Dashboard API Token/password";
        "mcp-infra-central-token" = "op://Employee/Infra Central API Token/password";
        "mcp-explainify-token" = "op://Employee/explainify mcp api token/password";
        "mcp-buildkite-token" = "op://Employee/buildkite mcp api token/password";
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
          headers.Authorization = "Bearer " + readKeychainSecret "mcp-incident-dashboard-token";
        };

        observe-mcp = {
          type = "http";
          url = "https://proxy-shopify-ai.local.shop.dev/mcp/observe-mcp";
        };

        infra-central-mcp = {
          type = "http";
          url = "https://infra-central.shopify.io/api/mcp";
          headers.Authorization = "Bearer " + readKeychainSecret "mcp-infra-central-token";
        };

        fellow-mcp = {
          type = "streamable-http";
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

        chrome-devtools = {
          command = "${pkgs.chrome-devtools-mcp}/bin/chrome-devtools-mcp";
        };
      };
    };
  };

  nixvim-extra.shadowenv.enable = true;
}
