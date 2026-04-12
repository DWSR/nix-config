-- Tier 2: Keybinding assertions
-- Verifies expected keymaps exist, removed keymaps are absent,
-- and actions point to correct targets.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- ============================================================
-- LSP goto bindings — bare g* keys (no leader prefix)
-- ============================================================
T.check_keymap("n", "gd")   -- goto definition
T.check_keymap("n", "gD")   -- goto declaration
T.check_keymap("n", "gr")   -- goto references
T.check_keymap("n", "gI")   -- goto implementation
T.check_keymap("n", "gy")   -- goto type definition

-- Old <leader>g* goto bindings should NOT exist
T.check_no_keymap("n", " gd")
T.check_no_keymap("n", " gD")
T.check_no_keymap("n", " gr")
T.check_no_keymap("n", " gI")
T.check_no_keymap("n", " gy")

-- ============================================================
-- Git bindings — <leader>g* (colocated with plugins)
-- ============================================================
T.check_keymap("n", " gg", { action = "LazyGit" })
-- Gitsigns bindings are buffer-local (set via on_attach), not global.
-- They're tested in tier3 integration tests against a git-tracked buffer.

-- ============================================================
-- LSP action bindings
-- ============================================================
T.check_keymap("n", " la", { action = "actions-preview" })
T.check_keymap("n", " lf", { action = "conform" })

-- ============================================================
-- Diagnostic navigation
-- ============================================================
T.check_keymap("n", "]d")
T.check_keymap("n", "[d")

-- ============================================================
-- Removed keybindings (should NOT exist)
-- ============================================================

-- K hover removed (Neovim 0.10+ built-in handles it via LspAttach)
T.check_no_keymap("n", "K")

-- QuickFixToggle removed (function was never defined)
T.check_no_keymap("n", "<C-q>")

-- ============================================================
-- Comment toggle — built-in gc/gcc (Comment.nvim removed)
-- ============================================================
T.check_keymap("n", " /")   -- comment toggle (remaps to gcc)
T.check_keymap("v", " /")   -- visual comment toggle (remaps to gc)

-- ============================================================
-- Basic sanity
-- ============================================================
T.check_keymap("n", " e")   -- explorer toggle (neo-tree)
T.check_keymap("n", " bc")  -- buffer close
T.check_keymap("n", " q")   -- quit

T.report()
