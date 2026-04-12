-- Tier 2: LSP server configuration assertions
-- Verifies LSP servers are configured with correct settings.
-- Does NOT test actual LSP attachment (that's tier 3).

local test_dir = debug.getinfo(1, "S").source:match("@?(.*/)") or "./"
local T = dofile(test_dir .. "lib.lua")

-- Helper: get lspconfig server settings
local function get_server_config(name)
  local ok, lspconfig = pcall(require, "lspconfig")
  if not ok then return nil end
  local server = lspconfig[name]
  if not server then return nil end
  -- Get the default config that would be used
  return server.document_config and server.document_config.default_config or nil
end

-- Finding #19: lua_ls should have workspace config with vim global
T.check_lsp_config("lua_ls", function(config)
  local settings = config.settings or {}
  local lua = settings.Lua or {}
  local diags = lua.diagnostics or {}
  local globals = diags.globals or {}
  local has_vim = false
  for _, g in ipairs(globals) do
    if g == "vim" then has_vim = true; break end
  end
  return has_vim, "lua_ls should have 'vim' in diagnostics.globals"
end)

-- Finding #20: jsonls should have SchemaStore configured
T.check_lsp_config("jsonls", function(config)
  local settings = config.settings or {}
  local json = settings.json or {}
  local has_schemas = json.schemas ~= nil or json.validate ~= nil
  return has_schemas, "jsonls should have schemas or validate configured"
end)

-- Finding #21: docker_compose_language_service should exist
T.check_lsp_config("docker_compose_language_service")

-- Finding #18: nixd formatting command should be a proper value (not bare Lua identifier)
-- The actual test is that nvim starts without Lua errors (tier 1 smoke test).
-- Here we verify nixd is configured.
T.check_lsp_config("nixd")

-- Servers that should be configured
local expected_servers = {
  "nixd",
  "lua_ls",
  "gopls",
  "pyright",
  "bashls",
  "yamlls",
  "jsonls",
  "terraformls",
  "dockerls",
  "docker_compose_language_service",
  "ansiblels",
  "graphql",
  "marksman",
}

for _, server in ipairs(expected_servers) do
  local ok, lspconfig = pcall(require, "lspconfig")
  if ok then
    T.check("lsp:" .. server .. ":exists",
      lspconfig[server] ~= nil,
      server .. " should be in lspconfig")
  end
end

-- Finding #17: yamlls should NOT have manual schemaStore config
-- (should use the schemastore plugin instead)
T.check_lsp_config("yamlls", function(config)
  local settings = config.settings or {}
  local yaml = settings.yaml or {}
  local ss = yaml.schemaStore or {}
  -- If schemaStore.url is manually set, that's the duplicate
  local has_manual_url = ss.url ~= nil
  return not has_manual_url, "yamlls should not have manual schemaStore.url (use plugin instead)"
end)

T.report()
