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

local function newRuntime(fake, selectedModel, selectedRole)
	return loadModule(runtimePath, {
		assert = assert,
		hs = fake.hs,
		ipairs = ipairs,
		pairs = pairs,
		pcall = pcall,
		table = table,
		type = type,
	}).start(selectedModel or model, selectedRole or "server", snapshotCommand)
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

local function assertReports(fake, expected, context)
	local alerts = fake:effectsOf("alert.show")
	local logs = fake:effectsOf("console.log")
	assertEqual(#alerts, #expected, context .. " alert count")
	assertEqual(#logs, #expected, context .. " log count")
	for index, report in ipairs(expected) do
		assertEqual(alerts[index].message, report, context .. " alert " .. index)
		assertEqual(logs[index].message, report, context .. " log " .. index)
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
	for _, effect in ipairs(fake:effectsOf("application.activate")) do
		assert(effect.bundleID ~= bundleID, context .. " must not activate Deskflow directly")
	end
end

local function assertMenuPending(fake, context)
	assertEqual(#fake:effectsOf("menu.request"), 1, context .. " menu request count")
	assertEqual(#fake:effectsOf("menu.select"), 0, context .. " menu selection count")
	for _, effect in ipairs(fake:effectsOf("application.activate")) do
		assert(effect.bundleID ~= bundleID, context .. " must not activate Deskflow directly")
	end
end

local function assertNoProhibitedEffects(fake, context)
	assertEqual(#fake:effectsOf("task.terminate"), 0, context .. " task termination count")
	assertEqual(#fake:effectsOf("application.kill"), 0, context .. " application kill count")
	assertEqual(#fake:effectsOf("application.kill9"), 0, context .. " application kill9 count")
	for _, effect in ipairs(fake:effectsOf("task.new")) do
		assert(effect.path ~= fixtures.constants.coreExecutablePath, context .. " core task path")
		for _, argument in ipairs(effect.arguments) do
			assert(argument ~= "--new-instance", context .. " --new-instance argument")
		end
	end
end

local function assertPathEqual(actual, expected, context)
	assertEqual(#actual, #expected, context .. " path length")
	for index, title in ipairs(expected) do
		assertEqual(actual[index], title, context .. " path segment " .. index)
	end
end

local function healthySnapshot(guiPID, role)
	return (guiPID + 1) .. "\t" .. guiPID .. "\t" .. fixtures.constants.coreExecutablePath .. "\t" .. role .. "\n"
end

local function startHiddenRecoveryObservation(fake, previousPID, deskflowPID, role, selectedModel)
	configureDeskflowBundle(fake)
	local previous = addFrontmostApplication(fake, previousPID)
	local deskflow = addDeskflow(fake, deskflowPID)
	local controller = newRuntime(fake, selectedModel, role)
	triggerRecovery(fake)
	local surfaceTask = fake:runningTasks(guiExecutablePath)[1]
	assert(surfaceTask, "pending-snapshot surface task")
	fake:setFrontmostApplication(deskflow)
	assert(fake:completeTask(surfaceTask, 0, "", ""), "pending-snapshot surface completion")
	assertEqual(#fake:runningTasks(snapshotCommand), 1, "pending recovery snapshot count")
	return controller, deskflow, previous
end

local function beginMenuRecovery(fake, role, menuFixture, previousPID, deskflowPID, selectedModel)
	local controller, deskflow, previous =
		startHiddenRecoveryObservation(fake, previousPID, deskflowPID, role, selectedModel)
	fake:setMenuItems(deskflow, menuFixture.tree)
	completeObservation(fake, 0, "", "")
	assertEqual(controller:inspect().phase, "selecting", menuFixture.name .. " selecting phase")
	assertEqual(fake:pendingMenuCount(), 1, menuFixture.name .. " pending menu count")
	return controller, deskflow, previous
end

local function modelWithRecoveryResultSpy()
	local calls = {}
	local classifications = { count = 0 }
	local spyingModel = {}
	for key, value in pairs(model) do
		spyingModel[key] = value
	end
	function spyingModel.recoveryResult(currentState, result, now)
		table.insert(calls, {
			kind = result.kind,
			reason = result.reason,
		})
		return model.recoveryResult(currentState, result, now)
	end
	function spyingModel.classify(records, guiRecords, expected)
		classifications.count = classifications.count + 1
		return model.classify(records, guiRecords, expected)
	end
	return spyingModel, calls, classifications
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

test("reports persistent observation failures once per stable reason", function()
	local fake = FakeHs.new()
	addDeskflow(fake, 4850)
	addDeskflow(fake, 4851)
	local controller = newRuntime(fake)
	for _ = 1, 4 do
		advanceAndComplete(fake, fixtures.process.duplicateGui.snapshot)
	end
	advanceAndComplete(fake, "not-a-snapshot\n")
	advanceAndComplete(fake, "not-a-snapshot\n")

	assertReports(fake, {
		"Deskflow watchdog [ambiguous:gui-cardinality]: Multiple Deskflow GUI instances prevent safe recovery.",
		"Deskflow watchdog [error:snapshot-parse]: The Deskflow process inventory returned invalid data.",
	}, "persistent observation failures")
	assertNoRecoveryEffects(fake, "persistent observation failures")
	controller:stop()
end)

test("maps every runtime failure category to a stable report", function()
	local cases = {
		{
			key = "unavailable:bundle-identity",
			reason = "bundle-identity",
			message = "The Deskflow application identity could not be verified.",
		},
		{
			key = "error:snapshot-command",
			reason = "snapshot-command",
			message = "The Deskflow process inventory helper failed.",
		},
		{
			key = "recovery:cooldown",
			reason = "gui-activation-timeout",
			message = "Deskflow recovery failed repeatedly: the Deskflow GUI did not become active. Recovery is paused for 300 seconds.",
		},
		{
			key = "unavailable:start action unavailable",
			reason = "start action unavailable",
			message = "No enabled Deskflow start action was available.",
		},
		{
			key = "recovery:cooldown",
			reason = "menu-selection",
			message = "Deskflow recovery failed repeatedly: the Deskflow start action could not be selected. Recovery is paused for 300 seconds.",
		},
		{
			key = "recovery:cooldown",
			reason = "core-verification-timeout",
			message = "Deskflow recovery failed repeatedly: the expected Deskflow core did not appear. Recovery is paused for 300 seconds.",
		},
		{
			key = "ambiguous:core-parent",
			reason = "core-parent",
			message = "The Deskflow core is not owned by the expected GUI process.",
		},
	}

	for index, case in ipairs(cases) do
		local fake = FakeHs.new()
		addDeskflow(fake, 4900 + index)
		local reportingModel = {}
		for key, value in pairs(model) do
			reportingModel[key] = value
		end
		function reportingModel.observe(currentState, observation, now)
			local nextState = model.observe(currentState, observation, now)
			return nextState, {
				{ kind = "alert", key = case.key, reason = case.reason },
			}
		end

		local controller = newRuntime(fake, reportingModel)
		advanceAndComplete(fake, healthySnapshot(4900 + index, "server"))
		assertReports(fake, { "Deskflow watchdog [" .. case.key .. "]: " .. case.message }, case.reason)
		assertNoRecoveryEffects(fake, case.reason)
		controller:stop()
	end
end)

test("suppresses inaccessible recovery through model backoff and cooldown", function()
	local fake = FakeHs.new({ accessibilityState = false })
	local controller = newRuntime(fake)
	triggerRecovery(fake)

	local firstFailure = controller:inspect()
	assertEqual(firstFailure.phase, "backoff", "Accessibility first failure phase")
	assertEqual(firstFailure.retryAt, 25, "Accessibility first retry deadline")
	assertEqual(#fake:effectsOf("accessibility.check"), 1, "Accessibility first check count")
	assertReports(fake, {
		"Deskflow watchdog [unavailable:accessibility-permission]: Hammerspoon Accessibility permission is required to recover Deskflow.",
	}, "Accessibility first failure")
	assertNoRecoveryEffects(fake, "Accessibility first failure")

	for _ = 1, 6 do
		advanceAndComplete(fake, "")
	end
	local cooldown = controller:inspect()
	assertEqual(cooldown.phase, "cooldown", "Accessibility cooldown phase")
	assertEqual(cooldown.cooldownUntil, 350, "Accessibility cooldown deadline")
	assertEqual(#fake:effectsOf("accessibility.check"), 3, "Accessibility bounded attempt count")
	assertReports(fake, {
		"Deskflow watchdog [unavailable:accessibility-permission]: Hammerspoon Accessibility permission is required to recover Deskflow.",
		"Deskflow watchdog [recovery:cooldown]: Deskflow recovery failed repeatedly: Hammerspoon Accessibility permission is required to recover Deskflow. Recovery is paused for 300 seconds.",
	}, "Accessibility cooldown")
	assertNoRecoveryEffects(fake, "Accessibility cooldown")

	for _ = 1, 59 do
		advanceAndComplete(fake, "")
	end
	assertEqual(#fake:effectsOf("accessibility.check"), 3, "Accessibility checks during cooldown")
	advanceAndComplete(fake, "")
	assertEqual(controller:inspect().phase, "observing", "Accessibility cooldown expiry phase")
	assertNoRecoveryEffects(fake, "Accessibility cooldown expiry")
	configureDeskflowBundle(fake)
	addDeskflow(fake, 4970)
	fake:setAccessibilityState(true)
	advanceAndComplete(fake, "")
	assertEqual(#fake:effectsOf("accessibility.check"), 4, "Accessibility new episode check count")
	assertEqual(controller:inspect().phase, "activating", "Accessibility new episode phase")
	assertEqual(#fake:runningTasks(guiExecutablePath), 1, "Accessibility new episode surface count")
	assertNoProhibitedEffects(fake, "Accessibility new episode")
	controller:stop()
end)

test("schedules non-aligned retry eligibility at the model deadline", function()
	local fake = FakeHs.new()
	local controller, deskflow = beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 4950, 4960)
	fake:setMenuSelectionResult(deskflow, false)
	fake:advance(0.1)
	assert(fake:completeNextMenu(), "non-aligned failed selection callback")
	assertEqual(controller:inspect().retryAt, 25.1, "non-aligned retry deadline")

	fake:advance(4.9)
	completeObservation(fake, 0, "", "")
	assertEqual(controller:inspect().phase, "backoff", "pre-deadline backoff phase")
	fake:advance(0.09)
	assertEqual(#fake:runningTasks(snapshotCommand), 0, "pre-deadline eligibility snapshot count")
	fake:advance(0.01)
	assertEqual(#fake:runningTasks(snapshotCommand), 1, "deadline eligibility snapshot count")
	completeObservation(fake, 0, "", "")
	assertEqual(controller:inspect().absenceCount, 1, "deadline absence evidence")
	fake:advance(4.9)
	completeObservation(fake, 0, "", "")
	assertEqual(#fake:effectsOf("accessibility.check"), 2, "eligible recovery check count")
	assertEqual(#fake:runningTasks(guiExecutablePath), 1, "eligible recovery surface count")
	assertNoProhibitedEffects(fake, "non-aligned retry")
	controller:stop()
end)

test("contains Accessibility and reporting API exceptions without stranding model state", function()
	local fake = FakeHs.new({
		accessibilityError = "Accessibility API failed",
		alertError = "alert API failed",
		logError = "log API failed",
	})
	local controller = newRuntime(fake)
	triggerRecovery(fake)

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "backoff", "reporting exception model phase")
	assertEqual(inspection.retryAt, 25, "reporting exception retry deadline")
	assertEqual(#fake:effectsOf("accessibility.check"), 1, "reporting exception Accessibility count")
	assertEqual(#fake:effectsOf("alert.show"), 1, "reporting exception alert attempt count")
	assertEqual(#fake:effectsOf("console.log"), 1, "reporting exception log attempt count")
	assertNoRecoveryEffects(fake, "reporting exceptions")
	fake:advance(5)
	completeObservation(fake, 0, "", "")
	assertEqual(controller:inspect().absenceCount, 1, "reporting exception deadline evidence")
	controller:stop()
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
	assertMenuPending(fake, "absent GUI")
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
	assertMenuPending(fake, "hidden GUI")
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
	assertMenuPending(fake, "delayed activation")
	controller:stop()
end)

test("records activation timeout after ten seconds and restores prior focus", function()
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
	assertEqual(inspection.phase, "backoff", "activation timeout model phase")
	assertEqual(inspection.priorFocusPID, previous:pid(), "activation timeout prior focus")
	assertEqual(inspection.delayedTimerCount, 1, "activation timeout eligibility timer count")
	assert(previous:isFrontmost(), "activation timeout must restore prior focus")
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
	assertEqual(inspection.phase, "observing", "GUI auto-start model phase")
	assertEqual(inspection.priorFocusPID, previous:pid(), "GUI auto-start prior focus")
	assert(previous:isFrontmost(), "GUI auto-start must restore prior focus")
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
	assertEqual(inspection.phase, "backoff", "disappeared GUI recovery phase")
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
		assertEqual(inspection.phase, "backoff", case.name .. " recovery phase")
		assertEqual(inspection.recoveryApplicationPID, nil, case.name .. " recovery application")
		assertNoMenuOrDirectActivation(fake, case.name)
		controller:stop()
	end
end)

test("selects one model-approved localized path and recovers each role once", function()
	local cases = {
		{
			role = "server",
			menu = fixtures.menus.serverStart,
			previousPID = 6900,
			deskflowPID = 6910,
		},
		{
			role = "client",
			menu = fixtures.menus.clientStartLocalized,
			previousPID = 6920,
			deskflowPID = 6930,
		},
	}

	for _, case in ipairs(cases) do
		local fake = FakeHs.new()
		local controller, _, previous =
			beginMenuRecovery(fake, case.role, case.menu, case.previousPID, case.deskflowPID)
		assertEqual(#fake:effectsOf("menu.select"), 0, case.role .. " pre-callback selection count")
		assert(fake:completeNextMenu(), case.role .. " menu callback")

		local selection = fake:effectsOf("menu.select")[1]
		assert(selection, case.role .. " menu selection")
		assertPathEqual(selection.path, case.menu.expectedPath, case.role .. " localized selection")
		assertEqual(controller:inspect().phase, "verifying", case.role .. " verifying phase")
		assertEqual(#fake:runningTasks(snapshotCommand), 1, case.role .. " verification snapshot count")

		completeObservation(fake, 0, healthySnapshot(case.deskflowPID, case.role), "")
		local inspection = controller:inspect()
		assertEqual(inspection.phase, "observing", case.role .. " recovered phase")
		assertEqual(inspection.recoveryResult.kind, "recovered", case.role .. " recovery result")
		assertEqual(#inspection.recoveryDecisions, 0, case.role .. " recovery decision count")
		assert(previous:isFrontmost(), case.role .. " prior focus restoration")
		assertEqual(#fake:effectsOf("application.activate"), 1, case.role .. " focus activation count")
		assertNoProhibitedEffects(fake, case.role .. " recovery")
		controller:stop()
	end
end)

test("consumes menu callbacks before reentrant and repeated delivery", function()
	local fake = FakeHs.new()
	local spyingModel, recoveryCalls, classifications = modelWithRecoveryResultSpy()
	local controller, deskflow, previous =
		beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 6950, 6960, spyingModel)
	local menuHandle = fake:pendingMenuRequests()[1].handle
	fake:setNextMenuSelectionHook(deskflow, function()
		assert(fake:repeatMenuCallback(menuHandle), "reentrant menu callback")
	end)
	assert(fake:completeNextMenu(), "initial menu callback")

	local verifying = controller:inspect()
	assertEqual(verifying.phase, "verifying", "reentrant callback model phase")
	assertEqual(#fake:effectsOf("menu.select"), 1, "reentrant callback selection count")
	assertEqual(#recoveryCalls, 0, "reentrant callback recovery result count")
	assertEqual(#fake:effectsOf("application.activate"), 0, "reentrant callback focus restoration count")
	assertEqual(#fake:runningTasks(snapshotCommand), 1, "reentrant callback verification task count")
	assertEqual(fake:pendingMenuCount(), 0, "reentrant callback pending menu count")
	assert(not verifying.menuPending, "reentrant callback runtime menu handle release")

	assert(fake:repeatMenuCallback(menuHandle), "repeated verifying menu callback")
	assertEqual(controller:inspect().phase, "verifying", "repeated callback model phase")
	assertEqual(#fake:effectsOf("menu.select"), 1, "repeated callback selection count")
	assertEqual(#recoveryCalls, 0, "repeated callback recovery result count")
	assertEqual(#fake:effectsOf("application.activate"), 0, "repeated callback focus restoration count")

	local verificationTask = fake:runningTasks(snapshotCommand)[1]
	local classificationsBeforeVerification = classifications.count
	completeObservation(fake, 0, healthySnapshot(6960, "server"), "")
	local recovered = controller:inspect()
	assertEqual(recovered.phase, "observing", "repeated callback recovered phase")
	assertEqual(recovered.recoveryResult.kind, "recovered", "repeated callback recovered result")
	assertEqual(#recoveryCalls, 1, "repeated callback terminal result count")
	assertEqual(#fake:effectsOf("application.activate"), 1, "repeated callback terminal focus count")
	assert(previous:isFrontmost(), "repeated callback prior focus restoration")
	assertEqual(recovered.delayedTimerCount, 0, "repeated callback delayed timer count")
	assertEqual(classifications.count, classificationsBeforeVerification + 1, "first verification classification count")
	assert(
		fake:repeatTaskCallback(verificationTask, 0, healthySnapshot(6960, "server"), ""),
		"repeated verification task callback"
	)
	assertEqual(classifications.count, classificationsBeforeVerification + 1, "repeated task classification count")
	assertEqual(#recoveryCalls, 1, "repeated task recovery result count")
	assertEqual(#fake:effectsOf("application.activate"), 1, "repeated task focus restoration count")

	assert(fake:repeatMenuCallback(menuHandle), "post-terminal menu callback")
	assertEqual(#fake:effectsOf("menu.select"), 1, "post-terminal callback selection count")
	assertEqual(#recoveryCalls, 1, "post-terminal callback recovery result count")
	assertEqual(#fake:effectsOf("application.activate"), 1, "post-terminal callback focus restoration count")
	assertNoProhibitedEffects(fake, "repeated menu callback")
	controller:stop()
end)

test("rejects unavailable and multiple start actions without menu selection", function()
	local cases = {
		{
			menu = fixtures.menus.zeroCandidates,
			reason = "start action unavailable",
		},
		{
			menu = fixtures.menus.multipleCandidates,
			reason = "multiple start actions",
		},
	}

	for index, case in ipairs(cases) do
		local fake = FakeHs.new()
		local controller, _, previous = beginMenuRecovery(fake, "server", case.menu, 7000 + index, 7010 + index)
		assert(fake:completeNextMenu(), case.menu.name .. " menu callback")

		local inspection = controller:inspect()
		assertEqual(inspection.phase, "backoff", case.menu.name .. " model phase")
		assertEqual(inspection.recoveryResult.kind, "unavailable", case.menu.name .. " result kind")
		assertEqual(inspection.recoveryResult.reason, case.reason, case.menu.name .. " result reason")
		assertEqual(#inspection.recoveryDecisions, 2, case.menu.name .. " decision count")
		assertEqual(inspection.recoveryDecisions[1].kind, "alert", case.menu.name .. " alert decision")
		assertEqual(inspection.recoveryDecisions[2].kind, "retry-after", case.menu.name .. " retry decision")
		assertEqual(#fake:effectsOf("menu.select"), 0, case.menu.name .. " selection count")
		assert(previous:isFrontmost(), case.menu.name .. " prior focus restoration")
		assertNoProhibitedEffects(fake, case.menu.name)
		controller:stop()
	end
end)

test("contains thrown menu selection and records one terminal failure", function()
	local fake = FakeHs.new()
	local spyingModel, recoveryCalls = modelWithRecoveryResultSpy()
	local controller, deskflow, previous =
		beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 7080, 7090, spyingModel)
	fake:setMenuSelectionError(deskflow, "AX menu selection failed")
	assert(fake:completeNextMenu(), "throwing selection menu callback")

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "backoff", "throwing selection model phase")
	assertEqual(inspection.recoveryResult.kind, "failed", "throwing selection result kind")
	assertEqual(inspection.recoveryResult.reason, "menu-selection", "throwing selection result reason")
	assertEqual(#recoveryCalls, 1, "throwing selection recovery result count")
	assertEqual(recoveryCalls[1].kind, "failed", "throwing selection model result kind")
	assertEqual(recoveryCalls[1].reason, "menu-selection", "throwing selection model result reason")
	assertEqual(fake:pendingMenuCount(), 0, "throwing selection pending menu count")
	assertEqual(#fake:runningTasks(snapshotCommand), 0, "throwing selection verification snapshot count")
	assertEqual(#fake:effectsOf("application.activate"), 1, "throwing selection focus restoration count")
	assert(previous:isFrontmost(), "throwing selection prior focus restoration")
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
	assertEqual(#recoveryCalls, 1, "post-failure sleep recovery result count")
	assertEqual(#fake:effectsOf("application.activate"), 1, "post-failure sleep focus restoration count")
	assertNoProhibitedEffects(fake, "throwing selection")
	controller:stop()
end)

test("contains thrown asynchronous menu requests as one terminal failure", function()
	local fake = FakeHs.new()
	local spyingModel, recoveryCalls = modelWithRecoveryResultSpy()
	local controller, deskflow, previous = startHiddenRecoveryObservation(fake, 7091, 7092, "server", spyingModel)
	fake:setMenuItems(deskflow, fixtures.menus.serverStart.tree)
	fake:setMenuRequestError(deskflow, "AX menu request failed")
	completeObservation(fake, 0, "", "")

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "backoff", "throwing menu request model phase")
	assertEqual(inspection.recoveryResult.kind, "failed", "throwing menu request result kind")
	assertEqual(inspection.recoveryResult.reason, "menu-enumeration", "throwing menu request result reason")
	assertEqual(#recoveryCalls, 1, "throwing menu request recovery result count")
	assertEqual(fake:pendingMenuCount(), 0, "throwing menu request pending count")
	assertEqual(#fake:effectsOf("menu.select"), 0, "throwing menu request selection count")
	assert(previous:isFrontmost(), "throwing menu request prior focus restoration")
	assertNoProhibitedEffects(fake, "throwing menu request")
	controller:stop()
end)

test("records menu selection failure and restores prior focus", function()
	local fake = FakeHs.new()
	local spyingModel, recoveryCalls = modelWithRecoveryResultSpy()
	local controller, deskflow, previous =
		beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 7100, 7110, spyingModel)
	fake:setMenuSelectionResult(deskflow, false)
	assert(fake:completeNextMenu(), "failed selection menu callback")

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "backoff", "failed selection model phase")
	assertEqual(inspection.recoveryResult.kind, "failed", "failed selection result kind")
	assertEqual(inspection.recoveryResult.reason, "menu-selection", "failed selection result reason")
	assertEqual(#recoveryCalls, 1, "failed selection recovery result count")
	assert(previous:isFrontmost(), "failed selection prior focus restoration")
	assertEqual(#fake:runningTasks(snapshotCommand), 0, "failed selection verification snapshot count")
	assertNoProhibitedEffects(fake, "failed selection")
	controller:stop()
end)

test("contains thrown focus restoration after recording the terminal result", function()
	local fake = FakeHs.new()
	local spyingModel, recoveryCalls = modelWithRecoveryResultSpy()
	local controller, _, previous =
		beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 7120, 7130, spyingModel)
	assert(fake:completeNextMenu(), "throwing focus menu callback")
	fake:setActivationError(previous, "focus restoration failed")
	completeObservation(fake, 0, healthySnapshot(7130, "server"), "")

	local inspection = controller:inspect()
	assertEqual(inspection.phase, "observing", "throwing focus model phase")
	assertEqual(inspection.recoveryResult.kind, "recovered", "throwing focus recovery result")
	assertEqual(#recoveryCalls, 1, "throwing focus recovery result count")
	assertEqual(#fake:effectsOf("application.activate"), 1, "throwing focus restoration attempt count")
	assertEqual(inspection.delayedTimerCount, 0, "throwing focus delayed timer count")
	assert(not inspection.menuPending, "throwing focus menu handle release")
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
	assertEqual(#recoveryCalls, 1, "throwing focus post-terminal result count")
	assertNoProhibitedEffects(fake, "throwing focus")
	controller:stop()
end)

test("verification rejects wrong-role and multiple-core inventories", function()
	local cases = {
		{
			name = "wrong role",
			reason = "core-role",
			snapshot = function(pid)
				return healthySnapshot(pid, "client")
			end,
		},
		{
			name = "multiple cores",
			reason = "core-cardinality",
			snapshot = function(pid)
				return healthySnapshot(pid, "server")
					.. (pid + 2)
					.. "\t"
					.. pid
					.. "\t"
					.. fixtures.constants.coreExecutablePath
					.. "\tserver\n"
			end,
		},
	}

	for index, case in ipairs(cases) do
		local fake = FakeHs.new()
		local deskflowPID = 7210 + index
		local controller, _, previous =
			beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 7200 + index, deskflowPID)
		assert(fake:completeNextMenu(), case.name .. " menu callback")
		completeObservation(fake, 0, case.snapshot(deskflowPID), "")

		local inspection = controller:inspect()
		assertEqual(inspection.phase, "backoff", case.name .. " model phase")
		assertEqual(inspection.recoveryResult.kind, "ambiguous", case.name .. " result kind")
		assertEqual(inspection.recoveryResult.reason, case.reason, case.name .. " result reason")
		assert(previous:isFrontmost(), case.name .. " prior focus restoration")
		assertEqual(#fake:effectsOf("menu.select"), 1, case.name .. " menu selection count")
		assertNoProhibitedEffects(fake, case.name)
		controller:stop()
	end
end)

test("verification times out after fifteen seconds and restores prior focus", function()
	local fake = FakeHs.new()
	local controller, _, previous = beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 7300, 7310)
	assert(fake:completeNextMenu(), "verification timeout menu callback")
	assertEqual(#fake:runningTasks(snapshotCommand), 1, "initial verification snapshot count")
	completeObservation(fake, 0, "", "")
	for second = 1, 14 do
		fake:advance(1)
		assertEqual(#fake:runningTasks(snapshotCommand), 1, "verification snapshot at second " .. second)
		completeObservation(fake, 0, "", "")
	end

	fake:advance(1)
	local inspection = controller:inspect()
	assertEqual(inspection.phase, "backoff", "verification timeout model phase")
	assertEqual(inspection.recoveryResult.kind, "failed", "verification timeout result kind")
	assertEqual(inspection.recoveryResult.reason, "core-verification-timeout", "verification timeout reason")
	assert(previous:isFrontmost(), "verification timeout prior focus restoration")
	assertEqual(inspection.delayedTimerCount, 1, "verification timeout eligibility timer count")
	assertNoProhibitedEffects(fake, "verification timeout")
	controller:stop()
end)

test("reacquires the same GUI PID before menu and verification effects", function()
	local menuFake = FakeHs.new()
	local menuController, menuDeskflow, menuPrevious =
		beginMenuRecovery(menuFake, "server", fixtures.menus.serverStart, 7350, 7360)
	menuFake:setApplicationRunning(menuDeskflow, false)
	menuFake:addApplication({
		bundleID = bundleID,
		frontmost = true,
		path = fixtures.constants.bundlePath,
		pid = 7361,
	})
	assert(menuFake:completeNextMenu(), "changed-menu-GUI callback")
	local menuInspection = menuController:inspect()
	assertEqual(menuInspection.recoveryResult.kind, "ambiguous", "changed-menu-GUI result kind")
	assertEqual(menuInspection.recoveryResult.reason, "gui-instance-changed", "changed-menu-GUI reason")
	assertEqual(#menuFake:effectsOf("menu.select"), 0, "changed-menu-GUI selection count")
	assert(menuPrevious:isFrontmost(), "changed-menu-GUI prior focus restoration")
	assertNoProhibitedEffects(menuFake, "changed-menu-GUI")
	menuController:stop()

	local verificationFake = FakeHs.new()
	local verificationController, verificationDeskflow, verificationPrevious =
		beginMenuRecovery(verificationFake, "server", fixtures.menus.serverStart, 7370, 7380)
	assert(verificationFake:completeNextMenu(), "changed-verification-GUI menu callback")
	local verificationTask = verificationFake:runningTasks(snapshotCommand)[1]
	assert(verificationTask, "changed-verification-GUI snapshot task")
	verificationFake:setApplicationRunning(verificationDeskflow, false)
	verificationFake:addApplication({
		bundleID = bundleID,
		frontmost = true,
		path = fixtures.constants.bundlePath,
		pid = 7381,
	})
	assert(
		verificationFake:completeTask(verificationTask, 0, healthySnapshot(7381, "server"), ""),
		"changed-verification-GUI callback"
	)
	local verificationInspection = verificationController:inspect()
	assertEqual(verificationInspection.recoveryResult.kind, "ambiguous", "changed-verification-GUI result kind")
	assertEqual(verificationInspection.recoveryResult.reason, "gui-instance-changed", "changed-verification-GUI reason")
	assert(verificationPrevious:isFrontmost(), "changed-verification-GUI prior focus restoration")
	assertNoProhibitedEffects(verificationFake, "changed-verification-GUI")
	verificationController:stop()
end)

test("sleep aborts activation, menu lookup, and verification with stale callbacks effect-free", function()
	local stages = { "activating", "selecting", "verifying" }
	for index, stage in ipairs(stages) do
		local fake = FakeHs.new()
		local previousPID = 7400 + index
		local deskflowPID = 7410 + index
		local controller
		local deskflow
		local previous
		local staleCallback

		if stage == "activating" then
			configureDeskflowBundle(fake)
			previous = addFrontmostApplication(fake, previousPID)
			addDeskflow(fake, deskflowPID)
			controller = newRuntime(fake)
			triggerRecovery(fake)
			local surfaceTask = fake:runningTasks(guiExecutablePath)[1]
			assert(surfaceTask, "activation-stage surface task")
			staleCallback = function()
				return fake:completeTask(surfaceTask, 0, "", "")
			end
		else
			controller, deskflow, previous =
				beginMenuRecovery(fake, "server", fixtures.menus.serverStart, previousPID, deskflowPID)
			if stage == "selecting" then
				fake:setMenuSelectionError(deskflow, "stale menu selection must not run")
				staleCallback = function()
					return fake:completeNextMenu()
				end
			else
				assert(fake:completeNextMenu(), "verification-stage menu callback")
				local verificationTask = fake:runningTasks(snapshotCommand)[1]
				assert(verificationTask, "verification-stage snapshot task")
				staleCallback = function()
					return fake:completeTask(verificationTask, 0, healthySnapshot(deskflowPID, "server"), "")
				end
			end
		end

		local menuSelections = #fake:effectsOf("menu.select")
		local taskCreations = #fake:effectsOf("task.new")
		fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
		assert(staleCallback(), stage .. " stale callback completion")
		fake:advance(16)

		local inspection = controller:inspect()
		assertEqual(inspection.phase, "sleeping", stage .. " sleep phase")
		assertEqual(inspection.recoveryResult.kind, "aborted", stage .. " recovery result")
		assertEqual(inspection.recoveryResult.reason, "sleep", stage .. " recovery reason")
		assert(previous:isFrontmost(), stage .. " prior focus restoration")
		assertEqual(#fake:effectsOf("application.activate"), 1, stage .. " focus activation count")
		assertEqual(#fake:effectsOf("menu.select"), menuSelections, stage .. " stale menu effect count")
		assertEqual(fake:pendingMenuCount(), 0, stage .. " stale pending menu count")
		assertEqual(#fake:effectsOf("task.new"), taskCreations, stage .. " stale task effect count")
		assert(not inspection.observationInFlight, stage .. " stale task handle release")
		assertNoProhibitedEffects(fake, stage .. " sleep abort")
		controller:stop()
	end
end)

test("retries one failed sleep focus restoration before wake lifecycle", function()
	local fake = FakeHs.new()
	local lifecycleCalls = {}
	local spyingModel = {}
	for key, value in pairs(model) do
		spyingModel[key] = value
	end
	function spyingModel.lifecycle(currentState, event, now)
		table.insert(lifecycleCalls, {
			event = event,
			focusAttempts = #fake:effectsOf("application.activate"),
		})
		return model.lifecycle(currentState, event, now)
	end

	local controller, _, previous =
		beginMenuRecovery(fake, "server", fixtures.menus.serverStart, 7500, 7510, spyingModel)
	fake:setActivationError(previous, "sleep focus restoration failed")
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemWillSleep)
	local sleeping = controller:inspect()
	assertEqual(sleeping.pendingFocusPID, previous:pid(), "pending sleep focus PID")
	assertEqual(#fake:effectsOf("application.activate"), 1, "initial sleep focus attempt count")

	fake:setActivationError(previous, nil)
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemDidWake)
	local waking = controller:inspect()
	assertEqual(lifecycleCalls[2].event, "wake", "wake lifecycle event")
	assertEqual(lifecycleCalls[2].focusAttempts, 2, "focus retry must precede wake lifecycle")
	assertEqual(waking.phase, "grace", "post-retry wake phase")
	assertEqual(waking.pendingFocusPID, nil, "cleared pending focus PID")
	assert(previous:isFrontmost(), "wake retry prior focus restoration")
	assertEqual(#fake:effectsOf("application.activate"), 2, "bounded focus retry count")
	fake:fireLifecycle(fake.hs.caffeinate.watcher.systemDidWake)
	assertEqual(#fake:effectsOf("application.activate"), 2, "repeated wake focus attempt count")
	assertNoProhibitedEffects(fake, "wake focus retry")
	controller:stop()
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
