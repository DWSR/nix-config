{ pkgs, ... }:
{
  programs.nixvim.extraPlugins = [
    (
      pkgs.vimUtils.buildVimPlugin {
        name = "vim-lastplace";

        src = pkgs.fetchFromGitHub {
          owner = "farmergreg";
          repo = "vim-lastplace";
          rev = "v4.5.0";
          hash = "sha256-8IXr4fUotWXOH2DLXIZq9il/uRxY8Hxi4z1z9zVqGLk=";
        };
      }
    )
  ];
}
