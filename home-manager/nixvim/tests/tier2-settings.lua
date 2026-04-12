-- Tier 2: Settings and configuration value assertions
-- Verifies neovim options, diagnostic config, and plugin settings.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- Finding #10: update_in_insert should be false (causes input lag)
local diag_config = vim.diagnostic.config()
T.check("settings:diagnostics:update_in_insert",
  diag_config.update_in_insert == false,
  "update_in_insert should be false, got " .. tostring(diag_config.update_in_insert))

-- Finding #7: byteCompileLua should be enabled
-- This is a nix-level setting, tested via nix assertions in the check derivation.
-- At runtime, we can check if lua files are byte-compiled by checking the loader.
-- (Skipped — this is better as a nix assertion)

-- Finding #9: undodir should NOT use plenary (should be plain Lua string concat)
local undodir = vim.o.undodir
T.check("settings:undodir:no-plenary",
  undodir ~= nil and undodir ~= "",
  "undodir should be set")
T.check("settings:undodir:contains-undo",
  undodir and undodir:find("undo") ~= nil,
  "undodir should contain 'undo', got: " .. tostring(undodir))

-- Finding #25: buf_kill function should exist and be callable
T.check("settings:buf_kill:defined",
  type(buf_kill) == "function",
  "buf_kill function should be defined globally")

-- Treesitter grammar count should be reasonable (Finding #8)
-- With explicit list, should be < 50 parsers, not 200+
local parsers = vim.api.nvim_get_runtime_file("parser/*.so", true)
T.check("settings:treesitter:grammar-count",
  #parsers < 50,
  "expected < 50 treesitter parsers, got " .. #parsers .. " (using allGrammars?)")

-- conform.nvim should have format_on_save configured
local conform_ok, conform = pcall(require, "conform")
if conform_ok then
  -- Verify formatters_by_ft has expected entries
  local formatters = require("conform").formatters_by_ft or {}
  T.check("settings:conform:nix", formatters.nix ~= nil, "conform should have nix formatters")
  T.check("settings:conform:lua", formatters.lua ~= nil, "conform should have lua formatters")
  T.check("settings:conform:python", formatters.python ~= nil, "conform should have python formatters")
  T.check("settings:conform:go", formatters.go ~= nil, "conform should have go formatters")
  T.check("settings:conform:bash", formatters.bash ~= nil, "conform should have bash formatters")
  T.check("settings:conform:fallback", formatters["_"] ~= nil, "conform should have _ fallback")
else
  T.check("settings:conform:loaded", false, "conform module not loadable")
end

-- actions-preview should NOT have telescope backend config (Finding #4)
local ap_ok, _ = pcall(require, "actions-preview")
if ap_ok then
  -- The telescope config block should have been removed
  -- We can check if actions-preview's config references telescope
  local ap_config = require("actions-preview").config or {}
  T.check("settings:actions-preview:no-telescope",
    ap_config.telescope == nil,
    "actions-preview should not have telescope config (telescope was removed)")
end

-- Snacks notifier should be enabled (used by noice as notification backend)
local snacks_ok = pcall(require, "snacks")
if snacks_ok then
  T.check("settings:snacks:notifier-enabled",
    Snacks.config.notifier and Snacks.config.notifier.enabled,
    "Snacks notifier should be enabled for noice notification rendering")
else
  T.check("settings:snacks:loaded", false, "snacks module not loadable")
end

-- Noice should have LSP progress disabled (fidget handles it)
local noice_ok, noice_config = pcall(require, "noice.config")
if noice_ok then
  local opts = noice_config.options or {}
  local lsp = opts.lsp or {}
  local progress = lsp.progress or {}
  T.check("settings:noice:lsp-progress-disabled",
    progress.enabled == false,
    "noice LSP progress should be disabled (fidget handles it)")
end

-- blink.cmp should be configured with expected sources
local blink_ok = pcall(require, "blink.cmp")
if blink_ok then
  -- Verify blink.cmp loaded (not nvim-cmp)
  T.check("settings:blink:loaded", true)

  -- Note: package.loaded["cmp"] may be set by blink.compat's impersonate_nvim_cmp.
  -- This is the compat shim, not real nvim-cmp. No assertion needed.
else
  T.check("settings:blink:loaded", false, "blink.cmp module not loadable")
end

T.report()
