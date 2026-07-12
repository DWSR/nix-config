local source = debug.getinfo(1, "S").source
local testDirectory = assert(source:match("^@(.*/)"), "cannot locate runtime test directory")
local runtimePath = testDirectory .. "../../home-manager/common/hammerspoon-deskflow-watchdog/runtime.lua"
local modelPath = testDirectory .. "../../home-manager/common/hammerspoon-deskflow-watchdog/model.lua"
local fakeHsPath = testDirectory .. "fake-hs.lua"
local fixturePath = testDirectory .. "fixtures.lua"

local function loadModule(path, environment)
	local chunk, loadError = loadfile(path, "t", environment)
	assert(chunk, loadError)
	local loaded, module = pcall(chunk)
	assert(loaded, module)
	return module
end

local model = loadModule(modelPath, {
	ipairs = ipairs,
	math = math,
	pairs = pairs,
	string = string,
	table = table,
	tonumber = tonumber,
	type = type,
})
local FakeHs = loadModule(fakeHsPath, {
	assert = assert,
	error = error,
	ipairs = ipairs,
	pairs = pairs,
	setmetatable = setmetatable,
	table = table,
	type = type,
})
local fixtures = loadModule(fixturePath, {})

local snapshotCommand = "/nix/store/deskflow-process-snapshot/bin/deskflow-process-snapshot"
local bundleID = "org.deskflow.deskflow"
local testCount = 0

local function test(name, body)
	local passed, failure = pcall(body)
	if not passed then
		error(name .. ": " .. tostring(failure), 0)
	end
	testCount = testCount + 1
end

local function assertEqual(actual, expected, context)
	assert(actual == expected, context .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual))
end

local function newRuntime(fake, selectedModel)
	return loadModule(runtimePath, {
		assert = assert,
		hs = fake.hs,
		ipairs = ipairs,
		pairs = pairs,
		table = table,
		type = type,
	}).start(selectedModel or model, "server", snapshotCommand)
end

local function addDeskflow(fake, pid, path)
	return fake:addApplication({
		bundleID = bundleID,
		path = path or fixtures.constants.bundlePath,
		pid = pid,
	})
end

