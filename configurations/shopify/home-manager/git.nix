{ ... }:
{
  programs.git = {
    includes = [ { path = "/Users/brandonmcnama/.config/dev/gitconfig"; } ];

    settings = {
      user.email = "brandon.mcnama@shopify.com";

      maintenance = {
        enable = true;
        # TODO Refer to home directory directly
        repositories = [ "/Users/brandonmcnama/world/trees/root/src" ];
      };
    };

    signing.key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIavhvh92uJLrqVXddjkTUNl1CTiqjxF03ADvjd0OFr2";
  };
}
