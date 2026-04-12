_: {
  programs.nixvim.plugins.lsp.servers.lua_ls = {
    enable = true;
    autostart = false;

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
}
