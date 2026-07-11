{ username, ... }:
{
  imports = [
    ../common-darwin
    ../common-darwin/mcp-sops-bridge.nix
  ];

  nix-config.repoPath = "/Users/${username}/src/github.com/DWSR/nix-config";

  sops = {
    defaultSopsFile = ../../secrets/mcp.shopify.yaml;
    # Skip build-time validation that every declared `sops.secrets.<name>`
    # key exists in `defaultSopsFile`. Until Task 4.4 runs
    # `mcp-sync-from-1password` to produce the real encrypted yaml, the
    # file at this path is a one-line placeholder (committed so the path
    # expression resolves and the flake's git-tree visibility check
    # passes) that does not contain the declared keys. Activation
    # (Task 4.5) is operator-gated and is the point at which decryption
    # actually runs; validating sopsFile contents at build time only
    # blocks `nix build` here without adding safety, since activation
    # would catch the same problem.
    validateSopsFiles = false; # TODO: remove once Task 4.4 produces the real encrypted yaml

    # Deskflow client TLS identity (cert + private key, PEM). Decrypted to an
    # owner-only path under /run/secrets and referenced by path from this host's
    # home.deskflow.tls.certificateFile -- the key never enters the Nix store.
    # sops-nix's HM module is broken on darwin, so the secret is declared at the
    # system level here. See secrets/deskflow-cert.shopify.yaml and
    # home-manager/deskflow.nix.
    secrets."deskflow-cert" = {
      sopsFile = ../../secrets/deskflow-cert.shopify.yaml;
      # The cert PEM is stored as the `data` key of a sops YAML envelope (the
      # generator uses `sops --input-type binary --output-type yaml`). Decrypt it
      # as YAML and extract that key. NOTE: do NOT use `format = "binary"` here --
      # sops-nix's binary path uses sops's binary store, which expects a JSON
      # envelope and fails on the YAML one ("cannot parse json ... invalid
      # character 'd'" from the leading `data:`).
      format = "yaml";
      key = "data";
      owner = username;
      mode = "0400";
    };
  };

  nix = {
    enable = true;

    envVars = {
      AWS_SHARED_CREDENTIALS_FILE = "/etc/nix/aws/credentials";
    };

    extraOptions = ''
      !include nix.conf.d/shopify.conf
    '';
  };

  home-manager.users.${username} = import ./home-manager;

  # Private Shopify taps use builtins.fetchGit intentionally.
  # They cannot be flake inputs because nix flake update would fail
  # on machines without Shopify GitHub credentials.
  nix-homebrew = {
    taps = {
      "Shopify/homebrew-shopify" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-shopify.git";
        ref = "master";
        rev = "6d0efe3ee2875eafc448dfaa4c2691410856cb4e";
      };
      "Shopify/homebrew-private" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-private.git";
        ref = "main";
        rev = "0ecb10b0ef8a6d698ecf25c8a14efc6b211bc73b";
      };
    };
  };

  homebrew = {
    brews = [
      "ejson"
      "clouddo-cli"
      "gmp"
      "libyaml"
      "openssl@3"
      "pkg-config"
    ];

    casks = [
      "fellow"
      "google-drive"
      "homerow"
      "rectangle"
      "podman-desktop"
    ];
  };
}
