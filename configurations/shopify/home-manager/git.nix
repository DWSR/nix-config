{ config, lib, ... }:
{
  programs.git = {
    includes = [ { path = "${config.home.homeDirectory}/.config/dev/gitconfig"; } ];

    settings = {
      user.email = "brandon.mcnama@shopify.com";

      credential."https://*.quick.shopify.io".helper = [
        ""
        "${config.home.homeDirectory}/.config/quick/quick-git-credential.sh"
      ];

      http."https://*.quick.shopify.io/".extraHeader = "X-Requested-With: XMLHttpRequest";

      maintenance = {
        enable = true;
        repositories = [ "${config.home.homeDirectory}/world/trees/root/src" ];
      };
    };

    signing.key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIavhvh92uJLrqVXddjkTUNl1CTiqjxF03ADvjd0OFr2";
  };

  # Home Manager appends programs.git.includes with mkAfter (order 1500).
  # Use a later order so Shopify's dev gitconfig cannot override fsmonitor.
  xdg.configFile."git/config".text = lib.mkIf config.programs.git.enable (
    lib.mkOrder 2000 "[core]\n\tfsmonitor = false\n"
  );
}
