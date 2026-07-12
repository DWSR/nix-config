local source = debug.getinfo(1, "S").source
local testDirectory = assert(source:match("^@(.*/)"), "cannot locate model test directory")
local modelPath = testDirectory .. "../../home-manager/common/hammerspoon-deskflow-watchdog/model.lua"
local fixturePath = testDirectory .. "fixtures.lua"

local modelEnvironment = {
	ipairs = ipairs,
	math = math,
	pairs = pairs,
	string = string,
	table = table,
	tonumber = tonumber,
	type = type,
}
local modelChunk, modelLoadError = loadfile(modelPath, "t", modelEnvironment)
assert(modelChunk, modelLoadError)
local model = modelChunk()
assert(type(model) == "table", "model.lua must return a module table")
assert(type(model.parseSnapshot) == "function", "model.lua must export parseSnapshot")
assert(type(model.classify) == "function", "model.lua must export classify")

local fixtureChunk, fixtureLoadError = loadfile(fixturePath, "t", {})
assert(fixtureChunk, fixtureLoadError)
local fixtures = fixtureChunk()

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

local function assertParseError(snapshot, context)
	local records, parseError = model.parseSnapshot(snapshot)
	assert(records == nil, context .. " must not return partial records")
	assert(type(parseError) == "string" and parseError ~= "", context .. " must return a parse error")
end

local function expected(role)
	return {
		bundlePath = fixtures.constants.bundlePath,
		role = role,
	}
end

local function assertNoRecovery(observation, context)
	assert(observation.kind == "ambiguous" or observation.kind == "error", context .. " must fail closed")
	assert(observation.recover == nil, context .. " must not request recovery")
	assert(observation.action == nil, context .. " must not expose a recovery action")
	assert(observation.decisions == nil, context .. " must not emit recovery decisions")
end

