{ ... }:
{
  programs.nixvim.plugins.neoscroll = {
    enable = true;

    settings = {
      hide_cursor = true;
      stop_eof = true;
      respect_scrolloff = true;
      cursor_scrolls_alone = false;
    };
  };
}
