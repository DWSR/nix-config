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
assert(menubar.title:getString() == " Toronto    UTC    Vancouver \n  12:34    16:34     09:34   ")
assert(#menubar.title.segments == 3)
assert(menubar.title.segments[1].attributes.font.name == "Menlo-Bold")
assert(menubar.title.segments[1].attributes.font.size == 10)
assert(menubar.title.segments[1].attributes.paragraphStyle.alignment == "center")
assert(menubar.title.segments[1].attributes.paragraphStyle.minimumLineHeight == 10)
assert(menubar.title.segments[2].text == "\n")
assert(menubar.title.segments[3].attributes.font.name == "Menlo")
assert(menubar.title.segments[3].attributes.font.size == 10)

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
assert(
	menubar.title:getString() == " Toronto    UTC    Vancouver \n  12:34    16:34     09:34   ",
	"stale refresh overwrote the current title"
)

currentTasks[1]:complete(0, "12:35\n")
currentTasks[2]:complete(1, "")
currentTasks[3]:complete(0, "09:35\n")
assert(menubar.title:getString() == " Toronto    UTC    Vancouver \n  12:35    --:--     09:35   ")

hs._failStarts["Etc/UTC"] = true
timer.callback()
assert(#hs._tasks == 11, "failed date task should not enter the active task list")
hs._tasks[10]:complete(0, "12:36\n")
hs._tasks[11]:complete(0, "09:36\n")
assert(menubar.title:getString() == " Toronto    UTC    Vancouver \n  12:36    --:--     09:36   ")
