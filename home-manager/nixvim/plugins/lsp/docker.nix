_: {
  programs.nixvim.plugins.lsp.servers = {
    dockerls.enable = true;
    docker_compose_language_service.enable = true;
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers = {
    dockerls.activate = false;
    docker_compose_language_service.activate = false;
  };
}
