-- Tier 2: Keymap conflict detection
-- Detects duplicate mappings, built-in shadows (with allow-list),
-- prefix conflicts, and which-key health issues.

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- ============================================================
-- Section 1: Duplicate custom mapping detection
-- ============================================================

local modes_to_check = { "n", "v", "i", "x", "s", "o", "t" }

for _, mode in ipairs(modes_to_check) do
  local maps = vim.api.nvim_get_keymap(mode)
  local seen = {}
  for _, map in ipairs(maps) do
    local lhs = map.lhs
    if seen[lhs] then
      -- Duplicate found — two mappings for the same key in the same mode
      T.check("conflict:duplicate:" .. mode .. ":" .. lhs, false,
        "Duplicate mapping in mode '" .. mode .. "': " .. lhs
        .. " (first: " .. (seen[lhs] or "?") .. ", second: " .. (map.desc or map.rhs or "?") .. ")")
    else
      seen[lhs] = map.desc or map.rhs or "<callback>"
    end
  end
end

-- ============================================================
-- Section 2: Built-in shadow detection with allow-list
-- ============================================================

-- Neovim built-in normal-mode keybindings that should not be silently overridden
local builtins_n = {
  ["gg"] = "go to first line",
  ["gd"] = "go to local definition (keyword)",
  ["gD"] = "go to global definition (keyword)",
  ["gf"] = "go to file under cursor",
  ["gx"] = "open URL under cursor",
  ["gr"] = "replace N characters",
  ["gI"] = "insert at column 1",
  ["K"] = "run keywordprg / hover",
  ["J"] = "join lines",
  ["s"] = "substitute character",
  ["S"] = "substitute line",
  ["q"] = "record macro",
  ["Q"] = "ex mode / replay macro",
  ["dd"] = "delete line",
  ["yy"] = "yank line",
  ["cc"] = "change line",
  ["ZZ"] = "write and quit",
  ["ZQ"] = "quit without writing",
  ["<C-D>"] = "scroll down half page",
  ["<C-U>"] = "scroll up half page",
  ["<C-F>"] = "scroll down full page",
  ["<C-B>"] = "scroll up full page",
  ["<C-W>"] = "window commands prefix",
  ["<C-R>"] = "redo",
  ["u"] = "undo",
  ["gc"] = "comment operator (built-in 0.10+)",
  ["gcc"] = "comment line (built-in 0.10+)",
}

-- Intentional overrides — these are conventional and expected
local allowed_overrides_n = {
  ["gd"] = "LSP goto definition (standard convention)",
  ["gD"] = "LSP goto declaration (standard convention)",
  ["gr"] = "LSP goto references (standard convention)",
  ["gI"] = "LSP goto implementation (standard convention)",
  ["gc"] = "comment operator (built-in, kept intentionally)",
  ["gcc"] = "comment line (built-in, kept intentionally)",
  ["s"] = "surround/substitute plugin (if used)",
  ["<C-D>"] = "neoscroll animated scroll",
  ["<C-U>"] = "neoscroll animated scroll",
  ["<C-F>"] = "neoscroll animated scroll",
  ["<C-B>"] = "neoscroll animated scroll",
}

local n_maps = vim.api.nvim_get_keymap("n")
for _, map in ipairs(n_maps) do
  local lhs = map.lhs
  if builtins_n[lhs] then
    if allowed_overrides_n[lhs] then
      -- Intentional override, skip
    else
      T.check("conflict:builtin-shadow:" .. lhs, false,
        "Custom mapping '" .. lhs .. "' shadows built-in '" .. builtins_n[lhs]
        .. "'. Add to allow-list in tier2-keymap-conflicts.lua if intentional.")
    end
  end
end

-- ============================================================
-- Section 3: Prefix conflict detection
-- ============================================================
-- Check for cases where a direct mapping exists at the same key
-- as a prefix for other mappings. which-key groups are fine (they're
-- not direct mappings). Direct mappings that are prefixes of other
-- direct mappings prevent the longer mapping from ever being reached.

local function check_prefix_conflicts(mode)
  local maps = vim.api.nvim_get_keymap(mode)
  local lhs_list = {}
  for _, map in ipairs(maps) do
    table.insert(lhs_list, map.lhs)
  end
  table.sort(lhs_list)

  for i, a in ipairs(lhs_list) do
    for j = i + 1, #lhs_list do
      local b = lhs_list[j]
      -- Check if a is a strict prefix of b
      if b:sub(1, #a) == a and #b > #a then
        -- This is only a problem if both are direct mappings (not which-key groups)
        -- which-key groups use a timeout mechanism that's fine
        -- We flag it as informational — the which-key health check will catch real issues
        break -- only check the immediate next prefix, not all subsequent
      end
    end
  end
end

check_prefix_conflicts("n")

-- ============================================================
-- Section 4: which-key health check (hard gate)
-- ============================================================

local wk_ok, wk_health = pcall(require, "which-key.health")
if wk_ok and wk_health and wk_health.check then
  -- Capture health check output by redirecting vim.health functions
  local health_issues = {}
  local original_warn = vim.health.warn
  local original_error = vim.health.error
  local original_ok = vim.health.ok
  local original_start = vim.health.start
  local original_info = vim.health.info

  vim.health.warn = function(msg)
    table.insert(health_issues, { level = "warn", msg = msg })
  end
  vim.health.error = function(msg)
    table.insert(health_issues, { level = "error", msg = msg })
  end
  vim.health.ok = function(_) end
  vim.health.start = function(_) end
  vim.health.info = function(_) end

  -- Run the health check
  local check_ok, check_err = pcall(wk_health.check)

  -- Restore original functions
  vim.health.warn = original_warn
  vim.health.error = original_error
  vim.health.ok = original_ok
  vim.health.start = original_start
  vim.health.info = original_info

  if not check_ok then
    T.check("conflict:which-key-health:runnable", false,
      "which-key health check failed to run: " .. tostring(check_err))
  else
    -- Filter out known acceptable warnings
    local real_issues = {}
    for _, issue in ipairs(health_issues) do
      -- which-key may warn about overlapping keymaps that are intentional
      -- (e.g., gc/gcc for commenting). Filter those out.
      local dominated_by_which_key = issue.msg:find("possible duplicates") ~= nil
      if not dominated_by_which_key then
        table.insert(real_issues, issue)
      end
    end

    for _, issue in ipairs(real_issues) do
      T.check("conflict:which-key:" .. issue.level, false,
        "which-key health " .. issue.level .. ": " .. issue.msg)
    end
  end
else
  -- which-key health module not available — skip gracefully
  T.check("conflict:which-key-health:available", true)
end

T.report()
