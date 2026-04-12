{ ... }:
{
  programs.nixvim.plugins.luasnip = {
    enable = true;
  };

  programs.nixvim.plugins.cmp_luasnip.enable = true;
}
