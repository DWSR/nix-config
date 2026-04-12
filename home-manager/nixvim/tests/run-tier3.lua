-- Runner for all tier 3 tests
-- Executes each test file sequentially. Each file manages its own report/exit.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"

dofile(test_dir .. "tier3-lsp-attach.lua")
dofile(test_dir .. "tier3-format-on-save.lua")
dofile(test_dir .. "tier3-diagnostics.lua")
