_: {
  programs.nixvim.plugins.lsp.servers = {
    jqls.enable = true;

    jsonls = {
      enable = true;

      settings.json = {
        schemas.__raw = "require('schemastore').json.schemas()";
        validate.enable = true;
      };
    };
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers = {
    jqls.activate = false;
    jsonls.activate = false;
  };
}