local function completeObservation(fake, exitCode, stdout, stderr)
	local running = fake:runningTasks()
	assertEqual(#running, 1, "running observation count")
	assert(fake:completeTask(running[1], exitCode or 0, stdout or "", stderr or ""))
end

local function assertOnlySnapshotTasks(fake, context)
	local tasks = fake:effectsOf("task.new")
	assert(#tasks > 0, context .. " must create snapshot tasks")
	for _, task in ipairs(tasks) do
		assertEqual(task.path, snapshotCommand, context .. " task path")
		assertEqual(#task.arguments, 0, context .. " task argument count")
	end
	assertEqual(#fake:effectsOf("task.terminate"), 0, context .. " task termination count")
end

local function assertNoRecoveryEffects(fake, context)
	for _, kind in ipairs({
		"application.launch",
		"application.activate",
		"menu.request",
		"menu.select",
		"task.terminate",
	}) do
		assertEqual(#fake:effectsOf(kind), 0, context .. " " .. kind .. " count")
	end
end

local function advanceAndComplete(fake, stdout, exitCode, stderr)
	fake:advance(5)
	completeObservation(fake, exitCode, stdout, stderr)
end

test("polls only the rendered helper and prevents overlapping healthy observations", function()
	local fake = FakeHs.new()
	addDeskflow(fake, 4200)
	local controller = newRuntime(fake)
	assert(type(controller) == "table", "Runtime.start must return a controller")
	local started = controller:inspect()
	assert(started.pollTimerRunning, "controller must retain its running poll timer")
	assert(started.lifecycleWatcherRunning, "controller must retain its lifecycle watcher")
	assertEqual(started.delayedTimerCount, 0, "initial delayed timer count")
	assertEqual(#fake:runningTasks(), 0, "observations before first poll")

	fake:advance(5)
	assertEqual(#fake:runningTasks(), 1, "first poll observation count")
	assert(controller:inspect().observationInFlight, "controller must retain an active observation")
	fake:advance(5)
	assertEqual(#fake:effectsOf("task.new"), 1, "overlapping poll task count")
	completeObservation(fake, 0, fixtures.process.healthyServer.snapshot, "")

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "grace", "healthy startup phase")
	assertEqual(inspection.persistentAlertKey, nil, "healthy alert key")
	assert(not inspection.observationInFlight, "completed observation must release its handle")
	fake:advance(5)
	assertEqual(#fake:runningTasks(), 1, "next eligible poll observation count")
	assertOnlySnapshotTasks(fake, "healthy polling")
	assertNoRecoveryEffects(fake, "healthy polling")
	controller:stop()
end)

test("passes the complete bundle-ID GUI inventory to classification and fails closed", function()
	local fake = FakeHs.new()
	addDeskflow(fake, 4800)
	addDeskflow(fake, 4802, "/Applications/Deskflow Preview.app")
	local classificationCalls = {}
	local spyingModel = {}
	for key, value in pairs(model) do
		spyingModel[key] = value
	end
	function spyingModel.classify(records, guiRecords, expected)
		table.insert(classificationCalls, {
			expected = expected,
			guiRecords = guiRecords,
			records = records,
		})
		return model.classify(records, guiRecords, expected)
	end

	local controller = newRuntime(fake, spyingModel)
	for _ = 1, 3 do
		advanceAndComplete(fake, fixtures.process.duplicateGui.snapshot)
	end

	local latest = classificationCalls[#classificationCalls]
	assertEqual(#latest.guiRecords, 2, "classified GUI cardinality")
	assertEqual(latest.guiRecords[1].pid, 4800, "first classified GUI PID")
	assertEqual(latest.guiRecords[1].bundlePath, fixtures.constants.bundlePath, "first classified GUI path")
	assertEqual(latest.guiRecords[2].pid, 4802, "second classified GUI PID")
	assertEqual(latest.guiRecords[2].bundlePath, "/Applications/Deskflow Preview.app", "second GUI path")
	assertEqual(latest.expected.role, "server", "classified role")
	assertEqual(controller:inspect().persistentAlertKey, "ambiguous:gui-cardinality", "GUI ambiguity key")
	assertNoRecoveryEffects(fake, "ambiguous GUI inventory")
	controller:stop()
end)

test("maps helper exit and parse failures to inventory errors without recovery", function()
	local cases = {
		{
			name = "nonzero helper exit",
			exitCode = 1,
			stdout = fixtures.process.healthyServer.snapshot,
			expectedKey = "error:snapshot-command",
		},
		{
			name = "malformed helper output",
			exitCode = 0,
			stdout = "not-a-snapshot\n",
			expectedKey = "error:snapshot-parse",
		},
	}

	for _, case in ipairs(cases) do
		local fake = FakeHs.new()
		addDeskflow(fake, 4200)
		local controller = newRuntime(fake)
		for _ = 1, 3 do
			advanceAndComplete(fake, case.stdout, case.exitCode, "fixture error")
		end
		assertEqual(controller:inspect().persistentAlertKey, case.expectedKey, case.name .. " key")
		assertOnlySnapshotTasks(fake, case.name)
		assertNoRecoveryEffects(fake, case.name)
		controller:stop()
	end
end)

test("suspends polling across sleep and starts fresh wake grace evidence", function()
	local fake = FakeHs.new()
	addDeskflow(fake, 4300)
	local controller = newRuntime(fake)
	advanceAndComplete(fake, fixtures.process.absent.snapshot)
	advanceAndComplete(fake, fixtures.process.absent.snapshot)
	advanceAndComplete(fake, fixtures.process.absent.snapshot)
	assertEqual(controller:inspect().absenceCount, 1, "pre-sleep absence evidence")

	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
	local sleeping = controller:inspect()
	assertEqual(sleeping.phase, "sleeping", "sleep phase")
	assert(sleeping.sleeping, "controller sleep flag")
	local taskCount = #fake:effectsOf("task.new")
	fake:advance(20)
	assertEqual(#fake:effectsOf("task.new"), taskCount, "sleeping task count")

	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemDidWake)
	local waking = controller:inspect()
	assertEqual(waking.phase, "grace", "wake phase")
	assertEqual(waking.graceUntil, 50, "wake grace deadline")
	assertEqual(waking.absenceCount, 0, "wake absence reset")
	assert(not waking.sleeping, "controller wake flag")

	advanceAndComplete(fake, fixtures.process.absent.snapshot)
	advanceAndComplete(fake, fixtures.process.absent.snapshot)
	assertEqual(controller:inspect().absenceCount, 0, "wake grace absence evidence")
	advanceAndComplete(fake, fixtures.process.absent.snapshot)
	assertEqual(controller:inspect().absenceCount, 1, "first post-grace absence evidence")
	assertNoRecoveryEffects(fake, "sleep and wake")
	controller:stop()
end)

test("stale callbacks after epoch changes and reload release handles without effects", function()
	local fake = FakeHs.new()
	addDeskflow(fake, 4300)
	local controller = newRuntime(fake)
	fake:advance(5)
	local staleTask = fake:runningTasks()[1]
	local initialEpoch = controller:inspect().epoch
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemDidWake)
	assert(controller:inspect().epoch > initialEpoch, "sleep and wake must invalidate callback epochs")
	assert(fake:completeTask(staleTask, 0, fixtures.process.absent.snapshot, ""))
	local afterStale = controller:inspect()
	assertEqual(afterStale.phase, "grace", "stale callback phase")
	assertEqual(afterStale.lastTimestamp, 5, "stale callback timestamp")
	assert(not afterStale.observationInFlight, "stale callback must release the observation handle")
	fake:advance(5)
	assertEqual(#fake:runningTasks(), 1, "post-stale observation count")
	controller:stop()

	local reloadFake = FakeHs.new()
	addDeskflow(reloadFake, 4300)
	local reloaded = newRuntime(reloadFake)
	reloadFake:advance(5)
	local reloadTask = reloadFake:runningTasks()[1]
	reloaded:stop()
	assert(reloadFake:completeTask(reloadTask, 0, fixtures.process.absent.snapshot, ""))
	local stopped = reloaded:inspect()
	assert(stopped.stopped, "controller must retain reload stop state")
	assertEqual(stopped.phase, "grace", "reload-stale callback phase")
	assertEqual(stopped.lastTimestamp, 0, "reload-stale callback timestamp")
	assert(not stopped.observationInFlight, "reload-stale callback must release its handle")
	local stoppedTaskCount = #reloadFake:effectsOf("task.new")
	reloadFake:fireLifecycle(reloadFake.hs.caffeinate.watcher.systemDidWake)
	reloadFake:advance(10)
	assertEqual(#reloadFake:effectsOf("task.new"), stoppedTaskCount, "stopped controller task count")
	assertNoRecoveryEffects(reloadFake, "reload-stale callback")
end)

print("runtime tests passed: " .. testCount)
