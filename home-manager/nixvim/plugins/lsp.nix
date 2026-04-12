{ pkgs, ... }:
{
  imports = [
    ./lsp/ansible.nix
    ./lsp/bash.nix
    ./lsp/docker.nix
    ./lsp/go.nix
    ./lsp/graphql.nix
    ./lsp/json.nix
    ./lsp/lua.nix
    ./lsp/markdown.nix
    ./lsp/nix.nix
    ./lsp/python.nix
    ./lsp/ruby.nix
    # TODO Figure out why systemd_ls is not found.
    ./lsp/systemd.nix
    ./lsp/terraform.nix
    ./lsp/yaml.nix
  ];

  programs.nixvim = {
    plugins = {
      lsp = {
        enable = true;
        package = pkgs.unstable.vimPlugins.nvim-lspconfig;
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

  };
}
