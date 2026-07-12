local source = debug.getinfo(1, "S").source
local testDirectory = assert(source:match("^@(.*/)"), "cannot locate fake Hammerspoon test directory")
local fakeHsPath = testDirectory .. "fake-hs.lua"

local fakeEnvironment = {
	assert = assert,
	error = error,
	ipairs = ipairs,
	pairs = pairs,
	setmetatable = setmetatable,
	table = table,
	type = type,
}
local chunk, loadError = loadfile(fakeHsPath, "t", fakeEnvironment)
assert(chunk, loadError)

local loaded, FakeHs = pcall(chunk)
assert(loaded, FakeHs)
assert(type(FakeHs) == "table" and type(FakeHs.new) == "function", "fake-hs.lua must export FakeHs.new")

local fake = FakeHs.new({ now = 100, accessibilityState = false })
local hs = fake.hs
local callbackOrder = {}
local allowedHsKeys = {
	accessibilityState = true,
	alert = true,
	application = true,
	caffeinate = true,
	task = true,
	timer = true,
}
for key in pairs(hs) do
	assert(allowedHsKeys[key], "unexpected Hammerspoon API family: " .. key)
end
for key in pairs(allowedHsKeys) do
	assert(hs[key] ~= nil, "missing Hammerspoon API family: " .. key)
end

assert(hs.accessibilityState() == false)
fake:setAccessibilityState(true)
assert(hs.accessibilityState() == true)

local repeatingTimer = hs.timer.doEvery(2, function()
	table.insert(callbackOrder, "repeat@" .. fake:time())
end)
hs.timer.doAfter(4, function()
	table.insert(callbackOrder, "after@" .. fake:time())
end)
local stoppedTimer = hs.timer.doAfter(1, function()
	error("a stopped timer must not fire")
end)
stoppedTimer:stop()

