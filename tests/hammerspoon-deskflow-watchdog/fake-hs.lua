local FakeHs = {}

local function copy(value, seen)
	if type(value) ~= "table" then
		return value
	end

	seen = seen or {}
	if seen[value] then
		return seen[value]
	end

	local result = {}
	seen[value] = result
	for key, item in pairs(value) do
		result[copy(key, seen)] = copy(item, seen)
	end
	return result
end

function FakeHs.new(options)
	options = options or {}

	local fake = {
		_now = options.now or 0,
		_accessibilityState = options.accessibilityState ~= false,
		_nextHandle = 0,
		_nextAlert = 0,
		_sequence = 0,
		_timers = {},
		_tasks = {},
		_applications = {},
		_bundleInfo = {},
		_bundleInfoPaths = {},
		_launchResults = {},
		_menuRequests = {},
		_pendingMenus = {},
		_watchers = {},
		effects = {},
	}

	local function nextHandle()
		fake._nextHandle = fake._nextHandle + 1
		return fake._nextHandle
	end

	function fake:_record(kind, details)
		self._sequence = self._sequence + 1
		local effect = {
			at = self._now,
			kind = kind,
			sequence = self._sequence,
		}
		for key, value in pairs(details or {}) do
			effect[key] = copy(value)
		end
		table.insert(self.effects, effect)
		return effect
	end

	function fake:time()
		return self._now
	end

	function fake:effectsOf(kind)
		local matches = {}
		for _, effect in ipairs(self.effects) do
			if effect.kind == kind then
				table.insert(matches, effect)
			end
		end
		return matches
	end

	function fake:clearEffects()
		self.effects = {}
		self._sequence = 0
	end

	local timerMethods = {}
	timerMethods.__index = timerMethods

	function timerMethods:start()
		if not self._running then
			self._running = true
			self._due = fake._now + self._interval
			fake:_record("timer.start", {
				handle = self._handle,
				due = self._due,
			})
		end
		return self
	end

	function timerMethods:stop()
		if self._running then
			fake:_record("timer.stop", { handle = self._handle })
		end
		self._running = false
		self._due = nil
		return self
	end

	function timerMethods:running()
		return self._running
	end

	function timerMethods:isRunning()
		return self._running
	end

	local function newTimer(interval, callback, repeats)
		assert(type(interval) == "number" and interval > 0, "timer interval must be positive")
		assert(type(callback) == "function", "timer callback must be a function")

		local timer = setmetatable({
			_handle = nextHandle(),
			_interval = interval,
			_callback = callback,
			_repeats = repeats,
			_running = false,
		}, timerMethods)
		table.insert(fake._timers, timer)
		fake:_record("timer.new", {
			handle = timer._handle,
			interval = interval,
			repeats = repeats,
		})
		return timer
	end

	function fake:advance(seconds)
		assert(type(seconds) == "number" and seconds >= 0, "advance duration must be non-negative")
		local target = self._now + seconds

		while true do
			local nextTimer
			for _, timer in ipairs(self._timers) do
				if timer._running and timer._due <= target then
					if
						nextTimer == nil
						or timer._due < nextTimer._due
						or (timer._due == nextTimer._due and timer._handle < nextTimer._handle)
					then
						nextTimer = timer
					end
				end
			end

			if nextTimer == nil then
				break
			end

			local callbackTime = nextTimer._due
			self._now = callbackTime
			nextTimer._due = nil
			if not nextTimer._repeats then
				nextTimer._running = false
			end
			self:_record("timer.callback", { handle = nextTimer._handle })
			nextTimer._callback()
			if nextTimer._repeats and nextTimer._running and nextTimer._due == nil then
				nextTimer._due = callbackTime + nextTimer._interval
			end
		end

		self._now = target
	end

	local taskMethods = {}
	taskMethods.__index = taskMethods

	function taskMethods:start()
		if self._completed or self._terminated then
			return false
		end
		if not self._running then
			self._running = true
			fake:_record("task.start", {
				handle = self._handle,
				path = self._path,
			})
		end
		return self
	end

	function taskMethods:terminate()
		if not self._completed and not self._terminated then
			self._running = false
			self._terminated = true
			fake:_record("task.terminate", {
				handle = self._handle,
				path = self._path,
			})
		end
		return self
	end

	function taskMethods:isRunning()
		return self._running
	end

	function fake:completeTask(task, exitCode, stdout, stderr)
		if task == nil or not task._running or task._completed or task._terminated then
			return false
		end

		task._running = false
		task._completed = true
		self:_record("task.callback", {
			exitCode = exitCode,
			handle = task._handle,
			stderr = stderr,
			stdout = stdout,
		})
		if task._callback then
			task._callback(exitCode, stdout, stderr)
		end
		return true
	end

	function fake:repeatTaskCallback(task, exitCode, stdout, stderr)
		if task == nil or task._callback == nil then
			return false
		end
		self:_record("task.callback", {
			exitCode = exitCode,
			handle = task._handle,
			repeated = true,
			stderr = stderr,
			stdout = stdout,
		})
		task._callback(exitCode, stdout, stderr)
		return true
	end

	function fake:runningTasks(path)
		assert(path == nil or type(path) == "string", "task path filter must be a string or nil")
		local tasks = {}
		for _, task in ipairs(self._tasks) do
			if task._running and (path == nil or task._path == path) then
				table.insert(tasks, task)
			end
		end
		return tasks
	end

	local applicationMethods = {}
	applicationMethods.__index = applicationMethods

	function applicationMethods:bundleID()
		return self._bundleID
	end

	function applicationMethods:path()
		return self._path
	end

	function applicationMethods:pid()
		return self._pid
	end

	function applicationMethods:name()
		return self._name
	end

	function applicationMethods:isRunning()
		return self._running
	end

	function applicationMethods:isFrontmost()
		return self._running and fake._frontmostApplication == self
	end

	function applicationMethods:activate(allWindows)
		fake:_record("application.activate", {
			allWindows = allWindows,
			bundleID = self._bundleID,
			pid = self._pid,
		})
		if self._activationError ~= nil then
			error(self._activationError)
		end
		if not self._running or not self._activationResult then
			return false
		end
		fake._frontmostApplication = self
		return true
	end

	function applicationMethods:getMenuItems(callback)
		assert(type(callback) == "function", "menu callback must be a function")
		if self._menuRequestError ~= nil then
			error(self._menuRequestError)
		end
		local request = {
			app = self,
			callback = callback,
			handle = nextHandle(),
		}
		table.insert(fake._menuRequests, request)
		table.insert(fake._pendingMenus, request)
		fake:_record("menu.request", {
			handle = request.handle,
			pid = self._pid,
		})
	end

	function applicationMethods:selectMenuItem(path)
		fake:_record("menu.select", {
			path = path,
			pid = self._pid,
		})
		if self._menuSelectionError ~= nil then
			error(self._menuSelectionError)
		end
		local selectionHook = self._nextMenuSelectionHook
		self._nextMenuSelectionHook = nil
		if selectionHook ~= nil then
			selectionHook()
		end
		return self._running and self._menuSelectionResult
	end

	function fake:addApplication(spec)
		assert(type(spec) == "table", "application spec must be a table")
		assert(type(spec.bundleID) == "string", "application bundleID must be a string")
		assert(type(spec.path) == "string", "application path must be a string")
		assert(type(spec.pid) == "number", "application pid must be a number")

		local application = setmetatable({
			_handle = nextHandle(),
			_activationError = spec.activationError,
			_activationResult = spec.activationResult ~= false,
			_bundleID = spec.bundleID,
			_menuItems = copy(spec.menuItems or {}),
			_menuRequestError = spec.menuRequestError,
			_menuSelectionError = spec.menuSelectionError,
			_menuSelectionResult = spec.menuSelectionResult ~= false,
			_name = spec.name,
			_path = spec.path,
			_pid = spec.pid,
			_running = spec.running ~= false,
		}, applicationMethods)
		table.insert(self._applications, application)
		if spec.frontmost then
			assert(application._running, "frontmost application must be running")
			self._frontmostApplication = application
		end
		return application
	end

	function fake:setApplicationRunning(application, running)
		application._running = running
		if not running and self._frontmostApplication == application then
			self._frontmostApplication = nil
		end
	end

	function fake:setFrontmostApplication(application)
		assert(application == nil or application._running, "frontmost application must be running")
		self._frontmostApplication = application
	end

	function fake:setActivationResult(application, result)
		application._activationResult = result
	end

	function fake:setActivationError(application, message)
		assert(message == nil or type(message) == "string", "activation error must be a string or nil")
		application._activationError = message
	end

	function fake:setMenuItems(application, items)
		application._menuItems = copy(items)
	end

	function fake:setMenuRequestError(application, message)
		assert(message == nil or type(message) == "string", "menu request error must be a string or nil")
		application._menuRequestError = message
	end

	function fake:setMenuSelectionError(application, message)
		assert(message == nil or type(message) == "string", "menu selection error must be a string or nil")
		application._menuSelectionError = message
	end

	function fake:setNextMenuSelectionHook(application, hook)
		assert(hook == nil or type(hook) == "function", "menu selection hook must be a function or nil")
		application._nextMenuSelectionHook = hook
	end

	function fake:setMenuSelectionResult(application, result)
		application._menuSelectionResult = result
	end

	function fake:pendingMenuCount()
		return #self._pendingMenus
	end

	function fake:pendingMenuRequests()
		local requests = {}
		for _, request in ipairs(self._pendingMenus) do
			table.insert(requests, {
				handle = request.handle,
				pid = request.app._pid,
			})
		end
		return requests
	end

	function fake:completeNextMenu(items)
		local request = table.remove(self._pendingMenus, 1)
		if request == nil then
			return false
		end

		local menuItems = copy(items or request.app._menuItems)
		self:_record("menu.callback", {
			handle = request.handle,
			items = menuItems,
			pid = request.app._pid,
		})
		request.callback(menuItems)
		return true
	end

	function fake:repeatMenuCallback(handle, items)
		assert(type(handle) == "number", "menu callback handle must be a number")
		for _, request in ipairs(self._menuRequests) do
			if request.handle == handle then
				local menuItems = copy(items or request.app._menuItems)
				self:_record("menu.callback", {
					handle = request.handle,
					items = menuItems,
					pid = request.app._pid,
					repeated = true,
				})
				request.callback(menuItems)
				return true
			end
		end
		return false
	end

	function fake:setBundleInfo(path, info)
		if self._bundleInfo[path] == nil then
			table.insert(self._bundleInfoPaths, path)
		end
		self._bundleInfo[path] = copy(info)
	end

	function fake:setLaunchResult(bundleID, result, application)
		self._launchResults[bundleID] = {
			application = application,
			result = result,
		}
	end

	local watcherMethods = {}
	watcherMethods.__index = watcherMethods

	function watcherMethods:start()
		if not self._running then
			self._running = true
			fake:_record("lifecycle.start", { handle = self._handle })
		end
		return self
	end

	function watcherMethods:stop()
		if self._running then
			fake:_record("lifecycle.stop", { handle = self._handle })
		end
		self._running = false
		return self
	end

	function watcherMethods:running()
		return self._running
	end

	function fake:fireLifecycle(event)
		self:_record("lifecycle.event", { event = event })
		local activeWatchers = {}
		for _, watcher in ipairs(self._watchers) do
			if watcher._running then
				table.insert(activeWatchers, watcher)
			end
		end
		for _, watcher in ipairs(activeWatchers) do
			if watcher._running then
				self:_record("lifecycle.callback", {
					event = event,
					handle = watcher._handle,
				})
				watcher._callback(event)
			end
		end
	end

	function fake:setAccessibilityState(state)
		self._accessibilityState = state
	end

	local hs = {
		alert = {},
		application = {},
		caffeinate = { watcher = {} },
		task = {},
		timer = {},
	}

	function hs.accessibilityState(shouldPrompt)
		if shouldPrompt then
			fake:_record("accessibility.prompt")
		end
		return fake._accessibilityState
	end

	function hs.timer.new(interval, callback)
		return newTimer(interval, callback, true)
	end

	function hs.timer.doEvery(interval, callback)
		return newTimer(interval, callback, true):start()
	end

	function hs.timer.doAfter(interval, callback)
		return newTimer(interval, callback, false):start()
	end

	function hs.timer.secondsSinceEpoch()
		return fake._now
	end

	function hs.task.new(path, callback, streamCallback, arguments)
		if type(streamCallback) == "table" and arguments == nil then
			arguments = streamCallback
			streamCallback = nil
		end
		assert(type(path) == "string", "task path must be a string")
		assert(callback == nil or type(callback) == "function", "task callback must be a function or nil")
		assert(streamCallback == nil, "task stream callbacks are outside the watchdog runtime contract")

		local task = setmetatable({
			_handle = nextHandle(),
			_arguments = copy(arguments or {}),
			_callback = callback,
			_completed = false,
			_path = path,
			_running = false,
			_terminated = false,
		}, taskMethods)
		table.insert(fake._tasks, task)
		fake:_record("task.new", {
			arguments = task._arguments,
			handle = task._handle,
			path = path,
		})
		return task
	end

	function hs.application.applicationsForBundleID(bundleID)
		local applications = {}
		for _, application in ipairs(fake._applications) do
			if application._running and application._bundleID == bundleID then
				table.insert(applications, application)
			end
		end
		return applications
	end

	function hs.application.frontmostApplication()
		if fake._frontmostApplication and fake._frontmostApplication._running then
			return fake._frontmostApplication
		end
		return nil
	end

	function hs.application.infoForBundlePath(path)
		return copy(fake._bundleInfo[path])
	end

	function hs.application.pathForBundleID(bundleID)
		for _, path in ipairs(fake._bundleInfoPaths) do
			local info = fake._bundleInfo[path]
			if info.CFBundleIdentifier == bundleID then
				return path
			end
		end
		return nil
	end

	function hs.application.launchOrFocusByBundleID(bundleID)
		local configured = fake._launchResults[bundleID]
		local result = configured ~= nil and configured.result or false
		fake:_record("application.launch", {
			bundleID = bundleID,
			result = result,
		})
		if result and configured.application then
			configured.application._running = true
			fake._frontmostApplication = configured.application
		end
		return result
	end

	hs.caffeinate.watcher.systemWillSleep = "systemWillSleep"
	hs.caffeinate.watcher.systemDidWake = "systemDidWake"

	function hs.caffeinate.watcher.new(callback)
		assert(type(callback) == "function", "lifecycle callback must be a function")
		local watcher = setmetatable({
			_callback = callback,
			_handle = nextHandle(),
			_running = false,
		}, watcherMethods)
		table.insert(fake._watchers, watcher)
		fake:_record("lifecycle.new", { handle = watcher._handle })
		return watcher
	end

	function hs.alert.show(message, style, screen, seconds)
		fake._nextAlert = fake._nextAlert + 1
		local alertID = "alert-" .. fake._nextAlert
		fake:_record("alert.show", {
			id = alertID,
			message = message,
			screen = screen,
			seconds = seconds,
			style = style,
		})
		return alertID
	end

	fake.hs = hs
	return fake
end

return FakeHs
