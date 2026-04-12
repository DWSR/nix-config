-- Runner for all tier 2 tests
-- Executes each test file sequentially. Each file manages its own report/exit.
-- If any test file fails (exits non-zero), nvim exits non-zero.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"

-- Run each test file. Each calls T.report() which exits on failure.
-- If a test passes, execution continues to the next file.
dofile(test_dir .. "tier2-plugins.lua")
dofile(test_dir .. "tier2-keybindings.lua")
dofile(test_dir .. "tier2-settings.lua")
dofile(test_dir .. "tier2-lsp-config.lua")
dofile(test_dir .. "tier2-keymap-conflicts.lua")
