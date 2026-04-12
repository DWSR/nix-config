-- Tier 3: Diagnostics pipeline tests
-- Tests diagnostic configuration and basic diagnostic functionality.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- Test 1: Diagnostic config is correct (Finding #10)
local diag_config = vim.diagnostic.config()
T.check("diagnostics:virtual-text-disabled",
  diag_config.virtual_text == false,
  "virtual_text should be false")
T.check("diagnostics:signs-enabled",
  diag_config.signs == true,
  "signs should be enabled")
T.check("diagnostics:underline-enabled",
  diag_config.underline == true,
  "underline should be enabled")
T.check("diagnostics:update-in-insert-disabled",
  diag_config.update_in_insert == false,
  "update_in_insert should be false (Finding #10)")

-- Test 2: CursorHold diagnostic float autocmd exists
local cursor_hold_acs = vim.api.nvim_get_autocmds({ event = "CursorHold" })
local has_diag_float = false
for _, au in ipairs(cursor_hold_acs) do
  if au.callback then
    has_diag_float = true
    break
  end
end
T.check("diagnostics:cursor-hold-float",
  has_diag_float,
  "CursorHold autocmd for diagnostic float should exist")

-- Test 3: Can set and get diagnostics programmatically
local test_ns = vim.api.nvim_create_namespace("test-diagnostics")
local test_buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(test_buf, 0, -1, true, { "line 1", "line 2", "line 3" })

vim.diagnostic.set(test_ns, test_buf, {
  {
    lnum = 0,
    col = 0,
    end_lnum = 0,
    end_col = 5,
    message = "test warning",
    severity = vim.diagnostic.severity.WARN,
  },
  {
    lnum = 1,
    col = 0,
    end_lnum = 1,
    end_col = 5,
    message = "test error",
    severity = vim.diagnostic.severity.ERROR,
  },
})

local diags = vim.diagnostic.get(test_buf)
T.check("diagnostics:set-and-get",
  #diags == 2,
  "expected 2 diagnostics, got " .. #diags)

-- Test severity filtering
local errors = vim.diagnostic.get(test_buf, { severity = vim.diagnostic.severity.ERROR })
T.check("diagnostics:severity-filter",
  #errors == 1,
  "expected 1 error diagnostic, got " .. #errors)

-- Clean up
vim.diagnostic.reset(test_ns, test_buf)
vim.api.nvim_buf_delete(test_buf, { force = true })

-- Test 4: Diagnostic float uses correct API (Finding #24)
-- The deprecated form is vim.diagnostic.open_float(nil, opts)
-- The correct form is vim.diagnostic.open_float(opts)
-- We can't directly test which form is used in the config, but the smoke test
-- catches the deprecation warning to stderr. Here we just verify the API works.
local float_buf = vim.api.nvim_create_buf(false, true)
vim.api.nvim_buf_set_lines(float_buf, 0, -1, true, { "test" })
vim.api.nvim_set_current_buf(float_buf)

-- Set a diagnostic on current buffer
vim.diagnostic.set(test_ns, float_buf, {
  { lnum = 0, col = 0, end_lnum = 0, end_col = 4, message = "test", severity = vim.diagnostic.severity.INFO },
})

-- Try opening the float (modern API)
local float_ok = pcall(vim.diagnostic.open_float, { scope = "cursor" })
T.check("diagnostics:open-float-api",
  float_ok,
  "vim.diagnostic.open_float() should work with single-argument form")

-- Clean up
vim.diagnostic.reset(test_ns, float_buf)
vim.api.nvim_buf_delete(float_buf, { force = true })

T.report()
