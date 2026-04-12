{ pkgs, ... }:
{
  programs.nixvim.plugins.treesitter = {
    enable = true;

    grammarPackages = pkgs.unstable.vimPlugins.nvim-treesitter.passthru.allGrammars;

    settings = {
      indent = {
        enable = true;

        disable = [
          "yaml"
          "python"
        ];
      };

      highlight = {
        enable = true;
        additional_vim_regex_highlighting = false;
        disable = {
          __raw = ''
            function(lang, buf)
              if vim.tbl_contains({ "latex" }, lang) then
                return true
              end

              local status_ok, big_file_detected = pcall(vim.api.nvim_buf_get_var, buf, "bigfile_disable_treesitter")
              return status_ok and big_file_detected
            end
          '';
        };
      };
    };
  };
}