fake:advance(1)
assert(#callbackOrder == 0, "advance must not fire future or stopped timers")
fake:advance(3)
assert(callbackOrder[1] == "repeat@102", "repeating timer must fire at its first deadline")
assert(callbackOrder[2] == "repeat@104", "equal-deadline timers must fire in creation order")
assert(callbackOrder[3] == "after@104", "one-shot timer must fire at its deadline")
repeatingTimer:stop()
fake:advance(4)
assert(#callbackOrder == 3, "stopped repeating timer must not fire again")

local taskResult
local task = hs.task.new("/nix/store/snapshot", function(exitCode, stdout, stderr)
	taskResult = { exitCode, stdout, stderr, at = fake:time() }
	table.insert(callbackOrder, "task")
end, { "--fixture" })
assert(task:start() == task and task:isRunning(), "task start must return a running handle")
assert(#fake:runningTasks() == 1 and fake:runningTasks()[1] == task, "running tasks must be inspectable")
assert(taskResult == nil, "task callback must wait for explicit completion")
assert(fake:completeTask(task, 0, "snapshot\n", "") == true)
assert(taskResult[1] == 0 and taskResult[2] == "snapshot\n" and taskResult[3] == "")
assert(taskResult.at == 108 and not task:isRunning(), "task completion must use deterministic harness time")
assert(#fake:runningTasks() == 0, "completed tasks must leave the running set")

local terminatedCallbackRan = false
local terminatedTask = hs.task.new("/nix/store/surface-gui", function()
	terminatedCallbackRan = true
end)
terminatedTask:start()
terminatedTask:terminate()
assert(fake:completeTask(terminatedTask, 0, "", "") == false)
assert(not terminatedCallbackRan, "terminated task must reject later completion")

fake:setBundleInfo("/Applications/Deskflow.app", {
	CFBundleIdentifier = "org.deskflow.deskflow",
	CFBundleExecutable = "Deskflow",
})
local editor = fake:addApplication({
	bundleID = "com.example.editor",
	path = "/Applications/Editor.app",
	pid = 10,
	frontmost = true,
})
local deskflow = fake:addApplication({
	bundleID = "org.deskflow.deskflow",
	path = "/Applications/Deskflow.app",
	pid = 20,
	menuItems = { { AXTitle = "File" } },
	menuSelectionResult = true,
})
fake:addApplication({
	bundleID = "org.deskflow.deskflow",
	path = "/Applications/Deskflow Preview.app",
	pid = 21,
})

local deskflowApplications = hs.application.applicationsForBundleID("org.deskflow.deskflow")
assert(#deskflowApplications == 2, "application lookup must preserve full bundle-ID cardinality")
assert(deskflowApplications[1]:pid() == 20 and deskflowApplications[2]:pid() == 21)
assert(hs.application.frontmostApplication() == editor and editor:isFrontmost())
assert(hs.application.infoForBundlePath("/Applications/Deskflow.app").CFBundleIdentifier == "org.deskflow.deskflow")

local menuItems
deskflow:getMenuItems(function(items)
	menuItems = items
	table.insert(callbackOrder, "menu")
end)
assert(menuItems == nil and fake:pendingMenuCount() == 1, "menu callback must remain explicitly controllable")
assert(fake:completeNextMenu() == true)
assert(menuItems[1].AXTitle == "File" and fake:pendingMenuCount() == 0)
assert(deskflow:selectMenuItem({ "File", "Start" }) == true)

fake:setLaunchResult("org.deskflow.deskflow", true)
assert(hs.application.launchOrFocusByBundleID("org.deskflow.deskflow") == true)
assert(deskflow:activate() == true)
assert(hs.application.frontmostApplication() == deskflow and deskflow:isFrontmost() and not editor:isFrontmost())
editor:activate()
assert(hs.application.frontmostApplication() == editor, "activation must make focus restoration observable")

local lifecycleEvents = {}
local watcher = hs.caffeinate.watcher
	.new(function(event)
		table.insert(lifecycleEvents, event)
		table.insert(callbackOrder, "lifecycle:" .. event)
	end)
	:start()
fake:fireLifecycle(hs.caffeinate.watcher.systemWillSleep)
fake:fireLifecycle(hs.caffeinate.watcher.systemDidWake)
assert(lifecycleEvents[1] == "systemWillSleep" and lifecycleEvents[2] == "systemDidWake")
watcher:stop()
fake:fireLifecycle(hs.caffeinate.watcher.systemDidWake)
assert(#lifecycleEvents == 2, "stopped lifecycle watcher must not receive events")

local alertID = hs.alert.show("Deskflow recovery unavailable")
assert(alertID == "alert-1", "alerts must return deterministic handles")

local timerCallbacks = fake:effectsOf("timer.callback")
assert(#timerCallbacks == 3)
assert(timerCallbacks[1].at == 102 and timerCallbacks[2].at == 104 and timerCallbacks[3].at == 104)
assert(timerCallbacks[2].handle < timerCallbacks[3].handle, "equal-deadline callback order must be stable")
assert(#fake:effectsOf("task.callback") == 1, "only the completed task may invoke a callback")
assert(#fake:effectsOf("task.terminate") == 1, "task termination must remain observable")
assert(#fake:effectsOf("menu.callback") == 1)
assert(#fake:effectsOf("menu.request") == 1)
assert(#fake:effectsOf("lifecycle.callback") == 2)
assert(#fake:effectsOf("lifecycle.event") == 3)
assert(#fake:effectsOf("application.launch") == 1)
assert(#fake:effectsOf("application.activate") == 2)
assert(#fake:effectsOf("menu.select") == 1)
assert(#fake:effectsOf("alert.show") == 1)
assert(#callbackOrder == 7 and callbackOrder[4] == "task" and callbackOrder[5] == "menu")
assert(callbackOrder[6] == "lifecycle:systemWillSleep" and callbackOrder[7] == "lifecycle:systemDidWake")

local effects = fake.effects
for index = 2, #effects do
	assert(effects[index - 1].sequence < effects[index].sequence, "effects must retain total callback/effect order")
end

print("fake Hammerspoon harness smoke test passed")
