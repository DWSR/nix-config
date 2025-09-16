{ ... }:
{
  programs.nixvim.plugins.which-key = {
    enable = true;

    settings = {
      delay = 300;
      preset = "helix";

      plugins = {
        marks = true;
        registers = true;
      };

      spec = [
        {
          __unkeyed = "<leader>V";
          group = "Display toggles";
          mode = ["n" "v"];
        }
      ];
    };
  };
}
