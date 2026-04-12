_: {
  programs.nixvim.plugins.conform-nvim = {
    enable = true;

    settings = {
      format_on_save = {
        timeout_ms = 500;
        lsp_format = "fallback";
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
}