test("parseSnapshot preserves spaces and decodes the approved field escapes", function()
	local snapshot =
		"5101\t5100\t/Applications/Deskflow Test.app/Contents/MacOS/core%25copy%09tab%0Dcr%0Alf\tcli%25ent\n"
	local records, parseError = model.parseSnapshot(snapshot)
	assert(records, parseError)
	assertEqual(#records, 1, "decoded snapshot record count")
	assertEqual(records[1].pid, 5101, "decoded PID")
	assertEqual(records[1].ppid, 5100, "decoded parent PID")
	assertEqual(
		records[1].executablePath,
		"/Applications/Deskflow Test.app/Contents/MacOS/core%copy\ttab\rcr\nlf",
		"decoded executable path"
	)
	assertEqual(records[1].role, "cli%ent", "decoded role")
end)

test("parseSnapshot accepts empty input and represents an empty role as nil", function()
	local emptyRecords, emptyError = model.parseSnapshot("")
	assert(emptyRecords, emptyError)
	assertEqual(#emptyRecords, 0, "empty snapshot record count")

	local records, parseError =
		model.parseSnapshot("5201\t0\t/Applications/Deskflow.app/Contents/MacOS/deskflow-core\t\n")
	assert(records, parseError)
	assertEqual(records[1].ppid, 0, "zero parent PID")
	assert(records[1].role == nil, "empty role must decode to nil")
end)

test("parseSnapshot rejects malformed rows and invalid fields", function()
	local malformedSnapshots = {
		{ "non-string input", false },
		{ "missing final newline", "5301\t5300\t/absolute/core\tserver" },
		{ "empty row", "\n" },
		{ "missing field", "5301\t5300\t/absolute/core\n" },
		{ "extra field", "5301\t5300\t/absolute/core\tserver\textra\n" },
		{ "zero PID", "0\t0\t/absolute/core\tserver\n" },
		{ "leading-zero PID", "05301\t0\t/absolute/core\tserver\n" },
		{ "negative parent PID", "5301\t-1\t/absolute/core\tserver\n" },
		{ "leading-zero parent PID", "5301\t00\t/absolute/core\tserver\n" },
		{ "relative path", "5301\t5300\trelative/core\tserver\n" },
		{ "unsupported escape", "5301\t5300\t/absolute/core%20copy\tserver\n" },
		{ "truncated escape", "5301\t5300\t/absolute/core%2\tserver\n" },
		{ "raw carriage return", "5301\t5300\t/absolute/core\tserv\rer\n" },
		{ "embedded NUL", "5301\t5300\t/absolute/core\tserv\0er\n" },
		{ "overflowing PID", "999999999999999999999999999999\t0\t/absolute/core\tserver\n" },
	}

	for _, malformed in ipairs(malformedSnapshots) do
		assertParseError(malformed[2], malformed[1])
	end
end)

test("parseSnapshot returns no partial state after a later malformed row", function()
	assertParseError(
		"5401\t5400\t/Applications/Deskflow.app/Contents/MacOS/deskflow-core\tserver\n" .. "broken\trow\n",
		"later malformed row"
	)
end)

test("classify matches every committed process fixture", function()
	for fixtureName, fixture in pairs(fixtures.process) do
		local records, parseError = model.parseSnapshot(fixture.snapshot)
		assert(records, fixtureName .. ": " .. tostring(parseError))

		local observation = model.classify(records, fixture.guiRecords, expected(fixture.expectedRole))
		assertEqual(observation.kind, fixture.expectedClassification, fixtureName .. " classification")
		assert(type(observation.reason) == "string" and observation.reason ~= "", fixtureName .. " needs a reason")
		if observation.kind == "ambiguous" or observation.kind == "error" then
			assertNoRecovery(observation, fixtureName)
		end
	end
end)

test("classify accepts only exact client and server ownership", function()
	for _, fixtureName in ipairs({ "healthyClient", "healthyServer" }) do
		local fixture = fixtures.process[fixtureName]
		local records = assert(model.parseSnapshot(fixture.snapshot))
		local observation = model.classify(records, fixture.guiRecords, expected(fixture.expectedRole))
		assertEqual(observation.kind, "healthy", fixtureName)
	end

	local clientFixture = fixtures.process.healthyClient
	local clientRecords = assert(model.parseSnapshot(clientFixture.snapshot))
	local wrongCase = model.classify(clientRecords, clientFixture.guiRecords, expected("Client"))
	assertEqual(wrongCase.kind, "error", "invalid declared role")
	assertNoRecovery(wrongCase, "invalid declared role")
end)

test("classify recognizes both valid zero-core absence states", function()
	local withoutGui = model.classify({}, {}, expected("server"))
	assertEqual(withoutGui.kind, "absent", "zero GUI and zero core")

	local fixture = fixtures.process.absent
	local withGui = model.classify({}, fixture.guiRecords, expected(fixture.expectedRole))
	assertEqual(withGui.kind, "absent", "one expected GUI and zero core")
end)

test("classify treats every additional ownership conflict as ambiguous", function()
	local corePath = fixtures.constants.coreExecutablePath
	local bundlePath = fixtures.constants.bundlePath
	local conflictCases = {
		{
			name = "core without GUI",
			records = { { pid = 6101, ppid = 6100, executablePath = corePath, role = "server" } },
			guis = {},
		},
		{
			name = "wrong parent",
			records = { { pid = 6201, ppid = 1, executablePath = corePath, role = "server" } },
			guis = { { pid = 6200, bundlePath = bundlePath } },
		},
		{
			name = "wrong-path GUI without core",
			records = {},
			guis = { { pid = 6300, bundlePath = "/Applications/Deskflow Preview.app" } },
		},
		{
			name = "mixed expected and wrong-path GUIs",
			records = {},
			guis = {
				{ pid = 6400, bundlePath = bundlePath },
				{ pid = 6401, bundlePath = "/Applications/Deskflow Preview.app" },
			},
		},
		{
			name = "empty observed role",
			records = { { pid = 6501, ppid = 6500, executablePath = corePath, role = nil } },
			guis = { { pid = 6500, bundlePath = bundlePath } },
		},
	}

	for _, conflict in ipairs(conflictCases) do
		local observation = model.classify(conflict.records, conflict.guis, expected("server"))
		assertEqual(observation.kind, "ambiguous", conflict.name)
		assertNoRecovery(observation, conflict.name)
	end
end)

test("classify maps malformed model inputs to error without decisions", function()
	local malformedCases = {
		{ "parse failure", nil, {}, expected("server") },
		{
			"invalid process record",
			{ { pid = 0, ppid = 1, executablePath = "/core", role = "server" } },
			{},
			expected("server"),
		},
		{ "invalid GUI record", {}, { { pid = 0, bundlePath = fixtures.constants.bundlePath } }, expected("server") },
		{ "invalid expected bundle", {}, {}, { bundlePath = "relative/app", role = "server" } },
	}

	for _, malformed in ipairs(malformedCases) do
		local observation = model.classify(malformed[2], malformed[3], malformed[4])
		assertEqual(observation.kind, "error", malformed[1])
		assertNoRecovery(observation, malformed[1])
	end
end)

print("Deskflow watchdog model tests passed (" .. testCount .. " cases)")
