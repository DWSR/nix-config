{
  outputs,
  username,
  ...
}:
{
  imports = [
    ../common-darwin
  ];

  nix = {
    enable = true;

    envVars = {
      AWS_SHARED_CREDENTIALS_FILE = "/etc/nix/aws/credentials";
    };

    extraOptions = ''
      !include nix.conf.d/shopify.conf
    '';
  };

  nixpkgs.overlays = [
    outputs.overlays.shopify-packages
  ];

  home-manager.users.${username} = import ./home-manager;

  # Private Shopify taps use builtins.fetchGit intentionally.
  # They cannot be flake inputs because nix flake update would fail
  # on machines without Shopify GitHub credentials.
  nix-homebrew = {
    taps = {
      "Shopify/homebrew-shopify" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-shopify.git";
        ref = "master";
        rev = "cb46ff1dae4daa284f29a5dc4948e3bb8dd71940";
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
