{ pkgs, ... }:
{
  programs.nixvim = {
    plugins.codecompanion = {
      enable = true;
      package = pkgs.unstable.vimPlugins.codecompanion-nvim;

      lazyLoad.settings = {
        cmd = [
          "CodeCompanion"
          "CodeCompanionChat"
          "CodeCompanionActions"
          "CodeCompanionCmd"
        ];
      };
      settings = {
        display = {
          action_palette = {
            provider = "snacks";
          };
          chat = {
            window = {
              layout = "vertical";
              width = 0.3;
            };
          };
        };
        interactions = {
          chat = {
            adapter = "opencode";
          };
        };
      };
    };

    keymaps = [
      {
        mode = "n";
        key = "<leader>ac";
        action = "<cmd>CodeCompanionChat Toggle<CR>";
        options = {
          desc = "Toggle CodeCompanion chat";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "n";
        key = "<leader>aa";
        action = "<cmd>CodeCompanionActions<CR>";
        options = {
          desc = "Open CodeCompanion actions palette";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "v";
        key = "<leader>ae";
        action = "<cmd>CodeCompanion /explain<CR>";
        options = {
          desc = "Explain selected code";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "v";
        key = "<leader>af";
        action = "<cmd>CodeCompanion /fix<CR>";
        options = {
          desc = "Fix selected code";
          noremap = true;
          silent = true;
        };
      }
    ];
  };
}
