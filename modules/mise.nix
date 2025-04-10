{ pkgs, home-manager, ... }: {
  home-manager.users."brandonmcnama".programs.mise = {
    enable = true;

    globalConfig = {
      tools = {
        go = "1.24.0";
        golangci-lint = "1.64.6";
        helm = "3.17.1";
      };

      settings = {
        activate_aggressive = true;
        experimental = true;
      };
    };
  };
}
