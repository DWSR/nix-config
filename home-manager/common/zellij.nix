{ pkgs, ... }:
{
  programs.zellij = {
    enable = true;
    attachExistingSession = true;
    enableZshIntegration = true;

    settings = {
      pane_frames = false;
      theme = "nord";
      default_mode = "locked";
      copy_command = "pbcopy";
    };
  };
}
