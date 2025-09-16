{...}: {
  programs.nixvim.plugins.auto-save = {
    enable = true;
    autoLoad = true;

    settings = {
      enabled = true;
    };
  };
}
