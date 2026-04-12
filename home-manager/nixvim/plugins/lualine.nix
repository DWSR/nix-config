{
  config,
  pkgs,
  ...
}:
let
  helpers = config.lib.nixvim;
  mcphub = helpers.mkRaw "{mcphub_lualine_status, color=mcphub_lualine_colour}";
in
{
  programs.nixvim.plugins.lualine = {
    enable = true;
    package = pkgs.unstable.vimPlugins.lualine-nvim;

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
          # navic breadcrumbs — shows code context when LSP provides documentSymbol
          "navic"
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
