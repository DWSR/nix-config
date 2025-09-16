{ ... }:
{
  programs.nixvim.dependencies = {
    curl.enable = true;
  };

  programs.nixvim.plugins.devdocs = {
    enable = true;
  };

  programs.nixvim.keymaps = [
    {
      action = "<cmd>DevDocs install<CR>";
      key = "<leader>Di";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Install new docset";
      };
    }
    {
      action = "<cmd>DevDocs get<CR>";
      key = "<leader>Do";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Get docset";
      };
    }
    {
      action = "<cmd>DevDocs delete<CR>";
      key = "<leader>Dd";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Delete docset";
      };
    }
    {
      action = {
        __raw = ''
          function()
            local devdocs = require("devdocs")
            local installedDocs = devdocs.GetInstalledDocs()
            vim.ui.select(installedDocs, {}, function(selected)
              if not selected then
                return
              end

              local docDir = devdocs.GetDocDir(selected)
              require("snacks").picker.files({ cwd = docDir })
            end)
          end
        '';
      };
      key = "<leader>Dv";
      mode = "n";

      options = {
        silent = true;
        noremap = true;
        desc = "Browse docsets";
      };
    }
  ];

  programs.nixvim.plugins.which-key.settings.spec = [
    {
      __unkeyed = "<leader>D";
      group = "DevDocs";
      mode = ["n" "v"];
    }
  ];
}
