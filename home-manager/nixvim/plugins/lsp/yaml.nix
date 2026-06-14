_: {
  programs.nixvim.plugins.schemastore.enable = true;

  programs.nixvim.plugins.lsp.servers.yamlls = {
    enable = true;

    settings = {
      hover = true;
      completion = true;
      validate = true;
      # SchemaStore integration is handled by the schemastore plugin above.
      # Do NOT add manual schemaStore config here — it causes duplicate schemas.
    };
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.yamlls.activate = false;
}
