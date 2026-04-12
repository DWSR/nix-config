{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim.plugins = {
    cmp = {
      enable = true;
      autoEnableSources = false;

      luaConfig.pre = ''
        cmp = require("cmp")
        cmp_mapping = require("cmp.config.mapping")
        cmp_window = require("cmp.config.window")
        cmp_mapping = require("cmp.config.mapping")
        cmp_types = require("cmp.types.cmp")

        has_words_before = function()
          local line, col = unpack(vim.api.nvim_win_get_cursor(0))
          return col ~= 0 and vim.api.nvim_buf_get_lines(0, line - 1, line, true)[1]:sub(col, col):match "%s" == nil
        end
      '';

      settings = {
        experimental = {
          ghost_text = false;
          native_menu = false;
        };

        formatting = {
          fields = [
            "kind"
            "abbr"
            "menu"
          ];
          max_width = 0;
          kind_icons = helpers.mkRaw "kind_icons";

          duplicates = {
            buffer = 1;
            path = 1;
            nvim_lsp = 0;
            luasnip = 1;
          };

          duplicates_default = 0;
        };

        window = {
          completion = helpers.mkRaw "cmp_window.bordered()";
          documentation = helpers.mkRaw "cmp_window.bordered()";
        };

        sources = [
          {
            name = "nvim_lsp";
            entry_filter = helpers.mkRaw ''
              function(entry, ctx)
                local kind = require("cmp.types.lsp").CompletionItemKind[entry:get_kind()]
                if kind == "Snippet" and ctx.prev_context.filetype == "java" then
                  return false
                end
                return true
              end
            '';
          }
          { name = "dap"; }
          { name = "async_path"; }
          { name = "treesitter"; }
          { name = "buffer"; }
          { name = "cmp_tabnine"; }
          { name = "nvim_lua"; }
          { name = "conventionalcommits"; }
          { name = "calc"; }
          { name = "emoji"; }
        ];

        mapping = helpers.mkRaw ''
          cmp_mapping.preset.insert({
            ["<C-k>"] = cmp_mapping(cmp_mapping.select_prev_item(), {"i", "c"}),
            ["<C-j>"] = cmp_mapping(cmp_mapping.select_next_item(), {"i", "c"}),
            ["<Down>"] = cmp_mapping(
              cmp_mapping.select_next_item({behavior = cmp_types.SelectBehavior.Select}),
              {"i", "c"}
            ),
            ["<Up>"] = cmp_mapping(
              cmp_mapping.select_prev_item({behavior = cmp_types.SelectBehavior.Select}),
              {"i", "c"}
            ),
            ["<C-d>"] = cmp_mapping.scroll_docs(-4),
            ["<C-f>"] = cmp_mapping.scroll_docs(4),
            ["<Tab>"] = cmp_mapping.select_next_item(),
            ["<S-Tab>"] = cmp_mapping.select_prev_item(),
            ["<C-e>"] = cmp_mapping.abort(),
            ["<C-Space>"] = cmp_mapping.complete(),
            ["<CR>"] = cmp_mapping.confirm({
              behavior = cmp_types.ConfirmBehavior.Replace,
              select = false,
            }),
            ["<C-h>"] = cmp_mapping(
              function(fallback)
                if cmp.visible() then
                  cmp.close()
                else
                  fallback()
                end
              end,
              {"i", "c"}
            ),
          })
        '';
      };
    };

    cmp-async-path.enable = true;
    cmp-buffer.enable = true;
    cmp-calc.enable = true;
    cmp-conventionalcommits.enable = true;
    cmp-dap.enable = true;
    cmp-nvim-lsp.enable = true;
  };
}
