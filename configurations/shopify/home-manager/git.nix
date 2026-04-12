{ config, ... }:
{
  programs.git = {
    includes = [ { path = "${config.home.homeDirectory}/.config/dev/gitconfig"; } ];

    settings = {
      user.email = "brandon.mcnama@shopify.com";

      maintenance = {
        enable = true;
        repositories = [ "${config.home.homeDirectory}/world/trees/root/src" ];
      };
    };

    signing.key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIavhvh92uJLrqVXddjkTUNl1CTiqjxF03ADvjd0OFr2";
  };
}
