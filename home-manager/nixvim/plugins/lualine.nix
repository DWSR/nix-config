{ config, ... }:
let
  helpers = config.lib.nixvim;
  mcphub = helpers.mkRaw "{mcphub_lualine_status, color=mcphub_lualine_colour}";
  navic = helpers.mkRaw ''
    {
      function()
        local ok, nav = pcall(require, "nvim-navic")
        if ok and nav.is_available() then
          return nav.get_location()
        end
        return ""
      end,
      cond = function()
        local ok, nav = pcall(require, "nvim-navic")
        return ok and nav.is_available()
      end,
    }
  '';
in
{
  programs.nixvim.plugins.lualine = {
    enable = true;

    settings = {
      inactive_sections = {
        lualine_a = [ ];
        lualine_b = [ ];
        lualine_c = [ "filename" ];
        lualine_x = [ "location" ];
        lualine_y = [ ];
        lualine_z = [ ];
      };
      sections = {
        lualine_a = [ "mode" ];
        lualine_b = [ "branch" ];
        lualine_c = [
          "filename"
          navic
        ];
        lualine_x = [
          "encoding"
          mcphub
          "filetype"
        ];
        lualine_y = [ "progress" ];
        lualine_z = [ "location" ];
      };
    };
  };
}
