{ ... }:
{
  programs.nixvim.plugins.markdown-preview = {
    enable = true;

    settings = {
      auto_close = 1;
      auto_start = 0;
    };
  };

  programs.nixvim.keymaps = [
    {
      action = "<Plug>MarkdownPreview";
      key = "<leader>ms";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Start Markdown Preview";
      };
    }
    {
      action = "<Plug>MarkdownPreviewStop";
      key = "<leader>mc";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Stop Markdown Preview";
      };
    }
  ];

  programs.nixvim.plugins.which-key.settings.spec = [
    {
      __unkeyed = "<leader>m";
      group = "Markdown Preview";
      mode = "n";
    }
  ];
}
