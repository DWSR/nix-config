local Runtime = {}

local bundleID = "org.deskflow.deskflow"
local bundlePath = "/Applications/Deskflow.app"
local guiExecutablePath = bundlePath .. "/Contents/MacOS/Deskflow"
local activationPollInterval = 0.25
local activationTimeout = 10
local pollInterval = 5
local verificationInterval = 1
local verificationTimeout = 15

local policy = {
	absenceThreshold = 2,
	startupGrace = 15,
	wakeGrace = 15,
	attemptLimit = 3,
	recoveryWindow = 300,
	retryDelays = { 5, 15 },
	cooldown = 300,
}

local reasonMessages = {
	["accessibility-permission"] = "Hammerspoon Accessibility permission is required to recover Deskflow.",
	["activation-transition"] = "The Deskflow activation state could not be verified.",
	["bundle-identity"] = "The Deskflow application identity could not be verified.",
	["core-cardinality"] = "Multiple Deskflow core processes prevent safe recovery.",
	["core-parent"] = "The Deskflow core is not owned by the expected GUI process.",
	["core-path"] = "The Deskflow core executable path could not be verified.",
	["core-role"] = "The Deskflow core role does not match this host.",
	["core-verification-timeout"] = "The expected Deskflow core did not appear.",
	["core-without-gui"] = "A Deskflow core exists without its owning GUI.",
	["gui-activation-timeout"] = "The Deskflow GUI did not become active.",
	["gui-and-core-absent"] = "The Deskflow GUI disappeared during recovery.",
	["gui-cardinality"] = "Multiple Deskflow GUI instances prevent safe recovery.",
	["gui-disappeared"] = "The Deskflow GUI disappeared during recovery.",
	["gui-instance-changed"] = "The Deskflow GUI instance changed during recovery.",
	["gui-inventory"] = "The Deskflow GUI process inventory could not be verified.",
	["gui-launch"] = "The Deskflow GUI could not be launched.",
	["gui-not-frontmost"] = "The Deskflow GUI recovery controls are not active.",
	["gui-path"] = "The Deskflow GUI path could not be verified.",
	["gui-surface"] = "The Deskflow GUI recovery controls could not be opened.",
	["invalid menu selector input"] = "The Deskflow start-action selector was invalid.",
	["invalid menu tree"] = "The Deskflow menu structure could not be verified.",
	["invalid-expected"] = "The expected Deskflow process identity was invalid.",
	["invalid-gui-records"] = "The Deskflow GUI process inventory returned invalid data.",
	["invalid-process-records"] = "The Deskflow process inventory returned invalid data.",
	["menu-enumeration"] = "The Deskflow menu could not be read.",
	["menu-selection"] = "The Deskflow start action could not be selected.",
	["multiple start actions"] = "Multiple Deskflow start actions matched.",
	["selection-transition"] = "The Deskflow menu selection state could not be verified.",
	["snapshot-command"] = "The Deskflow process inventory helper failed.",
	["snapshot-parse"] = "The Deskflow process inventory returned invalid data.",
	["start action unavailable"] = "No enabled Deskflow start action was available.",
	stopped = "Deskflow recovery stopped before completion.",
}

local cooldownReasonMessages = {
	["accessibility-permission"] = "Hammerspoon Accessibility permission is required to recover Deskflow",
	["core-verification-timeout"] = "the expected Deskflow core did not appear",
	["gui-activation-timeout"] = "the Deskflow GUI did not become active",
	["menu-selection"] = "the Deskflow start action could not be selected",
}

local function alertMessage(decision)
	local reason = decision.reason
	local message = reasonMessages[reason] or ("Deskflow recovery could not continue (" .. reason .. ").")
	if decision.key == "recovery:cooldown" then
		local cooldownReason = cooldownReasonMessages[reason]
		if cooldownReason == nil then
			cooldownReason = message
			if cooldownReason:sub(-1) == "." then
				cooldownReason = cooldownReason:sub(1, -2)
			end
		end
		return "Deskflow recovery failed repeatedly: " .. cooldownReason .. ". Recovery is paused for 300 seconds."
	end
	return message
