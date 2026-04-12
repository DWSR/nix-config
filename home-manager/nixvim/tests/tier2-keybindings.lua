-- Tier 2: Keybinding assertions
-- Verifies expected keymaps exist, removed keymaps are absent,
-- and actions point to correct targets.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- Finding #11: <leader>la should use actions-preview, not vim.lsp.buf.code_action
T.check_keymap("n", " la", { action = "actions-preview" })

-- Finding #12: [d / ]d diagnostic navigation should exist
T.check_keymap("n", "]d")
T.check_keymap("n", "[d")

-- Finding #15: lazygit should have a keybinding
T.check_keymap("n", " gg", { action = "LazyGit" })

-- <leader>lf should use conform, not vim.lsp.buf.format (already fixed)
T.check_keymap("n", " lf", { action = "conform" })

-- K hover should NOT have a custom global mapping (Finding #14: redundant in >= 0.10)
-- Note: Neovim 0.10+ sets K via LspAttach autocmd, not as a global keymap.
-- A global keymap would override the default in non-LSP buffers.
T.check_no_keymap("n", "K")

-- QuickFixToggle should be gone (already fixed)
T.check_no_keymap("n", "<C-q>")

-- Basic sanity: common keybindings still work
T.check_keymap("n", " e")   -- explorer toggle (neo-tree)
T.check_keymap("n", " /")   -- comment toggle
T.check_keymap("n", " bc")  -- buffer close

T.report()
