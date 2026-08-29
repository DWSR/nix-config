local UPDATE_INTERVAL_SECONDS = 30
local DATE_FORMAT = "+%H:%M"
local ERROR_TIME = "--:--"
local COLUMN_PADDING = 2
local TITLE_FONT_SIZE = 10
local TITLE_LINE_HEIGHT = 10

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

local function centerText(text, width)
	local textWidth = utf8.len(text) or #text
	local padding = width - textWidth
	local leftPadding = math.floor(padding / 2)
	return string.rep(" ", leftPadding) .. text .. string.rep(" ", padding - leftPadding)
end

local function makeTitle(times)
	local labels = {}
	local values = {}
	for index, timezone in ipairs(configuredTimezones) do
		local time = times[index] or ERROR_TIME
		local columnWidth = math.max(utf8.len(timezone.label) or #timezone.label, #time) + COLUMN_PADDING
		labels[index] = centerText(timezone.label, columnWidth)
		values[index] = centerText(time, columnWidth)
	end

	local paragraphStyle = {
		alignment = "center",
		maximumLineHeight = TITLE_LINE_HEIGHT,
		minimumLineHeight = TITLE_LINE_HEIGHT,
	}
	local labelRow = hs.styledtext.new(table.concat(labels, " "), {
		font = { name = "Menlo-Bold", size = TITLE_FONT_SIZE },
		paragraphStyle = paragraphStyle,
	})
	local timeRow = hs.styledtext.new(table.concat(values, " "), {
		font = { name = "Menlo", size = TITLE_FONT_SIZE },
		paragraphStyle = paragraphStyle,
	})
	return labelRow .. "\n" .. timeRow
end

local function publishTimes(generation, times)
	if generation ~= refreshGeneration or not timezoneMenubar then
		return
	end

	timezoneMenubar:setTitle(makeTitle(times))
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
