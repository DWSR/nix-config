{ ... }:
{
  imports = [
    ./lsp/ansible.nix
    ./lsp/bash.nix
    ./lsp/docker.nix
    ./lsp/go.nix
    ./lsp/json.nix
    ./lsp/markdown.nix
    ./lsp/python.nix
    ./lsp/ruby.nix
    ./lsp/sql.nix
    # TODO Figure out why systemd_ls is not found.
    ./lsp/systemd.nix
    ./lsp/terraform.nix
    ./lsp/yaml.nix
  ];

  programs.nixvim.plugins.lsp = {
    enable = true;
    inlayHints = true;

    keymaps = {
      silent = true;
    };
  };

  # programs.nixvim.plugins.lspconfig = {
  #   enable = true;
  # };

  programs.nixvim.autoCmd = [
    # {
    #   group = "lsp_format_on_save";
    #   pattern = "*";
    #   event = ["BufWritePre"];
    #   callback = {
    #     __raw = ''
    #       function()
    #         vim.lsp.buf.format({
    #           timeout_ms = 1000,
    #           filter = 
    #         })
    #     end
    #     '';
    #   };
    # }
  ];
}
