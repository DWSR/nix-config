local Runtime = {}

local bundleID = "org.deskflow.deskflow"
local bundlePath = "/Applications/Deskflow.app"
local pollInterval = 5

local policy = {
	absenceThreshold = 2,
	startupGrace = 15,
	wakeGrace = 15,
	attemptLimit = 3,
	recoveryWindow = 300,
	retryDelays = { 5, 15 },
	cooldown = 300,
}

local function currentTime()
	return hs.timer.secondsSinceEpoch()
end

function Runtime.start(model, role, snapshotCommand)
	assert(type(model) == "table", "model must be a table")
	assert(role == "client" or role == "server", "role must be client or server")
	assert(type(snapshotCommand) == "string" and snapshotCommand ~= "", "snapshot command must be a string")

	local state, stateError = model.new(policy, currentTime())
	assert(state, stateError)

	local activeTask
	local controller = {}
	local delayedTimers = {}
	local epoch = 0
	local lifecycleWatcher
	local lifecycleWatcherRunning = false
	local pollTimer
	local pollTimerRunning = false
	local sleeping = false
	local stopped = false

	local function observe(observation, callbackEpoch)
		if callbackEpoch ~= epoch or sleeping or stopped then
			return
		end

		local nextState = model.observe(state, observation, currentTime())
		state = nextState
	end

	local function classifySnapshot(exitCode, stdout)
		if exitCode ~= 0 then
			return { kind = "error", reason = "snapshot-command" }
		end

		local records = model.parseSnapshot(stdout)
		if records == nil then
			return { kind = "error", reason = "snapshot-parse" }
		end

		local applications = hs.application.applicationsForBundleID(bundleID)
		if type(applications) ~= "table" then
			return { kind = "error", reason = "gui-inventory" }
		end

		local guiRecords = {}
		for _, application in ipairs(applications) do
			table.insert(guiRecords, {
				pid = application:pid(),
				bundlePath = application:path(),
			})
		end

		return model.classify(records, guiRecords, {
			bundlePath = bundlePath,
			role = role,
		})
	end

	local function requestObservation()
		if activeTask ~= nil or sleeping or stopped then
			return
		end

		local callbackEpoch = epoch
		local task
		task = hs.task.new(snapshotCommand, function(exitCode, stdout)
			if activeTask == task then
				activeTask = nil
			end
			if callbackEpoch ~= epoch or sleeping or stopped then
				return
			end

			observe(classifySnapshot(exitCode, stdout), callbackEpoch)
		end, nil)
		activeTask = task

		if task == nil or not task:start() then
			if activeTask == task then
				activeTask = nil
			end
			observe({ kind = "error", reason = "snapshot-command" }, callbackEpoch)
		end
	end

	local function stopDelayedTimers()
		for timer in pairs(delayedTimers) do
			timer:stop()
			delayedTimers[timer] = nil
		end
	end

	local function handleLifecycle(event)
		if stopped then
			return
		end

		if event == hs.caffeinate.watcher.systemWillSleep then
			if sleeping then
				return
			end

			local nextState = model.lifecycle(state, "sleep", currentTime())
			state = nextState
			sleeping = true
			if pollTimerRunning then
				pollTimer:stop()
				pollTimerRunning = false
			end
			stopDelayedTimers()
			epoch = epoch + 1
		elseif event == hs.caffeinate.watcher.systemDidWake and sleeping then
			epoch = epoch + 1
			local nextState = model.lifecycle(state, "wake", currentTime())
			state = nextState
			sleeping = false
			pollTimer:start()
			pollTimerRunning = true
		end
	end

	function controller:stop()
		if stopped then
			return
		end

		stopped = true
		epoch = epoch + 1
		if pollTimerRunning then
			pollTimer:stop()
			pollTimerRunning = false
		end
		stopDelayedTimers()
		if lifecycleWatcherRunning then
			lifecycleWatcher:stop()
			lifecycleWatcherRunning = false
		end
	end

	function controller:inspect()
		local delayedTimerCount = 0
		for _ in pairs(delayedTimers) do
			delayedTimerCount = delayedTimerCount + 1
		end

		return {
			absenceCount = state.absenceCount,
			delayedTimerCount = delayedTimerCount,
			epoch = epoch,
			graceUntil = state.graceUntil,
			lastTimestamp = state.lastTimestamp,
			lifecycleWatcherRunning = lifecycleWatcherRunning,
			observationInFlight = activeTask ~= nil,
			persistentAlertKey = state.persistentAlertKey,
			phase = state.phase,
			pollTimerRunning = pollTimerRunning,
			sleeping = sleeping,
			stopped = stopped,
		}
	end

	pollTimer = hs.timer.new(pollInterval, requestObservation)
	pollTimer:start()
	pollTimerRunning = true
	lifecycleWatcher = hs.caffeinate.watcher.new(handleLifecycle)
	lifecycleWatcher:start()
	lifecycleWatcherRunning = true

	return controller
end

return Runtime
