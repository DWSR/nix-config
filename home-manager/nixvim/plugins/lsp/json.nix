_: {
  programs.nixvim.plugins.lsp.servers = {
    jqls = {
      enable = true;
      autostart = false;
    };

    jsonls = {
      enable = true;
      autostart = false;

      settings.json = {
        schemas.__raw = "require('schemastore').json.schemas()";
        validate.enable = true;
      };
    };
  };
}
