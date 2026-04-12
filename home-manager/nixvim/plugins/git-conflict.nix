_: {
  programs.nixvim.plugins.git-conflict = {
    enable = true;

    settings = {
      default_commands = true;
      default_mappings = true;
      disable_diagnostics = true;
      list_opener = "copen";

      highlights = {
        incoming = "DiffAdd";
        current = "DiffText";
      };
    };
  };
}
