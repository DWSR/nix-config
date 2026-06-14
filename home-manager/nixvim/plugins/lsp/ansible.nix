# TODO bump nixpkgs to get ansible-language-server back
{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    ansiblels = {
      enable = false;
      package = null;
      packageFallback = true;
    };

    jinja_lsp = {
      enable = true;
      package = pkgs.jinja-lsp;
    };
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.jinja_lsp.activate = false;

  programs.nixvim.extraPlugins = [
    (pkgs.vimUtils.buildVimPlugin {
      name = "mfussenegger/nvim-ansible";

      src = pkgs.fetchFromGitHub {
        owner = "mfussenegger";
        repo = "nvim-ansible";
        rev = "bba61168b7aef735e7f950fdfece5ef6c388eacf";
        hash = "sha256-hhmhXV9qkZfjHnSBYZ05SX9QD4qBgW9Ob2k3VRfCDgs=";
      };
    })
  ];

  # programs.nixvim.extraPackages = [ansiblelsPackage];
}
