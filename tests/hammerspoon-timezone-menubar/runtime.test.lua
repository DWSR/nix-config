local fakeHsPath, renderedConfigPath = ...
assert(fakeHsPath and renderedConfigPath, "usage: runtime.test.lua <fake-hs.lua> <rendered.lua>")

hs = dofile(fakeHsPath)
dofile(renderedConfigPath)

local menubar = assert(hs._menubars[1], "timezone menubar was not created")
local retainedState = assert(hammerspoonTimezoneMenubar, "long-lived objects were not retained")
assert(#hs._menubars == 1)
assert(retainedState.menubar == menubar)
assert(type(retainedState.activeTasks) == "table")
assert(menubar.inMenuBar == true)
assert(menubar.autosaveName == "hammerspoon-timezone-menubar")
assert(menubar.title == "World clocks...")
assert(menubar.tooltip == "World clocks: America/Toronto, Etc/UTC, America/Vancouver")

local function assertTask(task, timeZone)
	assert(task.path == "/bin/date")
	assert(#task.arguments == 1 and task.arguments[1] == "+%H:%M")
	assert(task.environment.LC_ALL == "C")
	assert(task.environment.TZ == timeZone)
end

assert(#hs._tasks == 3)
assertTask(hs._tasks[1], "America/Toronto")
assertTask(hs._tasks[2], "Etc/UTC")
assertTask(hs._tasks[3], "America/Vancouver")

hs._tasks[3]:complete(0, "09:34\n")
hs._tasks[2]:complete(0, "16:34\n")
assert(menubar.title == "World clocks...", "partial refresh published mixed results")
hs._tasks[1]:complete(0, "12:34\n")
assert(menubar.title == nil)
assert(menubar.iconTemplate == true)
local firstImage = assert(menubar.icon)
assert(retainedState.image == firstImage)
assert(firstImage.frame.x == 0 and firstImage.frame.y == 0)
assert(firstImage.frame.w == 150 and firstImage.frame.h == 22)
assert(#firstImage.elements == 6)

local function assertTextElement(element, text, x, y, bold)
	assert(element.type == "text")
	assert(element.frame.x == x and element.frame.y == y)
	assert(element.frame.w == 50 and element.frame.h == 11)
	assert(element.text:getString() == text)
	local attributes = element.text.segments[1].attributes
	assert(attributes.color.white == 0)
	assert(attributes.font.size == 10)
	assert((attributes.font.name == "System-Bold") == bold)
	assert(attributes.paragraphStyle.alignment == "center")
	assert(attributes.paragraphStyle.lineBreak == "clip")
end

assertTextElement(firstImage.elements[1], "Toronto", 0, 0, true)
assertTextElement(firstImage.elements[2], "12:34", 0, 10, false)
assertTextElement(firstImage.elements[3], "UTC", 50, 0, true)
assertTextElement(firstImage.elements[4], "16:34", 50, 10, false)
assertTextElement(firstImage.elements[5], "Vancouver", 100, 0, true)
assertTextElement(firstImage.elements[6], "09:34", 100, 10, false)
assert(#hs._canvases == 1 and hs._canvases[1].deleted == true)

local timer = assert(hs._timers[1], "refresh timer was not created")
assert(#hs._timers == 1)
assert(timer.interval == 30)
assert(retainedState.refreshTimer == timer)

timer.callback()
local staleTasks = { hs._tasks[4], hs._tasks[5], hs._tasks[6] }
timer.callback()
local currentTasks = { hs._tasks[7], hs._tasks[8], hs._tasks[9] }

for _, task in ipairs(staleTasks) do
	task:complete(0, "01:01\n")
end
assert(menubar.icon == firstImage, "stale refresh overwrote the current image")

currentTasks[1]:complete(0, "12:35\n")
currentTasks[2]:complete(1, "")
currentTasks[3]:complete(0, "09:35\n")
assertTextElement(menubar.icon.elements[2], "12:35", 0, 10, false)
assertTextElement(menubar.icon.elements[4], "--:--", 50, 10, false)
assertTextElement(menubar.icon.elements[6], "09:35", 100, 10, false)

hs._failStarts["Etc/UTC"] = true
timer.callback()
assert(#hs._tasks == 11, "failed date task should not enter the active task list")
hs._tasks[10]:complete(0, "12:36\n")
hs._tasks[11]:complete(0, "09:36\n")
assertTextElement(menubar.icon.elements[2], "12:36", 0, 10, false)
assertTextElement(menubar.icon.elements[4], "--:--", 50, 10, false)
assertTextElement(menubar.icon.elements[6], "09:36", 100, 10, false)
