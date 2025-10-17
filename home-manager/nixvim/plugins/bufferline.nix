{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim.plugins.bufferline = {
    enable = false;

    settings = {
      highlights = {
        background.italic = true;
        buffer_selected.bold = true;
      };

      options = {
        themable = true;
        get_element_icon = null;
        show_duplicate_prefix = true;
        duplicates_across_groups = true;
        auto_toggle_bufferline = true;
        move_wraps_at_ends = true;

        # groups = {
        #   # items = [];

        #   options.toggle_hidden_on_enter = true;
        # };

        mode = "buffers";
        numbers = "none";
        close_command = helpers.mkRaw ''function(bufnr) buf_kill("bd", bufnr, false) end'';

        right_mouse_command = "vert sbuffer %d";
        left_mouse_command = "buffer %d";
        middle_mouse_command = null;

        indicator = {
          style = "icon";
          icon = "▎";
        };

        buffer_close_icon = "󰅖";
        modified_icon = " ";
        close_icon = "";
        left_trunc_marker = "";
        right_trunc_marker = "";

        name_formatter = helpers.mkRaw ''
          function(buf)
            if buf.name:match "%.md" then
              return vim.fn.fnamemodify(buf.name, ":t:r")
            end
          end
        '';

        max_name_length = 18;
        max_prefix_length = 15;
        truncate_names = true;
        tab_size = 18;
        diagnostics = "nvim_lsp";
        diagnostics_update_in_insert = false;

        diagnostics_indicator = helpers.mkRaw ''
          function(num, _, diagnostics, _)
            local result = {}
            local symbols = {
              error = "",
              warning = "",
              info = "",
            }
            for name, count in pairs(diagnostics) do
              if symbols[name] and count > 0 then
                table.insert(result, symbols[name] .. " " .. count)
              end
            end
            result = table.concat(result, " ")
            return #result > 0 and result or ""
          end
        '';

        custom_filter = helpers.mkRaw ''
          function(buf, buf_nums)
            local logs = vim.tbl_filter(function(b)
              return vim.bo[b].filetype == "log"
            end, buf_nums or {})
            if vim.tbl_isempty(logs) then
              return true
            end
            local tab_num = vim.fn.tabpagenr()
            local last_tab = vim.fn.tabpagenr "$"
            local is_log = vim.bo[b].filetype == "log"
            if last_tab == 1 then
              return true
            end
            -- only show log buffers in secondary tabs
            return (tab_num == last_tab and is_log) or (tab_num ~= last_tab and not is_log)
          end
        '';

        offsets = [
          {
            filetype = "undotree";
            text = "Undotree";
            highlight = "PanelHeading";
            padding = 1;
          }
          {
            filetype = "Trouble";
            text = "Diagnostics";
            highlight = "PanelHeading";
            padding = 1;
          }
          {
            filetype = "Outline";
            text = "Symbols";
            highlight = "PanelHeading";
            padding = 1;
          }
          {
            filetype = "NvimTree";
            text = "File Explorer";
            highlight = "PanelHeading";
            padding = 1;
          }
          {
            filetype = "neo-tree";
            text = "File Explorer";
            highlight = "PanelHeading";
            padding = 1;
          }
        ];

        color_icons = true;
        show_buffer_icons = true;
        show_buffer_close_icons = true;
        show_close_icon = false;
        show_tab_indicators = true;
        persist_buffer_sort = true;
        separator_style = "thin";
        enforce_regular_tabs = false;
        always_show_bufferline = false;

        hover = {
          enabled = false;
          delay = 200;
          reveal = [ "close" ];
        };

        sort_by = "id";

        debug = {
          logging = false;
        };
      };
    };
  };
}
