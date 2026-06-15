#!/usr/bin/env lua
-- gen-emmylua.lua -- standalone EmmyLua/LuaCATS annotation generator for Hammerspoon.
--
-- Reads a Hammerspoon `docs.json` (the machine-readable API description shipped
-- at `Hammerspoon.app/Contents/Resources/docs.json`) and emits one LuaCATS
-- `.lua` file per module into an output directory. Each emitted file declares
-- `---@class hs.<module>` and assigns the module table to its global name
-- (`hs = M`, `hs.<module> = M`, ...), so that lua-language-server treats `hs`
-- and every `hs.<module>` as TYPED globals with member checking: `hs.audiodevice`
-- resolves, `hs.bogusModule` is an `undefined-field`. Do NOT add `hs` to
-- `diagnostics.globals` downstream -- that would make it opaque and disable the
-- member checking this output exists to enable.
--
-- Usage:
--   lua gen-emmylua.lua <docs.json-path> <output-dir>
--     arg[1] = path to a Hammerspoon docs.json file
--     arg[2] = an EXISTING, writable output directory (one <module>.lua per module)
--
-- This is a plain-Lua port (lua5.4, zero rocks) of the upstream EmmyLua.spoon
-- generator so it can run at Nix build time with NO running Hammerspoon. The
-- Hammerspoon-only calls of the original are replaced: `hs.json` -> the vendored
-- pure-Lua JSON decoder below, `hs.fnutils.split` -> a pattern split, and all
-- filesystem/timestamp/Spoon-enumeration logic is dropped.
--
-- Ported from EmmyLua.spoon (MIT, http://github.com/folke):
--   https://github.com/Hammerspoon/Spoons/blob/master/Source/EmmyLua.spoon/init.lua
-- The docs.json -> LuaCATS emission shape (class + functions/fields, type-alias
-- map, def/arg/return parsing) is kept faithful to that source.

-------------------------------------------------------------------------------
-- Vendored JSON decoder
--
-- This is the DECODE half of json.lua (rxi), MIT licensed. Vendored verbatim so
-- the generator is fully self-contained (no luarocks). Original copyright and
-- license notice, retained as required by the MIT license:
--
--   json.lua
--   Copyright (c) 2020 rxi
--
--   Permission is hereby granted, free of charge, to any person obtaining a copy of
--   this software and associated documentation files (the "Software"), to deal in
--   the Software without restriction, including without limitation the rights to
--   use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
--   of the Software, and to permit persons to whom the Software is furnished to do
--   so, subject to the following conditions:
--
--   The above copyright notice and this permission notice shall be included in all
--   copies or substantial portions of the Software.
--
--   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
--   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
--   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
--   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
--   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
--   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
--   SOFTWARE.
-------------------------------------------------------------------------------

local json = {}

local parse

-- escape_char_map_inv maps a JSON escape letter back to its character. The two
-- table block below mirrors the original (the inverse is derived from the
-- forward map so the source stays recognisable).
local escape_char_map = {
  ["\\"] = "\\",
  ['"'] = '"',
  ["\b"] = "b",
  ["\f"] = "f",
  ["\n"] = "n",
  ["\r"] = "r",
  ["\t"] = "t",
}

local escape_char_map_inv = { ["/"] = "/" }
for k, v in pairs(escape_char_map) do
  escape_char_map_inv[v] = k
end

local function create_set(...)
  local res = {}
  for i = 1, select("#", ...) do
    res[select(i, ...)] = true
  end
  return res
end

local space_chars = create_set(" ", "\t", "\r", "\n")
local delim_chars = create_set(" ", "\t", "\r", "\n", "]", "}", ",")
local escape_chars = create_set("\\", "/", '"', "b", "f", "n", "r", "t", "u")
local literals = create_set("true", "false", "null")

local literal_map = {
  ["true"] = true,
  ["false"] = false,
  ["null"] = nil,
}

local function next_char(str, idx, set, negate)
  for i = idx, #str do
    if set[str:sub(i, i)] ~= negate then
      return i
    end
  end
  return #str + 1
end

local function decode_error(str, idx, msg)
  local line_count = 1
  local col_count = 1
  for i = 1, idx - 1 do
    col_count = col_count + 1
    if str:sub(i, i) == "\n" then
      line_count = line_count + 1
      col_count = 1
    end
  end
  error(string.format("%s at line %d col %d", msg, line_count, col_count))
end

local function codepoint_to_utf8(n)
  -- http://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=iws-appendixa
  local f = math.floor
  if n <= 0x7f then
    return string.char(n)
  elseif n <= 0x7ff then
    return string.char(f(n / 64) + 192, n % 64 + 128)
  elseif n <= 0xffff then
    return string.char(f(n / 4096) + 224, f(n % 4096 / 64) + 128, n % 64 + 128)
  elseif n <= 0x10ffff then
    return string.char(f(n / 262144) + 240, f(n % 262144 / 4096) + 128, f(n % 4096 / 64) + 128, n % 64 + 128)
  end
  error(string.format("invalid unicode codepoint '%x'", n))
end

local function parse_unicode_escape(s)
  local n1 = tonumber(s:sub(1, 4), 16)
  local n2 = tonumber(s:sub(7, 10), 16)
  -- Surrogate pair?
  if n2 then
    return codepoint_to_utf8((n1 - 0xd800) * 0x400 + (n2 - 0xdc00) + 0x10000)
  else
    return codepoint_to_utf8(n1)
  end
end

local function parse_string(str, i)
  local res = ""
  local j = i + 1
  local k = j

  while j <= #str do
    local x = str:byte(j)

    if x < 32 then
      decode_error(str, j, "control character in string")
    elseif x == 92 then -- `\`: Escape
      res = res .. str:sub(k, j - 1)
      j = j + 1
      local c = str:sub(j, j)
      if c == "u" then
        local hex = str:match("^[dD][89aAbB]%x%x\\u%x%x%x%x", j + 1)
          or str:match("^%x%x%x%x", j + 1)
          or decode_error(str, j - 1, "invalid unicode escape in string")
        res = res .. parse_unicode_escape(hex)
        j = j + #hex
      else
        if not escape_chars[c] then
          decode_error(str, j - 1, "invalid escape char '" .. c .. "' in string")
        end
        res = res .. escape_char_map_inv[c]
      end
      k = j + 1
    elseif x == 34 then -- `"`: End of string
      res = res .. str:sub(k, j - 1)
      return res, j + 1
    end

    j = j + 1
  end

  decode_error(str, i, "expected closing quote for string")
end

local function parse_number(str, i)
  local x = next_char(str, i, delim_chars)
  local s = str:sub(i, x - 1)
  local n = tonumber(s)
  if not n then
    decode_error(str, i, "invalid number '" .. s .. "'")
  end
  return n, x
end

local function parse_literal(str, i)
  local x = next_char(str, i, delim_chars)
  local word = str:sub(i, x - 1)
  if not literals[word] then
    decode_error(str, i, "invalid literal '" .. word .. "'")
  end
  return literal_map[word], x
end

local function parse_array(str, i)
  local res = {}
  local n = 1
  i = i + 1
  while 1 do
    local x
    i = next_char(str, i, space_chars, true)
    -- Empty / end of array?
    if str:sub(i, i) == "]" then
      i = i + 1
      break
    end
    -- Read token
    x, i = parse(str, i)
    res[n] = x
    n = n + 1
    -- Next token
    i = next_char(str, i, space_chars, true)
    local chr = str:sub(i, i)
    i = i + 1
    if chr == "]" then
      break
    end
    if chr ~= "," then
      decode_error(str, i, "expected ']' or ','")
    end
  end
  return res, i
end

local function parse_object(str, i)
  local res = {}
  i = i + 1
  while 1 do
    local key, val
    i = next_char(str, i, space_chars, true)
    -- Empty / end of object?
    if str:sub(i, i) == "}" then
      i = i + 1
      break
    end
    -- Read key
    if str:sub(i, i) ~= '"' then
      decode_error(str, i, "expected string for key")
    end
    key, i = parse(str, i)
    -- Read ':' delimiter
    i = next_char(str, i, space_chars, true)
    if str:sub(i, i) ~= ":" then
      decode_error(str, i, "expected ':' after key")
    end
    i = next_char(str, i + 1, space_chars, true)
    -- Read value
    val, i = parse(str, i)
    -- Set
    res[key] = val
    -- Next token
    i = next_char(str, i, space_chars, true)
    local chr = str:sub(i, i)
    i = i + 1
    if chr == "}" then
      break
    end
    if chr ~= "," then
      decode_error(str, i, "expected '}' or ','")
    end
  end
  return res, i
end

local char_func_map = {
  ['"'] = parse_string,
  ["0"] = parse_number,
  ["1"] = parse_number,
  ["2"] = parse_number,
  ["3"] = parse_number,
  ["4"] = parse_number,
  ["5"] = parse_number,
  ["6"] = parse_number,
  ["7"] = parse_number,
  ["8"] = parse_number,
  ["9"] = parse_number,
  ["-"] = parse_number,
  ["t"] = parse_literal,
  ["f"] = parse_literal,
  ["n"] = parse_literal,
  ["["] = parse_array,
  ["{"] = parse_object,
}

parse = function(str, idx)
  local chr = str:sub(idx, idx)
  local f = char_func_map[chr]
  if f then
    return f(str, idx)
  end
  decode_error(str, idx, "unexpected character '" .. chr .. "'")
end

function json.decode(str)
  if type(str) ~= "string" then
    error("expected argument of type string, got " .. type(str))
  end
  local res, idx = parse(str, next_char(str, 1, space_chars, true))
  idx = next_char(str, idx, space_chars, true)
  if idx <= #str then
    decode_error(str, idx, "trailing garbage")
  end
  return res
end

-------------------------------------------------------------------------------
-- Generator (ported from EmmyLua.spoon, MIT, folke)
-------------------------------------------------------------------------------

-- Type-alias map: maps docs.json type words to LuaCATS type names. Faithful to
-- the upstream `options.types` table.
local types = {
  bool = "boolean",
  boolean = "boolean",
  ["false"] = "boolean",
  ["true"] = "boolean",
  string = "string",
  number = "number",
  float = "number",
  integer = "number",
  app = "hs.application",
  hsminwebtable = "hs.httpserver.hsminweb",
  notificationobject = "hs.notify",
  point = "hs.geometry",
  rect = "hs.geometry",
  ["hs.geometry rect"] = "hs.geometry",
  size = "hs.geometry",
}

-- Item categories present in a docs.json module object. The real bundle also
-- carries a pre-flattened `items` array; this list is the fallback used when a
-- module has no `items` (e.g. a minimal test fixture).
local CATEGORIES = {
  "Constructor",
  "Function",
  "Method",
  "Constant",
  "Variable",
  "Field",
  "Command",
  "Deprecated",
}

local function read_file(path)
  local fd, err = io.open(path, "r")
  if not fd then
    error("cannot read docs.json at '" .. tostring(path) .. "': " .. tostring(err))
  end
  local content = fd:read("a")
  fd:close()
  return content
end

-- Replacement for hs.fnutils.split with the same (pattern, non-plain) default
-- semantics: split `s` on every match of the Lua pattern `sep`.
local function split(s, sep)
  if sep == "" then
    return { s }
  end
  local out = {}
  if #s > 0 then
    local n, start = 1, 1
    local first, last = s:find(sep, start)
    while first do
      out[n] = s:sub(start, first - 1)
      n = n + 1
      start = last + 1
      first, last = s:find(sep, start)
    end
    out[n] = s:sub(start)
  end
  return out
end

local function trim(str)
  str = str:gsub("^%s*", "")
  str = str:gsub("%s*$", "")
  return str
end

local function parse_type(module, str)
  if not str then
    return
  end
  str = str:lower()
  if types[str] then
    return types[str]
  end
  local t = str:match("^(hs%.%S*)%s*object")
  if t then
    return t
  end
  t = str:match("^list of (hs%.%S*)%s*object")
  if t then
    return t .. "[]"
  end
  if module.name:find(str, 1, true) or str == "self" then
    return module.name
  end
end

local function parse_args(str)
  local name, args = str:match("^(.*)%((.*)%)$")
  if name then
    args = args:gsub("%s*|%s*", "_or_")
    args = args:gsub("%s+or%s+", "_or_")
    args = args:gsub("[%[%]{}%(%)]", "")
    if args:find("...") then
      args = args:gsub(",?%s*%.%.%.", "")
      args = trim(args)
      if #args > 0 then
        args = args .. ", "
      end
      args = args .. "..."
    end
    args = split(args, "%s*,%s*")
    for a, arg in ipairs(args) do
      if arg == "false" then
        args[a] = "_false"
      elseif arg == "function" then
        args[a] = "fn"
      elseif arg == "end" then
        args[a] = "_end"
      end
    end
    return name, args
  end
  return str
end

local function parse_def(module, el)
  local def = el.def or ""
  local parts = split(def, "%s*%-+>%s*")
  local name, args = parse_args(parts[1] or "")
  local ret = { name = name, args = args, type = parse_type(module, parts[2]) }
  if name:match("%[.*%]$") then
    if not ret.type then
      ret.type = "table"
    end
    ret.name = ret.name:sub(1, ret.name:find("%[") - 1)
  end
  return ret
end

-- Render a docstring as a block of `-- ` comment lines. Unlike the upstream
-- version this tolerates a nil/empty doc (test fixtures omit `doc`), emitting
-- nothing rather than erroring.
local function comment(str, comment_str)
  if not str or str == "" then
    return ""
  end
  comment_str = comment_str or "--"
  return comment_str .. " " .. str:gsub("[\n]", "\n" .. comment_str .. " "):gsub("%s+\n", "\n") .. "\n"
end

-- Collect a module's items. Prefer the canonical pre-flattened `items` array
-- (present in the real bundle; robust to schema drift adding new categories);
-- fall back to concatenating the known category arrays (test fixtures).
local function collect_items(module)
  if type(module.items) == "table" and #module.items > 0 then
    return module.items
  end
  local items = {}
  for _, cat in ipairs(CATEGORIES) do
    local arr = module[cat]
    if type(arr) == "table" then
      for _, it in ipairs(arr) do
        items[#items + 1] = it
      end
    end
  end
  return items
end

local function process_module(out, module)
  out:write("--# selene: allow(unused_variable)\n")
  out:write("---@diagnostic disable: unused-local\n\n")

  if module.name == "hs" then
    out:write("--- global variable containing loaded spoons\n")
    out:write("spoon = {}\n\n")
  end

  out:write(comment(module.doc))
  out:write("---@class " .. module.name .. "\n")
  out:write("local M = {}\n")
  out:write(module.name .. " = M\n\n")

  for _, item in ipairs(collect_items(module)) do
    local def = parse_def(module, item)
    -- Skip a malformed item with no usable name (would emit invalid Lua).
    if def.name and def.name ~= "" then
      out:write(comment(item.doc))
      local name = def.name
      if def.name:find(module.name, 1, true) == 1 then
        name = "M" .. def.name:sub(#module.name + 1)
      end
      if def.args then
        if def.type then
          out:write("---@return " .. def.type .. "\n")
        end
        out:write("function " .. name .. "(" .. table.concat(def.args, ", ") .. ") end\n")
      else
        if def.type then
          out:write("---@type " .. def.type .. "\n")
        end
        if def.type and (def.type:find("table") or def.type:find("%[%]")) then
          out:write(name .. " = {}\n")
        else
          out:write(name .. " = nil\n")
        end
      end
      out:write("\n")
    end
  end
end

local function main(args)
  local docs_path = args[1]
  local out_dir = args[2]
  if not docs_path or not out_dir then
    io.stderr:write("usage: lua gen-emmylua.lua <docs.json-path> <output-dir>\n")
    os.exit(1)
  end
  -- Normalise a trailing slash so `<dir>/<name>.lua` is well formed.
  out_dir = out_dir:gsub("/+$", "")

  local data = json.decode(read_file(docs_path))
  if type(data) ~= "table" then
    error("docs.json did not decode to an array of modules")
  end

  local count = 0
  for _, module in ipairs(data) do
    if module.type ~= "Module" then
      error("expected a module, but found type=" .. tostring(module.type))
    end
    local fname = out_dir .. "/" .. module.name .. ".lua"
    local fd, err = io.open(fname, "w+")
    if not fd then
      error("cannot write annotation file '" .. fname .. "': " .. tostring(err))
    end
    process_module(fd, module)
    fd:close()
    count = count + 1
  end

  io.stderr:write(string.format("gen-emmylua: wrote %d annotation file(s) to %s\n", count, out_dir))
end

main(arg)
