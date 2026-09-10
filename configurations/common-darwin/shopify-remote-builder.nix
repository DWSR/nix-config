{
  lib,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  repositoryOptions = {
    options = {
      provider = mkOption {
        type = types.str;
        description = "Provider name for an allowlisted public repository.";
      };

      owner = mkOption {
        type = types.str;
        description = "Exact owner or organization for an allowlisted repository.";
      };

      repository = mkOption {
        type = types.str;
        description = "Exact repository name for an allowlisted public repository.";
      };
    };
  };

  publicCacheOptions = {
    options = {
      endpoint = mkOption {
        type = types.str;
        description = "Anonymous public binary-cache endpoint used for attestations.";
      };

      trustedKeys = mkOption {
        type = types.listOf types.str;
        description = "Signing keys trusted for this public-cache endpoint.";
      };
    };
  };

  sshOptions = {
    options = {
      user = mkOption {
        type = types.str;
        default = "_nixremote";
        description = "Dedicated personal-host account used by the restricted SSH service.";
      };

      uid = mkOption {
        type = types.ints.unsigned;
        default = 502;
        description = "Host-local UID reserved for the dedicated personal-host account.";
      };

      port = mkOption {
        type = types.ints.positive;
        default = 22;
        description = "LAN SSH port for the personal remote-builder service.";
      };

      clientPublicKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Committed public half of the Shopify client key.";
      };

      privateKeyFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Runtime path to the Shopify client private key.";
      };

      publicHostKey = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Pinned personal-host SSH public-key record.";
      };

      sourceCidrs = mkOption {
        type = types.listOf types.str;
        default = [
          "10.0.0.0/8"
          "172.16.0.0/12"
          "192.168.0.0/16"
        ];
        description = "LAN source CIDRs accepted by the restricted SSH service.";
      };
    };
  };

  validationOptions = {
    options = {
      timeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30 * 60;
        description = "Maximum duration of one eligibility validation.";
      };

      maxDerivations = mkOption {
        type = types.ints.positive;
        default = 10000;
        description = "Maximum derivations traversed by eligibility validation.";
      };

      maxInputSources = mkOption {
        type = types.ints.positive;
        default = 1000;
        description = "Maximum input sources traversed by eligibility validation.";
      };

      maxFixedOutputs = mkOption {
        type = types.ints.positive;
        default = 256;
        description = "Maximum fixed-output derivations replayed by eligibility validation.";
      };

      maxWorkspaceBytes = mkOption {
        type = types.ints.positive;
        default = 20 * 1024 * 1024 * 1024;
        description = "Maximum temporary workspace permitted for eligibility validation.";
      };

      publicInterface = mkOption {
        type = types.str;
        default = "en0";
        description = "Declared non-VPN interface for public-source validation.";
      };

      maxRedirects = mkOption {
        type = types.ints.unsigned;
        default = 5;
        description = "Maximum HTTPS redirects followed during public-source validation.";
      };

      stateDirectory = mkOption {
        type = types.str;
        default = "/var/db/shopify-remote-builder/requests";
        description = "Personal-only runtime directory for invocation lease state.";
      };

      leaseIdleTtlSeconds = mkOption {
        type = types.ints.positive;
        default = 60 * 60;
        description = "Inactivity period before an unheld invocation lease expires.";
      };

      heartbeatSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "Interval between active lease keeper heartbeats.";
      };

      publicCaches = mkOption {
        type = types.listOf (types.submodule publicCacheOptions);
        default = [
          {
            endpoint = "https://cache.nixos.org";
            trustedKeys = [
              "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
            ];
          }
          {
            endpoint = "https://nix-community.cachix.org";
            trustedKeys = [
              "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
            ];
          }
        ];
        description = "Approved anonymous public caches for dependency-closure attestations.";
      };
    };
  };
in
{
  options.services.shopifyRemoteBuilder = {
    enable = mkEnableOption "explicit guarded public remote builds";

    role = mkOption {
      type = types.enum [
        "personal"
        "shopify"
      ];
      default = "personal";
      description = "The single host role represented by this configuration.";
    };

    endpoint = mkOption {
      type = types.str;
      default = "Brandons-MacBook-Pro.local";
      description = "Declared LAN hostname of the personal remote-builder endpoint.";
    };

    system = mkOption {
      type = types.str;
      default = "aarch64-darwin";
      description = "Nix system supported by the remote-builder workflow.";
    };

    allowedRepositories = mkOption {
      type = types.listOf (types.submodule repositoryOptions);
      default = [
        {
          provider = "github";
          owner = "NixOS";
          repository = "nixpkgs";
        }
      ];
      description = "Exact public repository triples eligible for guarded evaluation.";
    };

    ssh = mkOption {
      type = types.submodule sshOptions;
      default = { };
      description = "Restricted SSH identity, host trust, and source-network contract.";
    };

    validation = mkOption {
      type = types.submodule validationOptions;
      default = { };
      description = "Bounded public-source validation and invocation-lease settings.";
    };
  };
}
