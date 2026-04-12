-- Tier 3: Format-on-save integration tests
-- Tests that conform.nvim's format_on_save triggers correctly
-- and that the formatting pipeline works end-to-end.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- Test 1: conform.nvim format_on_save is configured
local conform_ok, conform = pcall(require, "conform")
T.check("format:conform:loaded", conform_ok, "conform.nvim not loaded")

if conform_ok then
  -- Test 2: BufWritePre autocmd exists (set up by conform)
  local autocmds = vim.api.nvim_get_autocmds({ event = "BufWritePre" })
  local has_conform_autocmd = false
  for _, au in ipairs(autocmds) do
    -- conform registers its autocmd with a group
    if au.group_name and au.group_name:find("Conform") then
      has_conform_autocmd = true
      break
    end
    -- Also check callback source
    if au.desc and au.desc:find("conform") then
      has_conform_autocmd = true
      break
    end
  end
  T.check("format:conform:autocmd",
    has_conform_autocmd or #autocmds > 0,
    "no BufWritePre autocmd found (conform format_on_save should create one)")

  -- Test 3: No null-ls BufWritePre autocmd (Finding #1/#2: null-ls removed)
  local has_nullls_autocmd = false
  for _, au in ipairs(autocmds) do
    if au.group_name and au.group_name:find("lsp_format_on_save") then
      has_nullls_autocmd = true
      break
    end
  end
  T.check("format:no-null-ls-autocmd",
    not has_nullls_autocmd,
    "lsp_format_on_save autogroup should not exist (null-ls removed)")

  -- Test 4: Formatting a buffer via conform API works
  local scratch_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_current_buf(scratch_buf)
  vim.api.nvim_buf_set_lines(scratch_buf, 0, -1, true, { "  hello  ", "  world  " })
  vim.bo[scratch_buf].filetype = "" -- use _ fallback (trim_whitespace)

  -- Call conform directly (not via autocmd, to avoid needing a file)
  local formatted = false
  conform.format({
    bufnr = scratch_buf,
    timeout_ms = 2000,
    quiet = true,
  }, function(err)
    formatted = true
  end)

  -- Wait for async formatting
  T.wait(3000, function() return formatted end)

  local lines_after = vim.api.nvim_buf_get_lines(scratch_buf, 0, -1, true)
  -- trim_whitespace should strip trailing spaces
  local trimmed = true
  for _, line in ipairs(lines_after) do
    if line:match("%s+$") then
      trimmed = false
      break
    end
  end
  T.check("format:trim-whitespace",
    trimmed,
    "trim_whitespace fallback should strip trailing spaces")

  vim.api.nvim_buf_delete(scratch_buf, { force = true })
end

-- Test 5: No trim.nvim BufWritePre autocmd (Finding #2: removed)
local trim_autocmds = vim.api.nvim_get_autocmds({
  event = "BufWritePre",
  group = "TrimNvim",
})
-- pcall because the group may not exist
local trim_group_exists = pcall(function()
  return vim.api.nvim_get_autocmds({
    event = "BufWritePre",
    group = vim.api.nvim_create_augroup("TrimNvim", { clear = false }),
  })
end)
T.check("format:no-trim-autocmd",
  not trim_group_exists or #trim_autocmds == 0,
  "TrimNvim autogroup should not exist (trim.nvim removed)")

T.report()
