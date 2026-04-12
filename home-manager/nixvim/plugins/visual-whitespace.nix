_: {
  programs.nixvim.plugins.visual-whitespace = {
    enable = true;

    settings = {

    };
  };

  programs.nixvim.keymaps = [
    {
      action = {
        __raw = ''require("visual-whitespace").toggle'';
      };

      key = "<leader>Vw";
      mode = [
        "n"
        "i"
      ];

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle whitespace display";
      };
    }
  ];
}
