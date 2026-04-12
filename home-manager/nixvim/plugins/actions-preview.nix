_: {
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

      # Use snacks/nui backends (telescope was removed from config)
      backend = [
        "snacks"
        "nui"
      ];
    };
  };
}
