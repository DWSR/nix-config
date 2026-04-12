_: {
  programs.nixvim.plugins.indent-blankline = {
    enable = true;

    settings = {
      scope = {
        enabled = true;

        # TODO Refer to this via nix rather than copypasta.
        highlight = [
          "RainbowDelimiterRed"
          "RainbowDelimiterYellow"
          "RainbowDelimiterBlue"
          "RainbowDelimiterOrange"
          "RainbowDelimiterGreen"
          "RainbowDelimiterViolet"
          "RainbowDelimiterCyan"
        ];
      };

      exclude = {
        buftypes = [
          "terminal"
          "nofile"
          "quickfix"
          "prompt"
        ];

        filetypes = [
          "help"
          "startify"
          "dashboard"
          "lazy"
          "neogitstatus"
          "NvimTree"
          "Trouble"
          "text"
          "lspinfo"
          "packer"
          "checkhealth"
          "help"
          "man"
          "gitcommit"
          "TelescopePrompt"
          "TelescopeResults"
          "''"
        ];
      };
    };
  };

  programs.nixvim.plugins.rainbow-delimiters = {
    enable = true;
  };
}
