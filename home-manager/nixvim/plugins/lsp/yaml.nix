{ ... }:
{
  programs.nixvim.plugins.schemastore.enable = true;

  programs.nixvim.plugins.lsp.servers = {
    yamlls = {
      enable = true;
      autostart = false;

      settings = {
        hover = true;
        completion = true;
        validate = true;
        schemaStore = {
          enable = true;
          url = "https://www.schemastore.org/api/json/catalog.json";
        };
      };
    };
  };
}
