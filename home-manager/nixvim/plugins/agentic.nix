{ pkgs, config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    # agentic.nvim is not yet in nixpkgs vimPlugins nor NixNeovimPlugins, so
    # build it from a pinned upstream commit (same pattern as direnv.nix /
    # nvim-ansible). Pure-Lua plugin, no build step.
    extraPlugins = [
      (pkgs.vimUtils.buildVimPlugin {
        name = "agentic-nvim";

        src = pkgs.fetchFromGitHub {
          owner = "carlos-algms";
          repo = "agentic.nvim";
          rev = "ca7700bdcf57f6079833574d924c99f0d3dbc4b9";
          hash = "sha256-OqcLWbyBafWFtmrDXMGIlp4hm/sELDa66tr2plRtmu8=";
        };

        # Check only the main entrypoint instead of discovery mode. The plugin
        # ships co-located unit tests named `foo.test.lua`; nixpkgs'
        # neovim-require-check maps those to module `foo.test` (foo/test.lua),
        # which never resolves, so discovery-mode checks fail on dev-only
        # tests. `require("agentic")` is the module we actually load.
        nvimRequireCheck = "agentic";
      })
    ];

    # ACP-only chat UI and this config's sole AI chat plugin. Uses the OpenCode
    # provider (spawns `opencode acp` over stdio); opencode is already on PATH
    # via the opencode HM module.
    extraConfigLua = ''
      require("agentic").setup({
        provider = "opencode-acp",
        windows = {
          position = "right",
          width = "30%",
        },
      })
    '';

    # Bindings live directly under the <leader>a (AI) which-key group.
    keymaps = [
      {
        mode = [
          "n"
          "v"
        ];
        key = "<leader>aa";
        action = helpers.mkRaw "function() require('agentic').toggle() end";
        options = {
          desc = "Toggle Agentic chat";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "n";
        key = "<leader>an";
        action = helpers.mkRaw "function() require('agentic').new_session() end";
        options = {
          desc = "New Agentic session";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = [
          "n"
          "v"
        ];
        key = "<leader>ac";
        action = helpers.mkRaw "function() require('agentic').add_selection_or_file_to_context() end";
        options = {
          desc = "Add file/selection to Agentic context";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "n";
        key = "<leader>ar";
        action = helpers.mkRaw "function() require('agentic').restore_session() end";
        options = {
          desc = "Restore Agentic session";
          noremap = true;
          silent = true;
        };
      }
    ];
  };
}
