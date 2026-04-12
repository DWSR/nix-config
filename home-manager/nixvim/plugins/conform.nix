_: {
  programs.nixvim = {
    plugins.conform-nvim = {
      enable = true;

      settings = {
        format_on_save = {
          __raw = ''
            function(bufnr)
              if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
                return
              end
              return { timeout_ms = 500, lsp_format = "fallback" }
            end
          '';
        };

        default_format_opts.lsp_format = "fallback";
        notify_on_error = true;
        notify_no_formatters = false;

        formatters_by_ft = {
          nix = [ "nixfmt" ];
          lua = [ "stylua" ];
          python = [
            "ruff_organize_imports"
            "ruff_format"
          ];
          ruby = [ "rubocop" ];
          go = [
            "goimports"
            "gofumpt"
          ];
          bash = [ "shfmt" ];
          sh = [ "shfmt" ];
          yaml = [ "yamlfmt" ];
          json = [ "jq" ];
          jsonc = [ ];
          terraform = [ "terraform_fmt" ];
          "terraform-vars" = [ "terraform_fmt" ];
          hcl = [ "terraform_fmt" ];
          markdown = [ "prettier" ];
          "_" = [
            "trim_whitespace"
            "trim_newlines"
          ];
        };
      };
    };

    userCommands = {
      FormatToggle = {
        command.__raw = ''
          function()
            vim.g.disable_autoformat = not vim.g.disable_autoformat
            if vim.g.disable_autoformat then
              vim.notify("Format-on-save disabled", vim.log.levels.WARN)
            else
              vim.notify("Format-on-save enabled", vim.log.levels.INFO)
            end
          end
        '';
        desc = "Toggle format-on-save globally";
      };
    };
  };
}
