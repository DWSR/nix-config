{ pkgs, home-manager, ... }: {
  home-manager.users."brandonmcnama".programs.gh = {
    enable = true;
    gitCredentialHelper.enable = true;

    settings = {
      aliases = {
        pr = "pr list --limit 10";
        issue = "issue list --limit 10";
        repo = "repo list --limit 10";
        co = "pr checkout";
      };

      git_protocol = "ssh";
    };
  };

  home-manager.users."brandonmcnama".programs.gh-dash.enable = true;
}

