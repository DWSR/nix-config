{ config, ... }:
{
  programs.nixvim = {
    plugins.treesitter = {
      enable = true;
      # NOTE: nvim-treesitter, its grammars, and nvim-treesitter-textobjects must
      # all come from the SAME channel. As of nixpkgs/nixvim 26.05 the default
      # `package` is the rewritten **main** branch, which no longer ships
      # `require("nvim-treesitter.configs")`. Nixvim therefore drives highlighting
      # and indentation through Neovim's native treesitter APIs and reads the
      # top-level `highlight`/`indent` options below — the legacy
      # `settings.highlight`/`settings.indent` tables are IGNORED on main (and
      # `settings.highlight.disable` emits a deprecation warning).
      #
      # Grammars are pulled from `package.builtGrammars` (not
      # `pkgs.vimPlugins.nvim-treesitter.*`) so they are guaranteed to match the
      # configured main-branch plugin's query files exactly. Pinning to
      # `nvim-treesitter-legacy` would silence the Nixvim warning but trips a
      # nixpkgs deprecation that becomes a hard error in 26.11.

      # Explicit grammar list matching configured languages (not allGrammars which installs 200+).
      # Trimmed to languages actually edited in this environment (dropped rst/ini/css/html —
      # not used for this user and each dropped grammar saves a C-compile step on fresh builds).
      grammarPackages = with config.programs.nixvim.plugins.treesitter.package.builtGrammars; [
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

      # Native (main-branch) treesitter highlighting. `disable` is a static list of
      # languages/filetypes matched against either the resolved language or the
      # buffer filetype:
      #   - "latex":   never treesitter-highlight LaTeX.
      #   - "bigfile": snacks.bigfile sets filetype=bigfile on large files, so this
      #                keeps treesitter off those buffers. (Replaces the previous
      #                `bigfile_disable_treesitter` buffer-var check, which was dead
      #                code — snacks never set that var; it sets the filetype.)
      highlight = {
        enable = true;
        disable = [
          "latex"
          "bigfile"
        ];
      };

      # Treesitter indentation is enabled per-filetype in extraConfigLuaPost below,
      # NOT here: the main branch exposes no native per-language indent-disable list,
      # and yaml/python must opt out (their treesitter indent is unreliable). Leaving
      # the native toggle off avoids the module installing an unconditional
      # indentexpr autocmd that we would then have to fight.
      indent.enable = false;
    };

    # Treesitter-based indentation for every filetype EXCEPT yaml/python, which keep
    # their built-in filetype indent. Mirrors the old
    # `indent = { enable = true; disable = [ "yaml" "python" ]; }` behaviour using the
    # main-branch `require'nvim-treesitter'.indentexpr()`. Registered in a dedicated
    # augroup from extraConfigLuaPost so it runs after the runtime filetype-indent
    # autocmds (treesitter wins for enabled filetypes; yaml/python retain native indent).
    extraConfigLuaPost = ''
      do
        local ts_indent_skip = { yaml = true, python = true }
        vim.api.nvim_create_autocmd("FileType", {
          group = vim.api.nvim_create_augroup("nixvim_treesitter_indent", { clear = true }),
          pattern = "*",
          callback = function(args)
            if not ts_indent_skip[vim.bo[args.buf].filetype] then
              vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
            end
          end,
        })
      end
    '';
  };
}
