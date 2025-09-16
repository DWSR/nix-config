{ ... }:
{
  programs.nixvim.plugins.ts-context-commentstring = {
    enable = true;
    
    extraOptions = {
      enable_autocmd = false;
      config = {
        # Languages that have a single comment style
        typescript = ''// %s'';
        css = ''/* %s */'';
        scss = ''/* %s */'';
        html = ''<!-- %s -->'';
        svelte = ''<!-- %s -->'';
        vue = ''<!-- %s -->'';
        json = '''';
      };
    };
  };

  programs.nixvim.plugins.comment = {
    enable = true;

    settings.pre_hook = ''
      function(...)
        local loaded, ts_comment = pcall(require, "ts_context_commentstring.integrations.comment_nvim")
        if loaded and ts_comment then
          return ts_comment.create_pre_hook()(...)
        end
      end
    '';
  };

  programs.nixvim.keymaps = [
    {
      action = "<Plug>(comment_toggle_linewise_current)";
      key = "<leader>/";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle line comment";
      };
    }
    {
      action = "<Plug>(comment_toggle_linewise_visual)";
      key = "<leader>/";
      mode = "v";

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle line comment";
      };
    }
    {
      action = "<Plug>(comment_toggle_blockwise_current)";
      key = "<leader><C-/>";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle block comment";
      };
    }
    {
      action = "<Plug>(comment_toggle_blockwise_visual)";
      key = "<leader><C-/>";
      mode = "v";

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle block comment";
      };
    }
  ];
}
