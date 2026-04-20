{ pkgs, ... }:
{
  programs.nixvim.plugins.treesitter = {
    enable = true;
    # NOTE: Plugin AND grammars must be from the same channel. The stable
    # nvim-treesitter plugin uses require("nvim-treesitter.configs") which
    # nixvim generates setup() calls for. The unstable version removed this
    # module. Keep both on stable.

    # Explicit grammar list matching configured languages (not allGrammars which installs 200+).
    # Trimmed to languages actually edited in this environment (dropped rst/ini/css/html —
    # not used for this user and each dropped grammar saves a C-compile step on fresh builds).
    grammarPackages = with pkgs.vimPlugins.nvim-treesitter.builtGrammars; [
      bash
      c
      cmake
      comment
      cpp
      diff
      dockerfile
      git_rebase
      gitcommit
      go
      gomod
      gosum
      graphql
      hcl
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
