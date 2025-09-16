{ inputs, pkgs, ...}:
{
  programs.atuin = {
    enable = true;

    daemon.enable = false;
    enableZshIntegration = true;

    settings = {
      db_path = "~/.local/share/atuin/history.db";
      key_path = "~/.local/share/atuin/key";
      session_path = "~/.local/share/atuin/session";
      dialect = "uk";
      update_check = false;
      search_mode = "fuzzy";
      style = "compact";
      keymap_mode = "vim-insert";
      exit_mode = "return-original";
    };
  };
}
