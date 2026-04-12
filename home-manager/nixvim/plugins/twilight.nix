{ ... }:
{
  programs.nixvim.plugins.twilight = {
    enable = true;
  };

  programs.nixvim.keymaps = [
    {
      action = "<cmd>Twilight<cr>";
      key = "<leader>Vt";
      mode = [ "n" ];

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle scope focus (twilight)";
      };
    }
  ];
}
