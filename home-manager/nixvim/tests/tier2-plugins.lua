-- Tier 2: Plugin load assertions
-- Verifies that expected plugins are loaded and removed plugins are absent.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- Plugins that SHOULD be loaded
T.check_plugin_loaded("gitsigns")
T.check_plugin_loaded("conform")
T.check_plugin_loaded("todo-comments")
T.check_plugin_loaded("fidget")
T.check_plugin_loaded("render-markdown")
T.check_plugin_loaded("nvim-treesitter")
T.check_plugin_loaded("noice")
T.check_plugin_loaded("snacks")
T.check_plugin_loaded("neo-tree")
T.check_plugin_loaded("actions-preview")
T.check_plugin_loaded("lualine")
T.check_plugin_loaded("which-key")

-- blink.cmp should be loaded (replaced nvim-cmp)
T.check_plugin_loaded("blink.cmp")
T.check_plugin_loaded("blink.compat")

-- Treesitter textobjects should be loaded
local ts_ok = pcall(require, "nvim-treesitter.textobjects")
local ts_ok2 = pcall(require, "nvim-treesitter-textobjects")
local ts_ok3 = pcall(require, "nvim-treesitter.textobjects.select")
T.check("plugin:treesitter-textobjects:loaded", ts_ok or ts_ok2 or ts_ok3,
  "treesitter-textobjects is not loaded (tried multiple module paths)")

-- Plugins that should NOT be loaded (removed or replaced)
T.check_plugin_not_loaded("notify")        -- Conflicts with noice
T.check_plugin_not_loaded("trim")          -- Redundant with conform
T.check_plugin_not_loaded("copilot")       -- Fully disabled, wasteful
T.check_plugin_not_loaded("intellitab")    -- Unmaintained
T.check_plugin_not_loaded("bufferline")    -- Deleted
T.check_plugin_not_loaded("nvim-tree")     -- Deleted
-- Note: "cmp" may appear as loaded because blink.compat impersonates nvim-cmp
-- (impersonate_nvim_cmp = true). This is expected — it's the compat shim, not real nvim-cmp.
T.check_plugin_not_loaded("luasnip")       -- Replaced by native vim.snippet
T.check_plugin_not_loaded("lspkind")       -- Replaced by blink.cmp icons

-- vim-nix plugin should not be explicitly loaded
T.check_plugin_not_loaded("nix")

-- Plenary should NOT be loaded
T.check_plugin_not_loaded("plenary")

T.report()
