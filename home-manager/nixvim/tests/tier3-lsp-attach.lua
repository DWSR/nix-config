-- Tier 3: LSP server attachment tests
-- Tests that real LSP servers can attach to buffers and respond.
-- Requires LSP server binaries in PATH (provided by nix test derivation).

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

local ATTACH_TIMEOUT = 15000 -- 15s for LSP servers to start and attach

--- Test LSP attachment for a fixture file
---@param fixture_path string Path to the fixture file
---@param expected_server string Expected LSP server name
---@param timeout? number Override timeout in ms
local function test_lsp_attach(fixture_path, expected_server, timeout)
  timeout = timeout or ATTACH_TIMEOUT

  -- Open the fixture file
  vim.cmd("edit " .. fixture_path)
  local bufnr = vim.api.nvim_get_current_buf()

  -- Wait for LSP to attach
  local ok = T.wait(timeout, function()
    local clients = vim.lsp.get_clients({ bufnr = bufnr })
    for _, client in ipairs(clients) do
      if client.name == expected_server then
        return true
      end
    end
    return false
  end)

  T.check("lsp-attach:" .. expected_server,
    ok,
    expected_server .. " did not attach to " .. fixture_path .. " within " .. timeout .. "ms")

  -- Clean up: close buffer and stop clients
  local clients = vim.lsp.get_clients({ bufnr = bufnr })
  for _, client in ipairs(clients) do
    client:stop(true)
  end
  vim.cmd("bdelete!")
end

-- Test fake server attachment first (validates our test infrastructure)
local fake = T.create_fake_server({
  textDocumentSync = { openClose = true, change = 1 },
})
local cid = vim.lsp.start({
  name = "test-fake-server",
  cmd = fake.cmd,
  root_dir = vim.fn.getcwd(),
})
T.check("lsp-attach:fake-server:started", cid ~= nil, "fake server start returned nil")

local fake_ok = T.wait(5000, function()
  return #vim.lsp.get_clients() > 0
end)
T.check("lsp-attach:fake-server:attached", fake_ok, "fake server did not attach")

-- Clean up fake server
if cid then
  local client = vim.lsp.get_client_by_id(cid)
  if client then client:stop(true) end
  -- Wait for cleanup
  T.wait(2000, function() return #vim.lsp.get_clients() == 0 end)
end

-- Test real LSP servers with fixture files
-- These require the server binaries to be in PATH (added via nativeBuildInputs)
-- Fixtures are in the CWD (copied by the nix test derivation to a writable dir)
local cwd = vim.fn.getcwd()

--- Test a real LSP server by opening a file and manually starting the client
---@param filename string Filename relative to CWD
---@param server_name string LSP server name
---@param cmd string|table Server command
local function test_real_lsp(filename, server_name, cmd)
  local filepath = cwd .. "/" .. filename
  vim.cmd("edit " .. filepath)
  local bufnr = vim.api.nvim_get_current_buf()

  -- Manually start the LSP since autostart=false
  vim.lsp.start({
    name = server_name,
    cmd = type(cmd) == "string" and { cmd } or cmd,
    root_dir = cwd,
  })

  local ok = T.wait(ATTACH_TIMEOUT, function()
    local clients = vim.lsp.get_clients({ bufnr = bufnr })
    for _, client in ipairs(clients) do
      if client.name == server_name then
        return true
      end
    end
    return false
  end)

  T.check("lsp-attach:" .. server_name, ok,
    server_name .. " did not attach to " .. filename .. " within " .. ATTACH_TIMEOUT .. "ms")

  -- Cleanup
  local clients = vim.lsp.get_clients({ bufnr = bufnr })
  for _, client in ipairs(clients) do
    client:stop(true)
  end
  T.wait(2000, function() return #vim.lsp.get_clients({ bufnr = bufnr }) == 0 end)
  vim.cmd("bdelete!")
end

-- nixd on test.nix
if vim.fn.executable("nixd") == 1 then
  test_real_lsp("test.nix", "nixd", "nixd")
else
  T.check("lsp-attach:nixd", false, "nixd binary not found in PATH")
end

-- lua_ls on test.lua
if vim.fn.executable("lua-language-server") == 1 then
  test_real_lsp("test.lua", "lua_ls", "lua-language-server")
else
  T.check("lsp-attach:lua_ls", false, "lua-language-server binary not found in PATH")
end

-- bashls on test.sh
if vim.fn.executable("bash-language-server") == 1 then
  test_real_lsp("test.sh", "bashls", { "bash-language-server", "start" })
else
  T.check("lsp-attach:bashls", false, "bash-language-server binary not found in PATH")
end

T.report()
