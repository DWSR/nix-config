_: {
  programs.nixvim.plugins.smear-cursor = {
    enable = true;

    settings = {
      smear_between_buffers = true;
      smear_between_neighbor_lines = true;
      scroll_buffer_space = true;
      legacy_computing_symbols_support = true;
      smear_insert_mode = true;
    };
  };
}
