{ pkgs, ... }:
let
  # TODO bump nixpkgs to get this back
  # ansiblelsPackage = pkgs.unstable.ansible-language-server;
in
{
  programs.nixvim.plugins.lsp.servers = {
    ansiblels = {
      enable = false;
      package = null;
      packageFallback = true;
      autostart = false;
    };

    jinja_lsp = {
      enable = true;
      package = pkgs.jinja-lsp;
      autostart = false;
    };
  };

  programs.nixvim.extraPlugins = [
    (
      pkgs.vimUtils.buildVimPlugin {
        name = "mfussenegger/nvim-ansible";

        src = pkgs.fetchFromGitHub {
          owner = "mfussenegger";
          repo = "nvim-ansible";
          rev = "bba61168b7aef735e7f950fdfece5ef6c388eacf";
          hash = "sha256-hhmhXV9qkZfjHnSBYZ05SX9QD4qBgW9Ob2k3VRfCDgs=";
        };
      }
    )
  ];

  # programs.nixvim.extraPackages = [ansiblelsPackage];
}
