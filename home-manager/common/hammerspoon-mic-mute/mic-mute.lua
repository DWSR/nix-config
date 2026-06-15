-- mic-mute.lua -- microphone mute toggle delivered verbatim into the generated
-- Hammerspoon init.lua via the hammerspoon-keybindings framework's
-- `home.hammerspoon.extraConfig`. The rendered framework emits this chunk before the
-- keybinding binds, so the bottom-of-file global `micMuteToggle()` is in scope for the
-- bind's inline-Lua action. This chunk runs at load time and on every `hs.reload`.
--
-- Object-handle rule (semantic-check constraint, empirically verified): every
-- Hammerspoon object handle is held in a plain `local` upvalue, never in a
-- nil-initialized table field. The generated LuaCATS annotations carry no
-- `---@return` for `hs.menubar.new` or `hs.audiodevice.defaultInputDevice`, so a plain
-- local stays untyped and its method calls pass `lua-language-server --check`; a table
-- field would be inferred to a concrete type and false-positive `undefined-field`.

-- Logical mute state (scalars) and the menubar object handle: all plain upvalues
-- captured by the closures below (micMuteToggle, updateMenubar, the watcher callback).
-- Hammerspoon retains those closures for the session, so these upvalues are not GC'd.
local muted = false
local fallbackActive = false
local preMuteVolume = nil

local micMenubar = hs.menubar.new()

-- Restore level used on an unmute when no pre-mute level was captured (e.g. the first
-- unmute after a reload on a device that mutes via the volume fallback).
local DEFAULT_INPUT_VOLUME = 75

-- Refresh the persistent menubar item so its title/tooltip reflect the current logical
-- state. The muted glyph is distinct from the unmuted glyph (Requirement 3.3).
local function updateMenubar()
	if not micMenubar then
		return
	end
	if muted then
		micMenubar:setTitle("🔇")
		if fallbackActive then
			micMenubar:setTooltip("Microphone muted (volume fallback)")
		else
			micMenubar:setTooltip("Microphone muted")
		end
	else
		micMenubar:setTitle("🎙")
		micMenubar:setTooltip("Microphone live")
	end
end

-- Re-derive the logical state from the system default input device. The device's
-- hardware `inputMuted()` is authoritative when non-nil; otherwise (no device, or a
-- device without a hardware mute) the indicator shows unmuted and the volume-fallback
-- bookkeeping is cleared.
local function resyncFromDefaultDevice()
	local dev = hs.audiodevice.defaultInputDevice()
	if dev then
		local hwMuted = dev:inputMuted()
		if hwMuted ~= nil then
			muted = hwMuted
		else
			muted = false
		end
	else
		muted = false
	end
	fallbackActive = false
	preMuteVolume = nil
end

-- Global (not local) so the rendered bind's inline action `micMuteToggle()` resolves
-- and the semantic check sees it defined. Toggles the *current* default input device's
-- mute on every fire; resolves the device fresh each call and never caches a handle.
function micMuteToggle()
	local dev = hs.audiodevice.defaultInputDevice()
	if not dev then
		hs.alert.show("Mic mute: no input device")
		return
	end

	local target = not muted

	-- Prefer the hardware mute. `setInputMuted` returns false when the device has no
	-- hardware mute control; fall back to the input volume in that case: cache the
	-- pre-mute level when muting, restore it when unmuting.
	if dev:setInputMuted(target) then
		fallbackActive = false
	else
		fallbackActive = true
		if target then
			preMuteVolume = dev:inputVolume()
			dev:setInputVolume(0)
		else
			dev:setInputVolume(preMuteVolume or DEFAULT_INPUT_VOLUME)
			preMuteVolume = nil
		end
	end

	muted = target

	local label = dev:name() or "default input"
	if muted then
		hs.alert.show("🔇 Microphone muted (" .. label .. ")")
	else
		hs.alert.show("🎙 Microphone unmuted (" .. label .. ")")
	end

	updateMenubar()
end

-- Follow the system default input device: the module-level audiodevice watcher fires
-- its callback with a 4-char event string; "dIn " (trailing space) is "default input
-- changed". On that event, resync logical state from the new default and repaint.
hs.audiodevice.watcher.setCallback(function(event)
	if event == "dIn " then
		resyncFromDefaultDevice()
		updateMenubar()
	end
end)
hs.audiodevice.watcher.start()

-- Initial paint at load/reload: reflect the current default input device's state.
resyncFromDefaultDevice()
updateMenubar()
