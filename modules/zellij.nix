{ pkgs, ... }: {
  home-manager.users."brandonmcnama".programs.zellij = {
    enable = true;
    settings = {
      pane_frames = false;
      theme = "nord";
      default_mode = "locked";
      copy_command = "pbcopy";
    };
  };
}
