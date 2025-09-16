{inputs, username, ... }: {
  imports = [ inputs.home-manager.darwinModules.home-manager ];

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;

    users."brandonmcnama" = {
      xdg.enable = true;

      home = {
        # TODO: Remove this once 25.05 is released
        enableNixpkgsReleaseCheck = false;
        preferXdgDirectories = true;
        stateVersion = "24.11";

        sessionPath = [
          "$HOME/.local/bin"
          "$HOME/bin"
          "$HOME/go/bin"
        ];

        sessionVariables = {
          DO_NOT_TRACK = "1";
          GOPATH = "$HOME/go:$HOME/repos";
          OBJC_DISABLE_INITIALIZE_FORK_SAFETY = "YES";
          KUBECTL_EXTERNAL_DIFF = "dyff between --omit-header --set-exit-code";
        };
      };
    };
  };
}
