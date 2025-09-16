{ inputs, pkgs, ... }:
{
  programs.nixvim = {
    extraPlugins = [
      # TODO Parameterize this for the target system
      inputs.mcphub-nvim.packages."aarch64-darwin".default
    ];

    extraConfigLua = ''
      require("mcphub").setup({
        cmd = "${inputs.mcphub.packages."aarch64-darwin".default}/bin/mcp-hub"
      })
    '';
  };
}
