-- Test assertion library for nixvim config tests
-- Usage: local T = dofile("lib.lua")
--        T.check("name", condition, "message")
--        T.report()  -- prints results and exits

local M = {}
M._errors = {}
M._passed = 0

--- Record a test result
---@param name string Test name
---@param condition boolean Whether the test passed
---@param msg? string Failure message
function M.check(name, condition, msg)
  if condition then
    M._passed = M._passed + 1
  else
    table.insert(M._errors, name .. ": " .. (msg or "failed"))
  end
end

--- Check that a plugin module is loaded
---@param module_name string The Lua module name (e.g., "gitsigns")
function M.check_plugin_loaded(module_name)
  local ok = pcall(require, module_name)
  M.check("plugin:" .. module_name .. ":loaded", ok, module_name .. " is not loaded")
end

--- Check that a plugin module is NOT loaded
---@param module_name string The Lua module name
function M.check_plugin_not_loaded(module_name)
  local loaded = package.loaded[module_name] ~= nil
  M.check("plugin:" .. module_name .. ":not-loaded", not loaded, module_name .. " should not be loaded")
end

--- Check that a keymap exists in the given mode
---@param mode string The mode ("n", "v", "i", etc.)
---@param lhs string The key sequence (e.g., " la" for <leader>la with space leader)
---@param opts? table Optional: { action = "expected action substring", desc = "expected desc" }
function M.check_keymap(mode, lhs, opts)
  opts = opts or {}
  local maps = vim.api.nvim_get_keymap(mode)
  local found = nil
  for _, map in ipairs(maps) do
    if map.lhs == lhs then
      found = map
      break
    end
  end

  local name = "keymap:" .. mode .. ":" .. lhs
  M.check(name .. ":exists", found ~= nil, "keymap " .. lhs .. " not found in mode " .. mode)

  if found and opts.action then
    local has_action = false
    local rhs = found.rhs or found.callback and "<callback>" or ""
    if type(rhs) == "string" then
      has_action = rhs:find(opts.action, 1, true) ~= nil
    end
    M.check(name .. ":action", has_action, "expected action containing '" .. opts.action .. "', got '" .. tostring(rhs) .. "'")
  end
end

--- Check that a keymap does NOT exist
---@param mode string
---@param lhs string
function M.check_no_keymap(mode, lhs)
  local maps = vim.api.nvim_get_keymap(mode)
  local found = false
  for _, map in ipairs(maps) do
    if map.lhs == lhs then
      found = true
      break
    end
  end
  M.check("keymap:" .. mode .. ":" .. lhs .. ":absent", not found, "keymap " .. lhs .. " should not exist in mode " .. mode)
end

--- Check an LSP server config exists with expected settings
---@param server_name string
---@param check_fn? fun(config: table): boolean, string? Optional validation function
function M.check_lsp_config(server_name, check_fn)
  local configs = vim.lsp._raw_configurations or {}
  -- Try lspconfig registry
  local ok, lspconfig = pcall(require, "lspconfig")
  if ok then
    local server = lspconfig[server_name]
    if server and server.manager then
      M.check("lsp:" .. server_name .. ":configured", true)
      if check_fn then
        local config = server.manager.config or server.config or {}
        local pass, msg = check_fn(config)
        M.check("lsp:" .. server_name .. ":settings", pass, msg)
      end
      return
    end
  end

  -- Fallback: check nixvim's LSP config via vim.lsp
  M.check("lsp:" .. server_name .. ":configured", false, server_name .. " not found in lspconfig")
end

--- Wait for a condition with timeout
---@param timeout_ms number
---@param condition fun(): boolean
---@param interval_ms? number
---@return boolean
function M.wait(timeout_ms, condition, interval_ms)
  return vim.wait(timeout_ms, condition, interval_ms or 50)
end

--- Create a fake in-process LSP server
---@param capabilities? table Server capabilities
---@return table server with .cmd function and .messages log
function M.create_fake_server(capabilities)
  local server = { messages = {} }

  function server.cmd(dispatchers)
    local srv = {}

    function srv.request(method, params, callback)
      table.insert(server.messages, { method = method, params = params })
      if method == "initialize" then
        callback(nil, {
          capabilities = capabilities or {
            textDocumentSync = { openClose = true, change = 1 },
          },
        })
      elseif method == "shutdown" then
        callback(nil, nil)
      end
      return true, #server.messages
    end

    function srv.notify(method, params)
      table.insert(server.messages, { method = method, params = params })
      if method == "exit" then
        dispatchers.on_exit(0, 15)
      end
    end

    function srv.is_closing()
      return false
    end

    function srv.terminate()
      dispatchers.on_exit(0, 15)
    end

    return srv
  end

  return server
end

--- Print results and exit with appropriate code
function M.report()
  local total = M._passed + #M._errors
  if #M._errors > 0 then
    for _, e in ipairs(M._errors) do
      io.stderr:write("FAIL: " .. e .. "\n")
    end
    io.stderr:write(string.format("\n%d/%d tests passed, %d FAILED\n", M._passed, total, #M._errors))
    vim.cmd("cquit! 1")
  else
    io.stderr:write(string.format("OK: %d/%d tests passed\n", M._passed, total))
    vim.cmd("quit!")
  end
end

return M
