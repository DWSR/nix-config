_: {
  programs.nixvim.plugins.auto-save = {
    enable = true;
    autoLoad = true;

    settings = {
      enabled = true;
      # Guard against save loops with conform.nvim's format_on_save.
      # Skip saving buffers that are currently being formatted.
      condition = ''
        function(buf)
          if vim.b[buf].conform_formatting then return false end
          return true
        end
      '';
    };
  };
}
