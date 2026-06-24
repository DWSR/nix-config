{ config, ... }:
let
  c = config.lib.stylix.colors.withHashtag;
in
{
  # Provide fallback definitions for the rainbow-delimiters highlight groups so
  # indent-blankline's scope.highlight (below) can reference them at ibl.setup()
  # time. The removed nord.nvim colorscheme defined these groups early (in the
  # colorscheme applied before plugin setups); base16-nvim does not, and
  # rainbow-delimiters only defines them from a plugin/ script that loads AFTER
  # ibl.setup(), so without this ibl.setup() aborts with
  # "E5113: No highlight group 'RainbowDelimiterRed' found" (a startup
  # hit-enter prompt). extraConfigLuaPre runs after the colorscheme and before
  # plugin setups, so these exist when ibl.setup() reads them. They use
  # `default = true` and Stylix palette colors: rainbow-delimiters' own
  # (non-default) highlights still win at runtime, preserving the prior
  # appearance; this is purely a crash-preventing fallback. The ColorScheme
  # autocmd keeps the fallback present across runtime colorscheme reloads.
  programs.nixvim.extraConfigLuaPre = ''
    do
      local rainbow = {
        RainbowDelimiterRed = "${c.base08}",
        RainbowDelimiterYellow = "${c.base0A}",
        RainbowDelimiterBlue = "${c.base0D}",
        RainbowDelimiterOrange = "${c.base09}",
        RainbowDelimiterGreen = "${c.base0B}",
        RainbowDelimiterViolet = "${c.base0E}",
        RainbowDelimiterCyan = "${c.base0C}",
      }
      local function apply()
        for group, fg in pairs(rainbow) do
          vim.api.nvim_set_hl(0, group, { fg = fg, default = true })
        end
      end
      apply()
      vim.api.nvim_create_autocmd("ColorScheme", { callback = apply })
    end
  '';

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
          ""
        ];
      };
    };
  };

  programs.nixvim.plugins.rainbow-delimiters = {
    enable = true;
  };
}
