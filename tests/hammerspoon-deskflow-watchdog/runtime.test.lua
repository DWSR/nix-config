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
local guiExecutablePath = "/Applications/Deskflow.app/Contents/MacOS/Deskflow"
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

local function addFrontmostApplication(fake, pid)
	return fake:addApplication({
		bundleID = "com.example.previous",
		frontmost = true,
		path = "/Applications/Previous.app",
		pid = pid,
	})
end

local function configureDeskflowBundle(fake)
	fake:setBundleInfo(fixtures.constants.bundlePath, {
		CFBundleExecutable = "Deskflow",
		CFBundleIdentifier = bundleID,
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

local function triggerRecovery(fake, stdout)
	for _ = 1, 4 do
		advanceAndComplete(fake, stdout or "")
	end
end

local function assertActivationResult(controller, kind, reason, context)
	local result = controller:inspect().activationResult
	assert(type(result) == "table", context .. " activation result")
	assertEqual(result.kind, kind, context .. " activation result kind")
	if reason ~= nil then
		assertEqual(result.reason, reason, context .. " activation result reason")
	end
end

local function assertNoMenuOrDirectActivation(fake, context)
	assertEqual(#fake:effectsOf("menu.request"), 0, context .. " menu request count")
	assertEqual(#fake:effectsOf("menu.select"), 0, context .. " menu selection count")
	assertEqual(#fake:effectsOf("application.activate"), 0, context .. " direct activation count")
end

local function startHiddenRecoveryObservation(fake, previousPID, deskflowPID)
	configureDeskflowBundle(fake)
	addFrontmostApplication(fake, previousPID)
	local deskflow = addDeskflow(fake, deskflowPID)
	local controller = newRuntime(fake)
	triggerRecovery(fake)
	local surfaceTask = fake:runningTasks(guiExecutablePath)[1]
	assert(surfaceTask, "pending-snapshot surface task")
	fake:setFrontmostApplication(deskflow)
	assert(fake:completeTask(surfaceTask, 0, "", ""), "pending-snapshot surface completion")
	assertEqual(#fake:runningTasks(snapshotCommand), 1, "pending recovery snapshot count")
	return controller, deskflow
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

test("launches an absent GUI through LaunchServices and records a selecting result", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	local previous = addFrontmostApplication(fake, 5100)
	local deskflow = fake:addApplication({
		bundleID = bundleID,
		path = fixtures.constants.bundlePath,
		pid = 5200,
		running = false,
	})
	fake:setLaunchResult(bundleID, true, deskflow)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	assertEqual(#fake:effectsOf("application.launch"), 1, "absent GUI launch count")
	assert(deskflow:isRunning() and deskflow:isFrontmost(), "LaunchServices must make the absent GUI available")
	completeObservation(fake, 0, "", "")

	assertActivationResult(controller, "ready", nil, "absent GUI")
	local inspection = controller:inspect()
	assertEqual(inspection.phase, "selecting", "absent GUI recovery phase")
	assertEqual(inspection.priorFocusPID, previous:pid(), "absent GUI prior focus")
	assertEqual(inspection.recoveryApplicationPID, deskflow:pid(), "absent GUI recovery application")
	assertEqual(#fake:runningTasks(guiExecutablePath), 0, "absent GUI surface task count")
	assertNoMenuOrDirectActivation(fake, "absent GUI")
	controller:stop()
end)

test("surfaces a hidden GUI through one duplicate-instance binary task", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	local previous = addFrontmostApplication(fake, 5300)
	local deskflow = addDeskflow(fake, 5400)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	local surfaceTasks = fake:runningTasks(guiExecutablePath)
	assertEqual(#surfaceTasks, 1, "hidden GUI surface task count")
	local surfaceEffects = fake:effectsOf("task.new")
	local surfaceEffect = surfaceEffects[#surfaceEffects]
	assertEqual(surfaceEffect.path, guiExecutablePath, "hidden GUI surface path")
	assertEqual(#surfaceEffect.arguments, 0, "hidden GUI surface argument count")
	assertEqual(#fake:effectsOf("application.launch"), 0, "hidden GUI launch count")

	fake:setFrontmostApplication(deskflow)
	assert(fake:completeTask(surfaceTasks[1], 0, "", ""))
	completeObservation(fake, 0, "", "")

	assertActivationResult(controller, "ready", nil, "hidden GUI")
	local inspection = controller:inspect()
	assertEqual(inspection.phase, "selecting", "hidden GUI recovery phase")
	assertEqual(inspection.priorFocusPID, previous:pid(), "hidden GUI prior focus")
	assertNoMenuOrDirectActivation(fake, "hidden GUI")
	controller:stop()
end)

test("polls delayed frontmost activation every 250 milliseconds", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	addFrontmostApplication(fake, 5500)
	local deskflow = addDeskflow(fake, 5600)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	local surfaceTask = fake:runningTasks(guiExecutablePath)[1]
	assert(surfaceTask, "delayed activation surface task")
	assert(fake:completeTask(surfaceTask, 0, "", ""))
	assertEqual(controller:inspect().delayedTimerCount, 1, "delayed activation timer count")
	fake:advance(0.75)
	assertEqual(#fake:runningTasks(snapshotCommand), 0, "pre-activation recovery observation count")
	fake:setFrontmostApplication(deskflow)
	fake:advance(0.25)
	assertEqual(#fake:runningTasks(snapshotCommand), 1, "post-activation recovery observation count")
	completeObservation(fake, 0, "", "")

	assertActivationResult(controller, "ready", nil, "delayed activation")
	assertEqual(controller:inspect().delayedTimerCount, 0, "completed activation timer count")
	local activationCallbacks = {}
	for _, effect in ipairs(fake:effectsOf("timer.callback")) do
		if effect.at > 20 and effect.at <= 21 then
			table.insert(activationCallbacks, effect)
		end
	end
	assertEqual(#activationCallbacks, 4, "250ms activation callback count")
	assertNoMenuOrDirectActivation(fake, "delayed activation")
	controller:stop()
end)

test("records activation timeout after ten seconds without restoring focus early", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	local previous = addFrontmostApplication(fake, 5700)
	addDeskflow(fake, 5800)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	local surfaceTask = fake:runningTasks(guiExecutablePath)[1]
	assert(surfaceTask and fake:completeTask(surfaceTask, 0, "", ""), "timeout surface task completion")
	fake:advance(10)

	assertActivationResult(controller, "failed", "gui-activation-timeout", "activation timeout")
	local inspection = controller:inspect()
	assertEqual(inspection.phase, "activating", "activation timeout model phase")
	assertEqual(inspection.priorFocusPID, previous:pid(), "activation timeout prior focus")
	assertEqual(inspection.delayedTimerCount, 0, "activation timeout timer count")
	assertNoMenuOrDirectActivation(fake, "activation timeout")
	controller:stop()
end)

test("fails ambiguous when a wrong-path GUI appears during activation", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	addFrontmostApplication(fake, 5900)
	fake:setLaunchResult(bundleID, true)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	addDeskflow(fake, 6000, "/Applications/Deskflow Preview.app")
	fake:advance(0.25)

	assertActivationResult(controller, "ambiguous", "gui-path", "wrong-path GUI")
	assertEqual(#fake:runningTasks(snapshotCommand), 0, "wrong-path recovery observation count")
	assertEqual(#fake:runningTasks(guiExecutablePath), 0, "wrong-path surface task count")
	assertNoMenuOrDirectActivation(fake, "wrong-path GUI")
	controller:stop()
end)

test("fails ambiguous on duplicate GUIs without selecting an instance", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	addFrontmostApplication(fake, 6100)
	fake:setLaunchResult(bundleID, true)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	addDeskflow(fake, 6200)
	addDeskflow(fake, 6201)
	fake:advance(0.25)

	assertActivationResult(controller, "ambiguous", "gui-cardinality", "duplicate GUI")
	assertEqual(#fake:runningTasks(snapshotCommand), 0, "duplicate GUI recovery observation count")
	assertEqual(#fake:runningTasks(guiExecutablePath), 0, "duplicate GUI surface task count")
	assertNoMenuOrDirectActivation(fake, "duplicate GUI")
	controller:stop()
end)

test("validates the exact cask bundle identity before launch or surface", function()
	local cases = {
		{
			name = "bundle identifier mismatch",
			configure = function(fake)
				fake:setBundleInfo(fixtures.constants.bundlePath, {
					CFBundleIdentifier = "org.example.not-deskflow",
				})
			end,
		},
		{
			name = "bundle registered at another path",
			configure = function(fake)
				fake:setBundleInfo("/Applications/Deskflow Preview.app", {
					CFBundleIdentifier = bundleID,
				})
				configureDeskflowBundle(fake)
			end,
		},
	}

	for _, case in ipairs(cases) do
		local fake = FakeHs.new()
		case.configure(fake)
		addFrontmostApplication(fake, 6300)
		addDeskflow(fake, 6400)
		local controller = newRuntime(fake)
		triggerRecovery(fake)

		assertActivationResult(controller, "unavailable", "bundle-identity", case.name)
		assertEqual(#fake:effectsOf("application.launch"), 0, case.name .. " launch count")
		assertEqual(#fake:runningTasks(guiExecutablePath), 0, case.name .. " surface task count")
		assertNoMenuOrDirectActivation(fake, case.name)
		controller:stop()
	end
end)

test("re-observes after launch and stops before menus when the core auto-started", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	local previous = addFrontmostApplication(fake, 6500)
	local deskflow = fake:addApplication({
		bundleID = bundleID,
		path = fixtures.constants.bundlePath,
		pid = 4200,
		running = false,
	})
	fake:setLaunchResult(bundleID, true, deskflow)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	completeObservation(fake, 0, fixtures.process.healthyServer.snapshot, "")

	assertActivationResult(controller, "recovered", "expected-core", "GUI auto-start")
	local inspection = controller:inspect()
	assertEqual(inspection.phase, "activating", "GUI auto-start model phase before task 3.3 finishes")
	assertEqual(inspection.priorFocusPID, previous:pid(), "GUI auto-start prior focus")
	assertNoMenuOrDirectActivation(fake, "GUI auto-start")
	controller:stop()
end)

test("fails unavailable if the GUI disappears while the recovery snapshot is pending", function()
	local fake = FakeHs.new()
	local controller, deskflow = startHiddenRecoveryObservation(fake, 6600, 6700)
	fake:setApplicationRunning(deskflow, false)

	completeObservation(fake, 0, "", "")

	assertActivationResult(controller, "unavailable", "gui-disappeared", "disappeared GUI")
	local inspection = controller:inspect()
	assertEqual(inspection.phase, "activating", "disappeared GUI recovery phase")
	assertEqual(inspection.recoveryApplicationPID, nil, "disappeared GUI recovery application")
	assertNoMenuOrDirectActivation(fake, "disappeared GUI")
	controller:stop()
end)

test("rejects changed or ambiguous GUI inventory after the recovery snapshot starts", function()
	local cases = {
		{
			name = "changed GUI PID",
			expectedReason = "gui-instance-changed",
			mutate = function(fake, deskflow)
				fake:setApplicationRunning(deskflow, false)
				fake:addApplication({
					bundleID = bundleID,
					frontmost = true,
					path = fixtures.constants.bundlePath,
					pid = 6810,
				})
			end,
		},
		{
			name = "changed GUI path",
			expectedReason = "gui-path",
			mutate = function(fake, deskflow)
				fake:setApplicationRunning(deskflow, false)
				fake:addApplication({
					bundleID = bundleID,
					frontmost = true,
					path = "/Applications/Deskflow Preview.app",
					pid = deskflow:pid(),
				})
			end,
		},
		{
			name = "duplicate GUI cardinality",
			expectedReason = "gui-cardinality",
			mutate = function(fake)
				addDeskflow(fake, 6830)
			end,
		},
	}

	for index, case in ipairs(cases) do
		local fake = FakeHs.new()
		local controller, deskflow = startHiddenRecoveryObservation(fake, 6800 + index, 6820)
		case.mutate(fake, deskflow)

		completeObservation(fake, 0, "", "")

		assertActivationResult(controller, "ambiguous", case.expectedReason, case.name)
		local inspection = controller:inspect()
		assertEqual(inspection.phase, "activating", case.name .. " recovery phase")
		assertEqual(inspection.recoveryApplicationPID, nil, case.name .. " recovery application")
		assertNoMenuOrDirectActivation(fake, case.name)
		controller:stop()
	end
end)

test("sleep cancels activation polling and stale surface callbacks only release handles", function()
	local fake = FakeHs.new()
	configureDeskflowBundle(fake)
	addFrontmostApplication(fake, 6600)
	addDeskflow(fake, 6700)
	local controller = newRuntime(fake)

	triggerRecovery(fake)
	local surfaceTask = fake:runningTasks(guiExecutablePath)[1]
	assert(surfaceTask, "sleep surface task")
	local taskCount = #fake:effectsOf("task.new")
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
	assert(fake:completeTask(surfaceTask, 0, "", ""), "stale surface callback completion")
	fake:advance(10)

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "sleeping", "activation sleep phase")
	assertEqual(inspection.delayedTimerCount, 0, "activation sleep timer count")
	assert(not inspection.observationInFlight, "stale surface callback must release its task")
	assertEqual(#fake:effectsOf("task.new"), taskCount, "stale surface callback task count")
	assertNoMenuOrDirectActivation(fake, "activation sleep")
	controller:stop()
end)

print("runtime tests passed: " .. testCount)
