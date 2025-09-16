{ ... }:
{
  programs.nixvim.plugins.actions-preview = {
    enable = true;

    settings = {
      highlight_command = [
        {
          __raw = ''
            require('actions-preview.highlight').delta()
          '';
        }
      ];

      telescope = {
        layout_config = {
          height = 0.9;
          preview_cutoff = 20;
          preview_height = {
            __raw = ''
              function(_, _, max_lines)
                return max_lines - 15
              end
            '';
          };
          prompt_position = "top";
          width = 0.8;
        };
        layout_strategy = "vertical";
        sorting_strategy = "ascending";
      };
    };
  };
}
