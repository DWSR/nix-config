{
  inputs,
  outputs,
  pkgs,
  config,
  ...
}:
{
  programs.git = {
    enable = true;

    aliases = {
      yolo = "!git add -A && git commit -m \"wip\" && git push";
      ignore = "!gi() { curl -sL https://www.toptal.com/developers/gitignore/api/$@ ;}; gi";
      roast = "blame";
      wip = "commit -m wip --no-verify";
      lol = "log --graph --oneline --decorate";
    };

    extraConfig = {
      push.autoRemoteSetup = true;
      commit.gpgSign = true;
      branch.sort = "-comitterdate";
      init.defaultBranch = "main";
      rebase.updateRefs = true;
      pull.rebase = true;
      help.autocorrect = 1;
    };

    delta = {
      enable = true;
      options = {
        features = "decorations";
        interactive.keep-plus-minus-markers = false;
        decorations = {
          commit-decoration-style = "blue ol";
          commit-style = "raw";
          file-style = "omit";
          hunk-header-decoration-style = "blue box";
          hunk-header-file-style = "red";
          hunk-header-line-number-style = "#067a00";
          hunk-header-style = "file line-number syntax";
        };
      };
    };

    lfs.enable = true;

    maintenance = {
      enable = true;
      # TODO Refer to home directory directly
      repositories = ["/Users/brandonmcnama/world/trees/root/src"];
    };

    signing = {
      format = "ssh";
      signByDefault = true;
      signer = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIavhvh92uJLrqVXddjkTUNl1CTiqjxF03ADvjd0OFr2";
    };

    userName = "Brandon McNama";
    userEmail = "brandon.mcnama@shopify.com";

    # TODO Refer to XDG_CONFIG_HOME directly
    includes = [{path = "/Users/brandonmcnama/.config/dev/gitconfig";}];
  };
}
