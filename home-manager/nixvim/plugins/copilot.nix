{ ... }:
{
  programs.nixvim.plugins = {
    # cmp.settings.sources = lib.mkAfter [
    #   {
    #     name = "copilot";
    #     max_item_count = 3;
    #     trigger_characters = [
    #       "."
    #       ":"
    #       "("
    #       "'"
    #       "\""
    #       "["
    #       ""
    #       "#"
    #       "*"
    #       "@"
    #       "|"
    #       "="
    #       "-"
    #       "{"
    #       "/"
    #       "\\"
    #       "+"
    #       "?"
    #       " "
    #     ];
    #   }
    # ];
    copilot-cmp.enable = false;

    copilot-lua = {
      enable = true;

      settings = {
        suggestion = {
          enabled = false;

          keymap = {
            accept = "<c-l>";
            next = "<c-j>";
            prev = "<c-k>";
            dismiss = "<c-h>";
          };
        };

        panel.enabled = false;

        filetypes."*" = true;

        logger = {
          print_log_level = {
            __raw = "vim.log.levels.OFF";
          };
        };
      };
    };
  };

  # programs.nixvim.keymaps = [
  #   {
  #     action = "<cmd>lua require('copilot.suggestion').toggle_auto_trigger()<CR>";
  #     key = "<C-s>";
  #     mode = "n";

  #     options = {
  #       silent = true;
  #       noremap = true;
  #       desc = "Toggle Copilot automatic triggers";
  #     };
  #   }
  # ];

  # programs.nixvim.autoCmd = [
  #   {
  #     event = "InsertEnter";
  #     pattern = "*";
  #     command = "Copilot";
  #     desc = "Enable Copilot on InsertEnter";
  #   }
  # ];
}
