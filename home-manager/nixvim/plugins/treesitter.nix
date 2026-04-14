{ pkgs, ... }:
{
  programs.nixvim.plugins.treesitter = {
    enable = true;
    # NOTE: Plugin AND grammars must be from the same channel. The stable
    # nvim-treesitter plugin uses require("nvim-treesitter.configs") which
    # nixvim generates setup() calls for. The unstable version removed this
    # module. Keep both on stable.

    # Explicit grammar list matching configured languages (not allGrammars which installs 200+)
    grammarPackages = with pkgs.vimPlugins.nvim-treesitter.builtGrammars; [
      bash
      c
      cmake
      comment
      cpp
      css
      diff
      dockerfile
      git_rebase
      gitcommit
      go
      gomod
      gosum
      graphql
      hcl
      html
      ini
      javascript
      json
      json5
      lua
      make
      markdown
      markdown_inline
      nix
      python
      regex
      rst
      ruby
      rust
      terraform
      toml
      typescript
      vim
      vimdoc
      yaml
    ];

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
