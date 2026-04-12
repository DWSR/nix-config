{ ... }:
{
  programs.git = {
    enable = true;

    settings = {
      user.name = "Brandon McNama";

      aliases = {
        yolo = "!git add -A && git commit -m \"wip\" && git push";
        ignore = "!gi() { curl -sL https://www.toptal.com/developers/gitignore/api/$@ ;}; gi";
        roast = "blame";
        wip = "commit -m wip --no-verify";
        lol = "log --graph --oneline --decorate";
      };

      push.autoRemoteSetup = true;
      commit.gpgSign = true;
      branch.sort = "-committerdate";
      init.defaultBranch = "main";
      rebase.updateRefs = true;
      pull.rebase = true;
      help.autocorrect = 1;
    };

    lfs.enable = true;

    signing = {
      format = "ssh";
      signByDefault = true;
      signer = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
    };
  };

  programs.delta = {
    enable = true;
    enableGitIntegration = true;

    options = {
      dark = true;
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
}
