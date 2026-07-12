local Runtime = {}

local bundleID = "org.deskflow.deskflow"
local bundlePath = "/Applications/Deskflow.app"
local guiExecutablePath = bundlePath .. "/Contents/MacOS/Deskflow"
local activationPollInterval = 0.25
local activationTimeout = 10
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
	local recoveryContext
	local sleeping = false
	local stopped = false
	local beginRecovery

	local function releaseDelayedTimer(timer)
		if timer ~= nil then
			timer:stop()
			delayedTimers[timer] = nil
		end
	end

	local function stopDelayedTimers()
		for timer in pairs(delayedTimers) do
			timer:stop()
			delayedTimers[timer] = nil
		end
	end

	local function completeActivation(context, result, application)
		if
			context ~= recoveryContext
			or context.epoch ~= epoch
			or sleeping
			or stopped
			or context.activationResult ~= nil
		then
			return
		end

		if result.kind == "ready" then
			local nextState = model.advanceRecovery(state, "selecting", currentTime())
			if nextState == state then
				context.activationResult = {
					kind = "failed",
					reason = "activation-transition",
				}
				return
			end
			state = nextState
		end

		context.application = application
		context.activationResult = result
	end

	local function observe(observation, callbackEpoch)
		if callbackEpoch ~= epoch or sleeping or stopped then
			return
		end

		local nextState, decisions = model.observe(state, observation, currentTime())
		state = nextState
		for _, decision in ipairs(decisions) do
			if decision.kind == "recover" and decision.phase == "activating" then
				beginRecovery(callbackEpoch)
			end
		end
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

	local function requestSnapshot(callback)
		if activeTask ~= nil or sleeping or stopped then
			return false
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

			callback(classifySnapshot(exitCode, stdout), callbackEpoch)
		end, nil)
		activeTask = task

		if task == nil or not task:start() then
			if activeTask == task then
				activeTask = nil
			end
			if callbackEpoch == epoch and not sleeping and not stopped then
				callback({ kind = "error", reason = "snapshot-command" }, callbackEpoch)
			end
			return false
		end
		return true
	end

	local function requestObservation()
		if recoveryContext ~= nil then
			return
		end
		requestSnapshot(observe)
	end

	local function reacquireApplication()
		local applications = hs.application.applicationsForBundleID(bundleID)
		if type(applications) ~= "table" then
			return nil, { kind = "failed", reason = "gui-inventory" }
		end

		local count = 0
		for key in pairs(applications) do
			if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
				return nil, { kind = "failed", reason = "gui-inventory" }
			end
			count = count + 1
		end
		for index = 1, count do
			if applications[index] == nil then
				return nil, { kind = "failed", reason = "gui-inventory" }
			end
		end

		if count == 0 then
			return nil, nil
		end
		if count ~= 1 then
			return nil, { kind = "ambiguous", reason = "gui-cardinality" }
		end
		if applications[1]:path() ~= bundlePath then
			return nil, { kind = "ambiguous", reason = "gui-path" }
		end
		return applications[1], nil
	end

	local function requestRecoveryObservation(context, activatedPID)
		local started = requestSnapshot(function(observation, callbackEpoch)
			if context ~= recoveryContext or context.epoch ~= callbackEpoch then
				return
			end

			local currentApplication, failure = reacquireApplication()
			if failure ~= nil then
				completeActivation(context, failure)
				return
			end
			if currentApplication == nil then
				completeActivation(context, { kind = "unavailable", reason = "gui-disappeared" })
				return
			end
			if currentApplication:pid() ~= activatedPID then
				completeActivation(context, { kind = "ambiguous", reason = "gui-instance-changed" })
				return
			end

			if observation.kind == "healthy" then
				completeActivation(context, {
					kind = "recovered",
					reason = observation.reason,
				}, currentApplication)
			elseif observation.kind == "absent" then
				if observation.reason == "core-absent" then
					completeActivation(context, { kind = "ready" }, currentApplication)
				else
					completeActivation(context, { kind = "unavailable", reason = observation.reason })
				end
			elseif observation.kind == "ambiguous" then
				completeActivation(context, {
					kind = "ambiguous",
					reason = observation.reason,
				})
			else
				completeActivation(context, {
					kind = "failed",
					reason = observation.reason,
				})
			end
		end)

		if not started then
			completeActivation(context, { kind = "failed", reason = "snapshot-command" })
		end
	end

	local function waitForFrontmost(context)
		local deadline = currentTime() + activationTimeout
		local timer
		local finished = false

		local function checkFrontmost()
			if context ~= recoveryContext or context.epoch ~= epoch or sleeping or stopped then
				finished = true
				releaseDelayedTimer(timer)
				return
			end

			local application, failure = reacquireApplication()
			if failure ~= nil then
				finished = true
				releaseDelayedTimer(timer)
				completeActivation(context, failure)
				return
			end
			if application ~= nil and application:isFrontmost() then
				finished = true
				releaseDelayedTimer(timer)
				requestRecoveryObservation(context, application:pid())
				return
			end
			if currentTime() >= deadline then
				finished = true
				releaseDelayedTimer(timer)
				completeActivation(context, { kind = "failed", reason = "gui-activation-timeout" })
			end
		end

		checkFrontmost()
		if finished then
			return
		end

		timer = hs.timer.new(activationPollInterval, checkFrontmost)
		delayedTimers[timer] = true
		timer:start()
	end

	local function surfaceApplication(context)
		local task
		task = hs.task.new(guiExecutablePath, function(exitCode)
			if activeTask == task then
				activeTask = nil
			end
			if context ~= recoveryContext or context.epoch ~= epoch or sleeping or stopped then
				return
			end
			if exitCode ~= 0 then
				completeActivation(context, { kind = "failed", reason = "gui-surface" })
				return
			end
			waitForFrontmost(context)
		end, nil)
		activeTask = task

		if task == nil or not task:start() then
			if activeTask == task then
				activeTask = nil
			end
			completeActivation(context, { kind = "failed", reason = "gui-surface" })
		end
	end

	beginRecovery = function(callbackEpoch)
		if callbackEpoch ~= epoch or sleeping or stopped or recoveryContext ~= nil then
			return
		end

		local context = {
			epoch = callbackEpoch,
			priorFocus = hs.application.frontmostApplication(),
		}
		recoveryContext = context

		local bundleInfo = hs.application.infoForBundlePath(bundlePath)
		if
			type(bundleInfo) ~= "table"
			or bundleInfo.CFBundleIdentifier ~= bundleID
			or hs.application.pathForBundleID(bundleID) ~= bundlePath
		then
			completeActivation(context, { kind = "unavailable", reason = "bundle-identity" })
			return
		end

		local application, failure = reacquireApplication()
		if failure ~= nil then
			completeActivation(context, failure)
			return
		end
		if application ~= nil then
			if application:isFrontmost() then
				requestRecoveryObservation(context, application:pid())
			else
				surfaceApplication(context)
			end
			return
		end

		if not hs.application.launchOrFocusByBundleID(bundleID) then
			completeActivation(context, { kind = "failed", reason = "gui-launch" })
			return
		end
		waitForFrontmost(context)
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
			if recoveryContext ~= nil and recoveryContext.epoch == epoch then
				recoveryContext.activationResult = { kind = "aborted", reason = "sleep" }
			end
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

		local activationResult
		local priorFocusPID
		local recoveryApplicationPID
		if recoveryContext ~= nil then
			if recoveryContext.activationResult ~= nil then
				activationResult = {
					kind = recoveryContext.activationResult.kind,
					reason = recoveryContext.activationResult.reason,
				}
			end
			if recoveryContext.priorFocus ~= nil then
				priorFocusPID = recoveryContext.priorFocus:pid()
			end
			if recoveryContext.application ~= nil then
				recoveryApplicationPID = recoveryContext.application:pid()
			end
		end

		return {
			activationResult = activationResult,
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
			priorFocusPID = priorFocusPID,
			recoveryApplicationPID = recoveryApplicationPID,
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
