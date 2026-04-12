_: {
  programs.nixvim.plugins.notify = {
    enable = true;

    settings = {
      background_colour = "#000000";
      fps = 60;
      render = "wrapped-default";
      timeout = 3500;
    };
  };
}
