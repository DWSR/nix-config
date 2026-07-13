local fakeHsPath, clientPath, serverPath, snapshotCommand = ...

local function loadModule(path, environment)
	local chunk, loadError = loadfile(path, "t", environment)
	assert(chunk, loadError)
	local loaded, module = pcall(chunk)
	assert(loaded, module)
	return module
end

local FakeHs = loadModule(fakeHsPath, {
	assert = assert,
	error = error,
	ipairs = ipairs,
	pairs = pairs,
	setmetatable = setmetatable,
	table = table,
	type = type,
})

local function executeRendered(path)
	local fake = FakeHs.new()
	local environment = {
		assert = assert,
		hs = fake.hs,
		ipairs = ipairs,
		math = math,
		pairs = pairs,
		pcall = pcall,
		string = string,
		table = table,
		tonumber = tonumber,
		type = type,
	}
	local originalValues = {}
	for key, value in pairs(environment) do
		originalValues[key] = value
	end

	local chunk, loadError = loadfile(path, "t", environment)
	assert(chunk, loadError)
	local executed, executionError = pcall(chunk)
	assert(executed, executionError)

	for key in pairs(environment) do
		assert(originalValues[key] ~= nil, "rendered chunk leaked global " .. tostring(key))
	end
	for key, value in pairs(originalValues) do
		assert(environment[key] == value, "rendered chunk changed global " .. tostring(key))
	end

	assert(#fake:effectsOf("timer.start") == 1, "rendered chunk must start one poll timer")
	assert(#fake:effectsOf("lifecycle.start") == 1, "rendered chunk must start one lifecycle watcher")
	fake:advance(5)
	local tasks = fake:effectsOf("task.new")
	assert(#tasks == 1, "rendered chunk must request one snapshot after the first poll")
	assert(tasks[1].path == snapshotCommand, "rendered chunk must use the exact snapshot command")
	assert(#tasks[1].arguments == 0, "rendered chunk must not add snapshot arguments")
end

executeRendered(clientPath)
executeRendered(serverPath)

print("render execution: 2 cases passed")
