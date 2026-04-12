_: {
  programs.nixvim.plugins.gitblame = {
    enable = true;

    settings = {
      enabled = true;

      clear_event = "CursorHoldI";
      clipboard_registry = "unnamedplus";
    };
  };
}
