_: {
  programs.nixvim.plugins.mini = {
    enable = true;

    modules.surround = {
      # Default keybindings:
      # sa — add surrounding (e.g., saiw" adds " around inner word)
      # sd — delete surrounding (e.g., sd" deletes surrounding quotes)
      # sr — replace surrounding (e.g., sr"' replaces " with ')
      # sf — find surrounding (move to next)
      # sF — find surrounding (move to previous)
      # sh — highlight surrounding
      # sn — update n_lines for surrounding search
    };
  };
}
