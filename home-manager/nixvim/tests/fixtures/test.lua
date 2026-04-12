-- Lua file that uses vim globals (for lua_ls testing)
local x = vim.api.nvim_get_current_buf()
local y = vim.fn.expand("%")
print(x, y)
