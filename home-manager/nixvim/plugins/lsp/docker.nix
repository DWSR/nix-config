_: {
  programs.nixvim.plugins.lsp.servers = {
    dockerls = {
      enable = true;
      autostart = false;
    };

    docker_compose_language_service = {
      enable = true;
      autostart = false;
    };
  };
}
