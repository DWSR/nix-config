-- hammerspoon-brightness-ac: maximize brightness on AC power
-- brightness-ac.lua -- declarative power-source watcher delivered verbatim into the
-- generated Hammerspoon init.lua via the hammerspoon-keybindings framework's
-- `home.hammerspoon.extraConfig`. Like the caffeinate sibling, this chunk binds no
-- hotkey and defines no global: the last-seen power source and the watcher object
-- handle are chunk-local upvalues. This chunk runs at load time and on every
-- `hs.reload`; the watcher then fires its callback on every battery/power change.
--
-- Behaviour (adapted from dguo/dotfiles' init.lua): when the power source transitions
-- to "AC Power" from a non-AC source, set the built-in display brightness to maximum
-- (`hs.brightness.set(100)`). Tracking the previous source and acting only on the
-- (non-AC -> AC) edge avoids re-maxing brightness on unrelated battery events (e.g.
-- charge-level ticks) while already on AC, and on every reload.
--
-- Object-handle rule (semantic-check constraint, empirically verified): the
-- `hs.battery.watcher` handle is held in a plain `local` upvalue, never a
-- nil-initialized table field, and its `:start()` method is called behind a non-nil
-- guard. The generated LuaCATS annotation for `hs.battery.watcher.new` has an empty
-- body and no `---@return`, so `lua-language-server` infers the handle as `nil`; the
-- guard narrows it so the method call passes `--check`. (`hs.battery.watcher.new` also
-- returns nil when the watcher cannot be created, so the guard is correct at runtime.)

-- Last observed power source ("AC Power", "Battery Power", or "Off Line"), seeded from
-- the current state so the first transition is detected correctly. A plain upvalue read
-- and written by the watcher callback, which Hammerspoon retains for the session.
local lastPowerSource = hs.battery.powerSource()

-- On every power-source change, maximize brightness only on the (non-AC -> AC) edge,
-- then record the new source for the next comparison.
local function handlePowerSourceChange()
	local currentPowerSource = hs.battery.powerSource()
	if lastPowerSource ~= "AC Power" and currentPowerSource == "AC Power" then
		hs.brightness.set(100)
	end
	lastPowerSource = currentPowerSource
end

-- Plain-local handle (never a nil-init table field); guard its method call so the
-- semantic check passes and a failed creation is skipped at runtime.
local powerSourceWatcher = hs.battery.watcher.new(handlePowerSourceChange)
if powerSourceWatcher then
	powerSourceWatcher:start()
end
