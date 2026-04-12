{
  inputs,
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

  nix-homebrew = {
    taps = {
      "Shopify/homebrew-shopify" = inputs.homebrew-shopify;
      "Shopify/homebrew-private" = inputs.homebrew-private;
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
