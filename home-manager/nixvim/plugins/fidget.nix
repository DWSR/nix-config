_: {
  programs.nixvim.plugins.fidget = {
    enable = true;

    settings = {
      # Disable fidget's vim.notify override — noice → snacks handles notifications.
      # Fidget is only for LSP progress indication.
      notification.override_vim_notify = false;
    };
  };
}
