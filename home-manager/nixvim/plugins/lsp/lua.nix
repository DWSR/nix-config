_: {
  programs.nixvim.plugins.lsp.servers.lua_ls = {
    enable = true;

    settings.Lua = {
      runtime.version = "LuaJIT";
      diagnostics.globals = [ "vim" ];
      workspace = {
        library.__raw = "vim.api.nvim_get_runtime_file('', true)";
        checkThirdParty = false;
      };
      telemetry.enable = false;
    };
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.lua_ls.activate = false;
}
