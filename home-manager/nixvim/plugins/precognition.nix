_: {
  programs.nixvim = {
    plugins.precognition.enable = true;

    keymaps = [
      {
        action = ":Precognition toggle";
        key = "<leader>Vp";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Toggle motion hints";
        };
      }
    ];
  };
}