end

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
	local eligibilityDeadline
	local eligibilityTimer
	local epoch = 0
	local lifecycleWatcher
	local lifecycleWatcherRunning = false
	local pollTimer
	local pollTimerRunning = false
	local recoveryContext
	local lastActivationResult
	local lastPriorFocus
	local lastRecoveryApplication
	local lastRecoveryDecisions = {}
	local lastRecoveryResult
	local pendingFocus
	local sleeping = false
	local stopped = false
	local beginRecovery
	local finishRecovery
	local processDecisions
	local requestObservation
	local requestStartAction

	local function callSafely(method, ...)
		return pcall(method, ...)
	end

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
		eligibilityDeadline = nil
		eligibilityTimer = nil
	end

	local function stopRecoveryTimers(context)
		if context == nil then
			return
		end
		releaseDelayedTimer(context.verificationPollTimer)
		releaseDelayedTimer(context.verificationDeadlineTimer)
		context.verificationPollTimer = nil
		context.verificationDeadlineTimer = nil
	end

	local function report(decision)
		local message = "Deskflow watchdog [" .. decision.key .. "]: " .. alertMessage(decision)
		callSafely(hs.alert.show, message)
		callSafely(hs.printf, "%s", message)
	end

	local function releaseEligibilityTimer()
		if eligibilityTimer ~= nil then
			releaseDelayedTimer(eligibilityTimer)
			eligibilityTimer = nil
			eligibilityDeadline = nil
		end
	end

	local function scheduleEligibilityTimer(callbackEpoch)
		if sleeping or stopped then
			releaseEligibilityTimer()
			return
		end

		local deadline = state.retryAt or state.cooldownUntil
		if deadline == nil or deadline <= currentTime() then
			releaseEligibilityTimer()
			return
		end
		if eligibilityTimer ~= nil and eligibilityDeadline == deadline then
			return
		end

		releaseEligibilityTimer()
		local timer
		local callbackConsumed = false
		timer = hs.timer.doAfter(deadline - currentTime(), function()
			if callbackConsumed then
				return
			end
			callbackConsumed = true
			if eligibilityTimer == timer then
				eligibilityTimer = nil
				eligibilityDeadline = nil
			end
			releaseDelayedTimer(timer)
			if callbackEpoch ~= epoch or sleeping or stopped then
				return
			end
			requestObservation()
		end)
		eligibilityTimer = timer
		eligibilityDeadline = deadline
		delayedTimers[timer] = true
	end

	local function recordRecoveryResult(result)
		local nextState, decisions = model.recoveryResult(state, result, currentTime())
		state = nextState
		lastRecoveryResult = {
			kind = result.kind,
			reason = result.reason,
		}
		lastRecoveryDecisions = decisions
		return decisions
	end

	local function restoreFocus(context)
		if context.focusRestorationAttempted then
			return context.focusRestored
		end
		context.focusRestorationAttempted = true

		local application = context.priorFocus
		if application == nil then
			context.focusRestored = true
			return true
		end
		local runningCallSucceeded, running = callSafely(application.isRunning, application)
		if not runningCallSucceeded then
			context.focusRestored = false
			context.focusRetryable = true
			return false
		end
		if not running then
			context.focusRestored = true
			return true
		end

		context.focusRetryable = true
		local activationCallSucceeded, activated = callSafely(application.activate, application)
		context.focusRestored = activationCallSucceeded and activated == true
		return context.focusRestored
	end

	finishRecovery = function(context, result)
		if context ~= recoveryContext or context.epoch ~= epoch or sleeping or stopped or context.finished then
			return
		end

		context.finished = true
		context.menuPending = false
		stopRecoveryTimers(context)
		local decisions = recordRecoveryResult(result)
		restoreFocus(context)
		recoveryContext = nil
		processDecisions(decisions, context.epoch)
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

		local completedResult = result
		local applicationPID
		if application ~= nil then
			local pidCallSucceeded
			pidCallSucceeded, applicationPID = callSafely(application.pid, application)
			if not pidCallSucceeded then
				completedResult = { kind = "failed", reason = "gui-inventory" }
				application = nil
				applicationPID = nil
			end
		end
		if completedResult.kind == "ready" then
			local nextState = model.advanceRecovery(state, "selecting", currentTime())
			if nextState == state then
				completedResult = {
					kind = "failed",
					reason = "activation-transition",
				}
			else
				state = nextState
			end
		end

		context.application = application
		context.applicationPID = applicationPID
		context.activationResult = completedResult
		lastActivationResult = completedResult
		lastRecoveryApplication = application
		if completedResult.kind == "ready" then
			requestStartAction(context)
		else
			finishRecovery(context, completedResult)
		end
	end

	local function observe(observation, callbackEpoch)
		if callbackEpoch ~= epoch or sleeping or stopped then
			return
		end

		local nextState, decisions = model.observe(state, observation, currentTime())
		state = nextState
		processDecisions(decisions, callbackEpoch)
	end

	local function classifySnapshot(exitCode, stdout)
		if exitCode ~= 0 then
			return { kind = "error", reason = "snapshot-command" }
		end

		local records = model.parseSnapshot(stdout)
		if records == nil then
			return { kind = "error", reason = "snapshot-parse" }
		end

		local applicationsCallSucceeded, applications = callSafely(hs.application.applicationsForBundleID, bundleID)
		if not applicationsCallSucceeded or type(applications) ~= "table" then
			return { kind = "error", reason = "gui-inventory" }
		end

		local guiRecords = {}
		for _, application in ipairs(applications) do
			local pidCallSucceeded, pid = callSafely(application.pid, application)
			local pathCallSucceeded, path = callSafely(application.path, application)
			if not pidCallSucceeded or not pathCallSucceeded then
				return { kind = "error", reason = "gui-inventory" }
			end
			table.insert(guiRecords, {
				pid = pid,
				bundlePath = path,
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
		local callbackConsumed = false
		local task
		local taskCreationSucceeded
		taskCreationSucceeded, task = callSafely(hs.task.new, snapshotCommand, function(exitCode, stdout)
			if activeTask == task then
				activeTask = nil
			end
			if callbackConsumed then
				return
			end
			callbackConsumed = true
			if callbackEpoch ~= epoch or sleeping or stopped then
				return
			end

			local classificationSucceeded, observation = callSafely(classifySnapshot, exitCode, stdout)
			if not classificationSucceeded then
				observation = { kind = "error", reason = "gui-inventory" }
			end
			callback(observation, callbackEpoch)
		end, nil)
		if not taskCreationSucceeded then
			task = nil
		end
		activeTask = task

		local startCallSucceeded, started = false, false
		if task ~= nil then
			startCallSucceeded, started = callSafely(task.start, task)
		end
		if task == nil or not startCallSucceeded or not started then
			if activeTask == task then
				activeTask = nil
			end
			if callbackEpoch == epoch and not sleeping and not stopped then
				callbackConsumed = true
				callback({ kind = "error", reason = "snapshot-command" }, callbackEpoch)
			end
			return false
		end
		return true
	end

	requestObservation = function()
		if recoveryContext ~= nil then
			return false
		end
		return requestSnapshot(observe)
	end

	processDecisions = function(decisions, callbackEpoch, lifecycleContext)
		for _, decision in ipairs(decisions) do
			if callbackEpoch ~= epoch or stopped then
				return
			end

			if decision.kind == "alert" then
				report(decision)
			elseif decision.kind == "recover" and decision.phase == "activating" and not sleeping then
				local accessibilityCallSucceeded, accessibilityAvailable = callSafely(hs.accessibilityState)
				if not accessibilityCallSucceeded or accessibilityAvailable ~= true then
					local result = { kind = "unavailable", reason = "accessibility-permission" }
					lastActivationResult = result
					lastPriorFocus = nil
					lastRecoveryApplication = nil
					local followupDecisions = recordRecoveryResult(result)
					processDecisions(followupDecisions, callbackEpoch)
				else
					beginRecovery(callbackEpoch)
				end
			elseif decision.kind == "abort-recovery" and lifecycleContext ~= nil then
				lifecycleContext.finished = true
				lifecycleContext.menuPending = false
				stopRecoveryTimers(lifecycleContext)
				lifecycleContext.activationResult = { kind = "aborted", reason = "sleep" }
				lastActivationResult = lifecycleContext.activationResult
				lastRecoveryResult = { kind = "aborted", reason = "sleep" }
			elseif decision.kind == "restore-focus" and lifecycleContext ~= nil then
				if not restoreFocus(lifecycleContext) and lifecycleContext.focusRetryable then
					pendingFocus = lifecycleContext.priorFocus
				end
			end
		end

		scheduleEligibilityTimer(callbackEpoch)
	end

	local function reacquireApplication()
		local applicationsCallSucceeded, applications = callSafely(hs.application.applicationsForBundleID, bundleID)
		if not applicationsCallSucceeded or type(applications) ~= "table" then
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
		local pathCallSucceeded, path = callSafely(applications[1].path, applications[1])
		if not pathCallSucceeded then
			return nil, { kind = "failed", reason = "gui-inventory" }
		end
		if path ~= bundlePath then
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
			local pidCallSucceeded, currentPID = callSafely(currentApplication.pid, currentApplication)
			if not pidCallSucceeded then
				completeActivation(context, { kind = "failed", reason = "gui-inventory" })
				return
			end
			if currentPID ~= activatedPID then
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

	local function reacquireRecoveryApplication(context)
		local application, failure = reacquireApplication()
		if failure ~= nil then
			return nil, failure
		end
		if application == nil then
			return nil, { kind = "unavailable", reason = "gui-disappeared" }
		end
		local pidCallSucceeded, applicationPID = callSafely(application.pid, application)
		if not pidCallSucceeded then
			return nil, { kind = "failed", reason = "gui-inventory" }
		end
		if applicationPID ~= context.applicationPID then
			return nil, { kind = "ambiguous", reason = "gui-instance-changed" }
		end
		return application, nil
	end

	local function requestVerificationSnapshot(context)
		if context ~= recoveryContext or context.epoch ~= epoch or sleeping or stopped then
			return
		end

		requestSnapshot(function(observation, callbackEpoch)
			if context ~= recoveryContext or context.epoch ~= callbackEpoch then
				return
			end

			local reacquired, _, failure = callSafely(reacquireRecoveryApplication, context)
			if not reacquired then
				finishRecovery(context, { kind = "failed", reason = "gui-inventory" })
				return
			end
			if failure ~= nil then
				finishRecovery(context, failure)
				return
			end
			if observation.kind == "healthy" then
				finishRecovery(context, { kind = "recovered", reason = observation.reason })
			elseif observation.kind == "ambiguous" then
				finishRecovery(context, { kind = "ambiguous", reason = observation.reason })
			elseif observation.kind == "error" then
				finishRecovery(context, { kind = "failed", reason = observation.reason })
			end
		end)
	end

	local function startVerification(context)
		requestVerificationSnapshot(context)
		if context ~= recoveryContext then
			return
		end

		local pollTimer = hs.timer.new(verificationInterval, function()
			requestVerificationSnapshot(context)
		end)
		context.verificationPollTimer = pollTimer
		delayedTimers[pollTimer] = true
		pollTimer:start()

		local deadlineTimer
		deadlineTimer = hs.timer.doAfter(verificationTimeout, function()
			releaseDelayedTimer(deadlineTimer)
			context.verificationDeadlineTimer = nil
			finishRecovery(context, { kind = "failed", reason = "core-verification-timeout" })
		end)
		context.verificationDeadlineTimer = deadlineTimer
		delayedTimers[deadlineTimer] = true
	end

	requestStartAction = function(context)
		local reacquired, application, failure = callSafely(reacquireRecoveryApplication, context)
		if not reacquired then
			finishRecovery(context, { kind = "failed", reason = "gui-inventory" })
			return
		end
		if failure ~= nil then
			finishRecovery(context, failure)
			return
		end
		local frontmostCallSucceeded, frontmost = callSafely(application.isFrontmost, application)
		if not frontmostCallSucceeded or not frontmost then
			finishRecovery(context, { kind = "failed", reason = "gui-not-frontmost" })
			return
		end

		local function handleMenuItems(menuItems)
			if not context.menuPending then
				return
			end
			context.menuPending = false
			if context ~= recoveryContext or context.epoch ~= epoch or sleeping or stopped then
				return
			end

			local currentReacquired, currentApplication, currentFailure =
				callSafely(reacquireRecoveryApplication, context)
			if not currentReacquired then
				finishRecovery(context, { kind = "failed", reason = "gui-inventory" })
				return
			end
			if currentFailure ~= nil then
				finishRecovery(context, currentFailure)
				return
			end
			local currentFrontmostCallSucceeded, currentFrontmost =
				callSafely(currentApplication.isFrontmost, currentApplication)
			if not currentFrontmostCallSucceeded or not currentFrontmost then
				finishRecovery(context, { kind = "failed", reason = "gui-not-frontmost" })
				return
			end

			local path, menuError = model.findStartAction(menuItems, "S")
			if path == nil then
				finishRecovery(context, { kind = "unavailable", reason = menuError })
				return
			end
			local selectionCallSucceeded, selected =
				callSafely(currentApplication.selectMenuItem, currentApplication, path)
			if not selectionCallSucceeded or not selected then
				finishRecovery(context, { kind = "failed", reason = "menu-selection" })
				return
			end

			local nextState = model.advanceRecovery(state, "verifying", currentTime())
			if nextState == state then
				finishRecovery(context, { kind = "failed", reason = "selection-transition" })
				return
			end
			state = nextState
			startVerification(context)
		end

		context.menuPending = true
		local requestCallSucceeded = callSafely(application.getMenuItems, application, handleMenuItems)
		if not requestCallSucceeded and context.menuPending then
			context.menuPending = false
			finishRecovery(context, { kind = "failed", reason = "menu-enumeration" })
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
			if application ~= nil then
				local frontmostCallSucceeded, frontmost = callSafely(application.isFrontmost, application)
				if not frontmostCallSucceeded then
					finished = true
					releaseDelayedTimer(timer)
					completeActivation(context, { kind = "failed", reason = "gui-inventory" })
					return
				end
				if frontmost then
					local pidCallSucceeded, applicationPID = callSafely(application.pid, application)
					finished = true
					releaseDelayedTimer(timer)
					if not pidCallSucceeded then
						completeActivation(context, { kind = "failed", reason = "gui-inventory" })
					else
						requestRecoveryObservation(context, applicationPID)
					end
					return
				end
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
		local callbackConsumed = false
		local taskCreationSucceeded
		taskCreationSucceeded, task = callSafely(hs.task.new, guiExecutablePath, function(exitCode)
			if activeTask == task then
				activeTask = nil
			end
			if callbackConsumed then
				return
			end
			callbackConsumed = true
			if context ~= recoveryContext or context.epoch ~= epoch or sleeping or stopped then
				return
			end
			if exitCode ~= 0 then
				completeActivation(context, { kind = "failed", reason = "gui-surface" })
				return
			end
			waitForFrontmost(context)
		end, nil)
		if not taskCreationSucceeded then
			task = nil
		end
		activeTask = task

		local startCallSucceeded, started = false, false
		if task ~= nil then
			startCallSucceeded, started = callSafely(task.start, task)
		end
		if task == nil or not startCallSucceeded or not started then
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

		local priorFocusCallSucceeded, priorFocus = callSafely(hs.application.frontmostApplication)
		local context = {
			epoch = callbackEpoch,
			priorFocus = priorFocusCallSucceeded and priorFocus or nil,
		}
		recoveryContext = context
		lastActivationResult = nil
		lastPriorFocus = context.priorFocus
		lastRecoveryApplication = nil
		lastRecoveryDecisions = {}
		lastRecoveryResult = nil
		if not priorFocusCallSucceeded then
			completeActivation(context, { kind = "failed", reason = "gui-inventory" })
			return
		end

		local bundleInfoCallSucceeded, bundleInfo = callSafely(hs.application.infoForBundlePath, bundlePath)
		local registeredPathCallSucceeded, registeredPath = callSafely(hs.application.pathForBundleID, bundleID)
		if
			not bundleInfoCallSucceeded
			or not registeredPathCallSucceeded
			or type(bundleInfo) ~= "table"
			or bundleInfo.CFBundleIdentifier ~= bundleID
			or registeredPath ~= bundlePath
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
			local frontmostCallSucceeded, frontmost = callSafely(application.isFrontmost, application)
			if not frontmostCallSucceeded then
				completeActivation(context, { kind = "failed", reason = "gui-inventory" })
				return
			end
			if frontmost then
				local pidCallSucceeded, applicationPID = callSafely(application.pid, application)
				if not pidCallSucceeded then
					completeActivation(context, { kind = "failed", reason = "gui-inventory" })
					return
				end
				requestRecoveryObservation(context, applicationPID)
			else
				surfaceApplication(context)
			end
			return
		end

		local launchCallSucceeded, launched = callSafely(hs.application.launchOrFocusByBundleID, bundleID)
		if not launchCallSucceeded or not launched then
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

			local nextState, decisions = model.lifecycle(state, "sleep", currentTime())
			state = nextState
			sleeping = true
			local context = recoveryContext
			if context ~= nil and context.epoch == epoch then
				lastRecoveryDecisions = decisions
				processDecisions(decisions, epoch, context)
				recoveryContext = nil
			else
				processDecisions(decisions, epoch)
			end
			if pollTimerRunning then
				pollTimer:stop()
				pollTimerRunning = false
			end
			stopDelayedTimers()
			epoch = epoch + 1
		elseif event == hs.caffeinate.watcher.systemDidWake and sleeping then
			epoch = epoch + 1
			if pendingFocus ~= nil then
				local runningCallSucceeded, running = callSafely(pendingFocus.isRunning, pendingFocus)
				if runningCallSucceeded and running then
					callSafely(pendingFocus.activate, pendingFocus)
				end
				pendingFocus = nil
			end
			local nextState, decisions = model.lifecycle(state, "wake", currentTime())
			state = nextState
			sleeping = false
			processDecisions(decisions, epoch)
			pollTimer:start()
			pollTimerRunning = true
		end
	end

	function controller:stop()
		if stopped then
			return
		end

		if recoveryContext ~= nil then
			finishRecovery(recoveryContext, { kind = "failed", reason = "stopped" })
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

		local activationResult = lastActivationResult
		local menuPending = false
		local priorFocus = lastPriorFocus
		local recoveryApplication = lastRecoveryApplication
		if recoveryContext ~= nil then
			if recoveryContext.activationResult ~= nil then
				activationResult = recoveryContext.activationResult
			end
			if recoveryContext.priorFocus ~= nil then
				priorFocus = recoveryContext.priorFocus
			end
			if recoveryContext.application ~= nil then
				recoveryApplication = recoveryContext.application
			end
			menuPending = recoveryContext.menuPending == true
		end

		local activationResultCopy
		if activationResult ~= nil then
			activationResultCopy = {
				kind = activationResult.kind,
				reason = activationResult.reason,
			}
		end
		local recoveryResultCopy
		if lastRecoveryResult ~= nil then
			recoveryResultCopy = {
				kind = lastRecoveryResult.kind,
				reason = lastRecoveryResult.reason,
			}
		end
		local recoveryDecisions = {}
		for _, decision in ipairs(lastRecoveryDecisions) do
			local decisionCopy = {}
			for key, value in pairs(decision) do
				decisionCopy[key] = value
			end
			table.insert(recoveryDecisions, decisionCopy)
		end

		return {
			activationResult = activationResultCopy,
			absenceCount = state.absenceCount,
			cooldownUntil = state.cooldownUntil,
			delayedTimerCount = delayedTimerCount,
			eligibilityDeadline = eligibilityDeadline,
			epoch = epoch,
			graceUntil = state.graceUntil,
			lastTimestamp = state.lastTimestamp,
			lifecycleWatcherRunning = lifecycleWatcherRunning,
			menuPending = menuPending,
			observationInFlight = activeTask ~= nil,
			pendingFocusPID = pendingFocus ~= nil and pendingFocus:pid() or nil,
			persistentAlertKey = state.persistentAlertKey,
			phase = state.phase,
			pollTimerRunning = pollTimerRunning,
			priorFocusPID = priorFocus ~= nil and priorFocus:pid() or nil,
			recoveryApplicationPID = recoveryApplication ~= nil and recoveryApplication:pid() or nil,
			recoveryDecisions = recoveryDecisions,
			recoveryResult = recoveryResultCopy,
			retryAt = state.retryAt,
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
