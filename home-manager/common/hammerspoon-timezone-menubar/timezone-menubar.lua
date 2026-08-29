local UPDATE_INTERVAL_SECONDS = 30
local DATE_FORMAT = "+%H:%M"
local ERROR_TIME = "--:--"
local COLUMN_WIDTH = 50
local CLOCK_HEIGHT = 22
local LABEL_Y = 0
local TIME_Y = 10
local TITLE_FONT_SIZE = 10

local timezoneMenubar = hs.menubar.new(true, "hammerspoon-timezone-menubar")
local refreshGeneration = 0
local activeTasks = {}
local retainedState = {
	activeTasks = activeTasks,
	menubar = timezoneMenubar,
}

-- Hammerspoon collects init.lua locals after the chunk returns. Keep every
-- long-lived object reachable for the lifetime of this Lua state.
rawset(_G, "hammerspoonTimezoneMenubar", retainedState)

local function makeClockImage(times)
	local paragraphStyle = { alignment = "center", lineBreak = "clip" }
	local timeFont = { size = TITLE_FONT_SIZE }
	local labelFont = hs.styledtext.convertFont(timeFont, true)
	local elements = {}
	for index, timezone in ipairs(configuredTimezones) do
		local x = (index - 1) * COLUMN_WIDTH
		elements[#elements + 1] = {
			frame = { x = x, y = LABEL_Y, w = COLUMN_WIDTH, h = 11 },
			text = hs.styledtext.new(timezone.label, {
				color = { white = 0 },
				font = labelFont,
				paragraphStyle = paragraphStyle,
			}),
			type = "text",
		}
		elements[#elements + 1] = {
			frame = { x = x, y = TIME_Y, w = COLUMN_WIDTH, h = 11 },
			text = hs.styledtext.new(times[index] or ERROR_TIME, {
				color = { white = 0 },
				font = timeFont,
				paragraphStyle = paragraphStyle,
			}),
			type = "text",
		}
	end

	local clockCanvas = hs.canvas.new({
		x = 0,
		y = 0,
		w = #configuredTimezones * COLUMN_WIDTH,
		h = CLOCK_HEIGHT,
	})
	if not clockCanvas then
		return nil
	end
	clockCanvas:appendElements(table.unpack(elements))
	local image = clockCanvas:imageFromCanvas()
	clockCanvas:delete()
	return image
end

local function publishTimes(generation, times)
	if generation ~= refreshGeneration or not timezoneMenubar then
		return
	end

	local image = makeClockImage(times)
	if image then
		timezoneMenubar:setTitle(nil)
		timezoneMenubar:setIcon(image, true)
		retainedState.image = image
	end
end

local function refreshTimes()
	refreshGeneration = refreshGeneration + 1
	local generation = refreshGeneration
	local remaining = #configuredTimezones
	local times = {}

	local function finish(index, taskKey, exitCode, stdOut)
		activeTasks[taskKey] = nil
		local time = (stdOut or ""):gsub("%s+$", "")
		if exitCode ~= 0 or time == "" then
			time = ERROR_TIME
		end
		times[index] = time
		remaining = remaining - 1
		if remaining == 0 then
			publishTimes(generation, times)
		end
	end

	for index, timezone in ipairs(configuredTimezones) do
		local taskKey = generation .. ":" .. index
		local task = hs.task.new("/bin/date", function(exitCode, stdOut, _)
			finish(index, taskKey, exitCode, stdOut)
		end, { DATE_FORMAT })

		if not task then
			finish(index, taskKey, 1, "")
		else
			activeTasks[taskKey] = task
			local environmentSet = task:setEnvironment({
				LC_ALL = "C",
				TZ = timezone.timeZone,
			})
			if not environmentSet or not task:start() then
				finish(index, taskKey, 1, "")
			end
		end
	end
end

if timezoneMenubar then
	timezoneMenubar:setTitle("World clocks...")
	local timezoneNames = {}
	for index, timezone in ipairs(configuredTimezones) do
		timezoneNames[index] = timezone.timeZone
	end
	timezoneMenubar:setTooltip("World clocks: " .. table.concat(timezoneNames, ", "))
end

refreshTimes()
local timezoneRefreshTimer = hs.timer.doEvery(UPDATE_INTERVAL_SECONDS, refreshTimes)
retainedState.refreshTimer = timezoneRefreshTimer
