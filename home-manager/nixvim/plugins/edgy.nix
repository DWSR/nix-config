{ ... }:
{
  programs.nixvim = {
    opts.splitkeep = "screen";

    plugins.edgy = {
      enable = true;
    };
  };
}
