{ pkgs, ... }:
{
  programs.nixvim = {
    plugins = {
      blink-cmp = {
        enable = true;
        package = pkgs.unstable.vimPlugins.blink-cmp;

        settings = {
          keymap.preset = "super-tab";

          completion = {
            documentation.auto_show = true;
            ghost_text.enabled = true;
            menu.draw.treesitter = [ "lsp" ];
          };

          signature.enabled = true;

          # Use native vim.snippet (Neovim 0.10+) — loads friendly-snippets directly
          snippets.preset = "default";

          sources = {
            default = [
              "lsp"
              "path"
              "snippets"
              "buffer"
              "calc"
            ];

            # conventionalcommits only in gitcommit buffers
            per_filetype = {
              gitcommit = [
                "conventionalcommits"
                "buffer"
                "path"
              ];
              # dap sources added dynamically when DAP session starts (see below)
              dap-repl = [
                "dap"
                "buffer"
              ];
              dap-hover = [
                "dap"
                "buffer"
              ];
            };

            providers = {
              conventionalcommits = {
                name = "conventionalcommits";
                module = "blink.compat.source";
              };
              calc = {
                name = "calc";
                module = "blink.compat.source";
              };
              dap = {
                name = "dap";
                module = "blink.compat.source";
              };
            };
          };

          cmdline.enabled = true;
        };
      };

      # Community snippet collection — loaded by blink's built-in snippet source
      friendly-snippets.enable = true;

      # nvim-cmp source compatibility layer for blink.cmp
      blink-compat = {
        enable = true;
        package = pkgs.unstable.vimPlugins.blink-compat;
        settings.impersonate_nvim_cmp = true;
      };

      # nvim-cmp source plugins — wrapped by blink.compat
      cmp-conventionalcommits.enable = true;
      cmp-calc.enable = true;
      cmp-dap.enable = true;
    };
  };
}
