{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  imports = [
    ./lsp/ansible.nix
    ./lsp/bash.nix
    ./lsp/docker.nix
    ./lsp/go.nix
    ./lsp/json.nix
    ./lsp/markdown.nix
    ./lsp/nix.nix
    ./lsp/python.nix
    ./lsp/ruby.nix
    ./lsp/sql.nix
    # TODO Figure out why systemd_ls is not found.
    ./lsp/systemd.nix
    ./lsp/terraform.nix
    ./lsp/yaml.nix
  ];

  programs.nixvim = {
    plugins = {
      lsp = {
        enable = true;
        inlayHints = true;

        keymaps = {
          silent = true;
        };
      };

      lspkind = {
        enable = true;

        settings.preset = "default";
      };
    };

    autoGroups = {
      lsp_format_on_save = { clear = true; };
    };

    autoCmd = [
      {
        group = "lsp_format_on_save";
        pattern = "*";
        event = ["BufWritePre"];
        callback = helpers.mkRaw ''
          function()
            vim.lsp.buf.format({
              timeout_ms = 1000,
              async = true,
              filter = function(client)
                local filetype = vim.bo.filetype
                local n = require "null-ls"
                local s = require "null-ls.sources"
                local method = n.methods.FORMATTING
                local available_formatters = s.get_available(filetype, method)

                if #available_formatters > 0 then
                  return client.name == "null-ls"
                elseif client.supports_method "textDocument/formatting" then
                  return true
                else
                  return false
                end
              end,
            })
          end
        '';
      }
    ];
  };
}
