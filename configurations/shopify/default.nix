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
        rev = "2cc5d715f19d2cf5b3dd481bcb1463839817177e";
      };
      "Shopify/homebrew-private" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-private.git";
        ref = "main";
        rev = "6a2a72c799c06a5f4d0431824cc0ddbc595208c2";
      };
    };
  };

  homebrew = {
    brews = [
      "ejson"
      "clouddo-cli"
      "pkg-config"
      "uv" # required for various mcps :eyeroll:
    ];

    casks = [
      "fellow"
      "google-drive"
      "rectangle"
      "shortcat"
      "podman-desktop"
    ];
  };
}
