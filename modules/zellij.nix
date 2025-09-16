{ pkgs, ... }: {
  home-manager.users."brandonmcnama".programs.zellij = {
    enable = true;
    settings = {
      # Breaks being able to move the window with Moom.
      pane_frames = true;
      theme = "nord";
      default_mode = "locked";
      copy_command = "pbcopy";
    };
  };
}
