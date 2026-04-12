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
T.check_plugin_loaded("cmp")
T.check_plugin_loaded("actions-preview")
T.check_plugin_loaded("lualine")
T.check_plugin_loaded("which-key")

-- Treesitter textobjects should be loaded
-- The plugin's Lua module is loaded under "nvim-treesitter-textobjects"
-- but may be accessed via treesitter's internal loader. Check the config instead.
local ts_ok = pcall(require, "nvim-treesitter.textobjects")
local ts_ok2 = pcall(require, "nvim-treesitter-textobjects")
local ts_ok3 = pcall(require, "nvim-treesitter.textobjects.select")
T.check("plugin:treesitter-textobjects:loaded", ts_ok or ts_ok2 or ts_ok3,
  "treesitter-textobjects is not loaded (tried multiple module paths)")

-- Plugins that should NOT be loaded (removed or conflicts)
T.check_plugin_not_loaded("notify")        -- Finding #1: conflicts with noice
T.check_plugin_not_loaded("trim")          -- Finding #2: redundant with conform
T.check_plugin_not_loaded("copilot")       -- Finding #5: fully disabled, wasteful
T.check_plugin_not_loaded("intellitab")    -- Finding #23: unmaintained
T.check_plugin_not_loaded("bufferline")    -- Already deleted
T.check_plugin_not_loaded("nvim-tree")     -- Already deleted

-- vim-nix plugin should not be explicitly loaded
-- Note: nix ftplugin files may come from treesitter grammar or neovim runtime,
-- which is fine. We're checking the vim-nix plugin itself isn't loaded.
T.check_plugin_not_loaded("nix")

-- Plenary should NOT be loaded (Finding #9: replaced with plain Lua)
T.check_plugin_not_loaded("plenary")

T.report()
