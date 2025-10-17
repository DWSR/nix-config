{ config, ... }:
let
  helpers = config.lib.nixvim;
  mcphub = config.lib.nixvim.mkRaw ''{mcphub_lualine_status, color=mcphub_lualine_colour}'';
in
{
  programs.nixvim.plugins.lualine = {
    enable = true;

    settings = {
      inactive_sections = {
        lualine_a = [];
        lualine_b = [];
        lualine_c = ["filename"];
        lualine_x = ["location"];
        lualine_y = [];
        lualine_z = [];
      };
      sections = {
        lualine_a = ["mode"];
        lualine_b = ["branch"];
        lualine_c = ["filename"];
        lualine_x = ["encoding" mcphub "filetype"];
        lualine_y = ["progress"];
        lualine_z = ["location"];
      };
    };
  };
}
