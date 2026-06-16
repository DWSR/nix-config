-- hammerspoon-caffeinate: menu-bar toggle
-- caffeinate.lua -- declarative caffeinate toggle delivered verbatim into the
-- generated Hammerspoon init.lua via the hammerspoon-keybindings framework's
-- `home.hammerspoon.extraConfig`. Unlike the mic-mute sibling, this chunk binds no
-- hotkey and defines no global: the logical state and the apply/paint/set helpers
-- are all chunk-local upvalues captured by the menu-bar click callback. This chunk
-- runs at load time and on every `hs.reload`; because the `hs.caffeinate` power
-- assertions are per-process and dropped on reload/quit, the init block at the
-- bottom re-asserts them from the persisted state on every load.
--
-- Object-handle rule (semantic-check constraint, empirically verified): the
-- Hammerspoon object handle is held in a plain `local` upvalue, never in a
-- nil-initialized table field. The generated LuaCATS annotation for `hs.menubar.new`
-- has an empty body and no `---@return`, so `lua-language-server` infers the handle
-- as `nil`; every method call on it (`:setTitle`, `:setTooltip`, `:setClickCallback`)
-- must therefore sit behind a non-nil guard -- the early `if not caffeineMenubar then
-- return end` in updateMenubar, or the `if caffeineMenubar then ... end` wrapping the
-- click-callback registration -- which narrows the handle and lets the member
-- resolution pass `--check`. (`hs.menubar.new` genuinely returns nil when the item
-- cannot be created, so the guards are also correct at runtime.) A nil-initialized
-- table field would instead be inferred to a concrete type and false-positive
-- `undefined-field`.

-- Logical state, persistence key, assertion set, and the menubar object handle: all
-- plain upvalues captured by the closures below (applyState, updateMenubar, setState,
-- the click callback). Hammerspoon retains the click callback for the session, so
-- these upvalues are not GC'd. `enabled` is the single source of truth; the init
-- block seeds it from the persisted setting.
local enabled
local SETTINGS_KEY = "caffeinate.enabled"
local SLEEP_TYPES = { "displayIdle", "systemIdle", "system" }

local caffeineMenubar = hs.menubar.new()

-- Apply (or clear) the full `caffeinate -dimsu`-equivalent assertion set. The three
-- types are re-asserted together on every state change and on init; passing `false`
-- clears all of them so the OS resumes its normal energy settings.
local function applyState(on)
	for _, t in ipairs(SLEEP_TYPES) do
		hs.caffeinate.set(t, on)
	end
end

-- Refresh the persistent menubar item so its title/tooltip reflect the current
-- logical state. The enabled glyph is visually distinct from the disabled glyph.
local function updateMenubar()
	if not caffeineMenubar then
		return
	end
	if enabled then
		caffeineMenubar:setTitle("☕")
		caffeineMenubar:setTooltip("Caffeinate on -- display and system sleep prevented")
	else
		caffeineMenubar:setTitle("💤")
		caffeineMenubar:setTooltip("Caffeinate off -- normal sleep")
	end
end

-- Single entry point for a state transition: update the source-of-truth flag,
-- (re-)apply the assertions, persist the new value, and repaint the indicator.
-- Deliberately silent: no `hs.alert`, notification, banner, or sound.
local function setState(on)
	enabled = on
	applyState(on)
	hs.settings.set(SETTINGS_KEY, on)
	updateMenubar()
end

-- Single click toggles directly: no `setMenu`, so there is no dropdown to open.
-- The guard narrows the plain-local handle (see the object-handle note above) and
-- also skips registration if `hs.menubar.new` returned nil.
if caffeineMenubar then
	caffeineMenubar:setClickCallback(function()
		setState(not enabled)
	end)
end

-- Init at load/reload: restore the persisted state (nil -> disabled) and re-assert,
-- since the per-process assertions are dropped on reload/restart, then paint to match.
local stored = hs.settings.get(SETTINGS_KEY)
if stored == nil then
	stored = false
end
setState(stored)
