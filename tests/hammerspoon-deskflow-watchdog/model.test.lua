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
assert(type(model.findStartAction) == "function", "model.lua must export findStartAction")
assert(type(model.new) == "function", "model.lua must export new")
assert(type(model.observe) == "function", "model.lua must export observe")
assert(type(model.advanceRecovery) == "function", "model.lua must export advanceRecovery")
assert(type(model.recoveryResult) == "function", "model.lua must export recoveryResult")
assert(type(model.lifecycle) == "function", "model.lua must export lifecycle")

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

local function assertPath(actual, expectedPath, context)
	assert(type(actual) == "table", context .. " must return a path")
	assertEqual(#actual, #expectedPath, context .. " path depth")
	for index, expectedTitle in ipairs(expectedPath) do
		assertEqual(actual[index], expectedTitle, context .. " title " .. index)
	end
end

local function assertMenuError(menuTree, context)
	local path, menuError = model.findStartAction(menuTree, "S")
	assert(path == nil, context .. " must not return a path")
	assert(type(menuError) == "string" and menuError ~= "", context .. " must return an error")
end

local function assertMalformedMenuError(menuTree, context)
	local returned, path, menuError = pcall(model.findStartAction, menuTree, "S")
	assert(returned, context .. " must return an error instead of throwing")
	assert(path == nil, context .. " must not return a path")
	assertEqual(menuError, "invalid menu tree", context .. " error")
end

local function wrappedMenu(title, items)
	return {
		AXRole = "AXMenuBarItem",
		AXTitle = title,
		AXChildren = { items },
	}
end

local function startLeaf(title, shortcut)
	return {
		AXRole = "AXMenuItem",
		AXTitle = title,
		AXEnabled = true,
		AXMenuItemCmdChar = shortcut or "S",
		AXMenuItemCmdModifiers = { "cmd" },
	}
end

local function policy(overrides)
	local value = {
		absenceThreshold = 2,
		startupGrace = 15,
		wakeGrace = 15,
		attemptLimit = 3,
		recoveryWindow = 300,
		retryDelays = { 5, 15 },
		cooldown = 300,
	}
	for key, override in pairs(overrides or {}) do
		value[key] = override
	end
	return value
end

local function assertDecisionKinds(decisions, expectedKinds, context)
	assert(type(decisions) == "table", context .. " must return decisions")
	assertEqual(#decisions, #expectedKinds, context .. " decision count")
	for index, expectedKind in ipairs(expectedKinds) do
		assertEqual(decisions[index].kind, expectedKind, context .. " decision " .. index)
	end
end

local function assertExactDecision(actual, expected, context)
	assert(type(actual) == "table", context .. " must return a decision")
	local actualCount = 0
	for key, value in pairs(actual) do
		actualCount = actualCount + 1
		assertEqual(value, expected[key], context .. " field " .. tostring(key))
	end
	local expectedCount = 0
	for key, value in pairs(expected) do
		expectedCount = expectedCount + 1
		assertEqual(actual[key], value, context .. " field " .. tostring(key))
	end
	assertEqual(actualCount, expectedCount, context .. " field count")
end

local function startRecovery(state, firstAbsenceAt, secondAbsenceAt)
	local firstMiss, firstDecisions = model.observe(state, { kind = "absent" }, firstAbsenceAt)
	assertDecisionKinds(firstDecisions, {}, "first recovery absence")
	local recovering, recoveryDecisions = model.observe(firstMiss, { kind = "absent" }, secondAbsenceAt)
	assertDecisionKinds(recoveryDecisions, { "recover" }, "recovery admission")
	assertEqual(recovering.phase, "activating", "recovery admission phase")
	return recovering
end

local function enterCooldown()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local firstBackoff = model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
	local secondFirst = model.observe(firstBackoff, { kind = "absent" }, 11)
	local secondRecovery = model.observe(secondFirst, { kind = "absent" }, 16)
	local secondBackoff = model.recoveryResult(secondRecovery, { kind = "failed", reason = "verification-timeout" }, 17)
	local thirdFirst = model.observe(secondBackoff, { kind = "absent" }, 32)
	local thirdRecovery = model.observe(thirdFirst, { kind = "absent" }, 37)
	return model.recoveryResult(thirdRecovery, { kind = "failed", reason = "verification-timeout" }, 38)
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

test("findStartAction derives server and localized client menu paths", function()
	for _, fixtureName in ipairs({ "serverStart", "clientStartLocalized" }) do
		local fixture = fixtures.menus[fixtureName]
		local path, menuError = model.findStartAction(fixture.tree, "S")
		assert(path, fixtureName .. ": " .. tostring(menuError))
		assertPath(path, fixture.expectedPath, fixtureName)
	end
end)

test("findStartAction rejects unavailable and ambiguous fixture trees", function()
	for _, fixtureName in ipairs({ "disabledOnly", "zeroCandidates", "multipleCandidates" }) do
		assertMenuError(fixtures.menus[fixtureName].tree, fixtureName)
	end
end)

test("findStartAction counts only enabled matching leaves", function()
	local tree = {
		{
			AXTitle = "Fichier",
			AXChildren = {
				{
					AXTitle = "Indisponible",
					AXEnabled = false,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd" },
				},
				{
					AXTitle = "Demarrer",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd" },
				},
			},
		},
	}

	local path, menuError = model.findStartAction(tree, "S")
	assert(path, tostring(menuError))
	assertPath(path, { "Fichier", "Demarrer" }, "enabled leaf")
end)

test("findStartAction requires the exact Command modifier set", function()
	local tree = {
		{
			AXTitle = "Actions",
			AXChildren = {
				{
					AXTitle = "Commande puis Majuscule",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd", "shift" },
				},
				{
					AXTitle = "Majuscule puis Commande",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "shift", "cmd" },
				},
				{
					AXTitle = "Commande dupliquee",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd", "cmd" },
				},
				{
					AXTitle = "Demarrer",
					AXEnabled = true,
					AXMenuItemCmdChar = "s",
					AXMenuItemCmdModifiers = { "cmd" },
				},
			},
		},
	}

	local path, menuError = model.findStartAction(tree, "S")
	assert(path, tostring(menuError))
	assertPath(path, { "Actions", "Demarrer" }, "exact modifiers")
end)

test("findStartAction ignores matching parents and preserves the full hierarchy", function()
	local tree = {
		{
			AXTitle = "Outils",
			AXEnabled = true,
			AXMenuItemCmdChar = "S",
			AXMenuItemCmdModifiers = { "cmd" },
			AXChildren = {
				{
					AXTitle = "Controle",
					AXChildren = {
						{
							AXTitle = "Relancer",
							AXEnabled = true,
							AXMenuItemCmdChar = "S",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
			},
		},
	}

	local path, menuError = model.findStartAction(tree, "S")
	assert(path, tostring(menuError))
	assertPath(path, { "Outils", "Controle", "Relancer" }, "nested leaf")
end)

test("findStartAction rejects an untitled ancestor instead of returning an incomplete path", function()
	assertMalformedMenuError({
		{
			AXChildren = {
				{
					AXTitle = "Demarrer",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd" },
				},
			},
		},
	}, "untitled ancestor")
	assertMalformedMenuError({
		{
			AXTitle = "",
			AXChildren = {
				{
					AXTitle = "Demarrer",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd" },
				},
			},
		},
	}, "empty-title ancestor")
end)

test("findStartAction rejects sparse root and child arrays", function()
	local validLeaf = {
		AXTitle = "Demarrer",
		AXEnabled = true,
		AXMenuItemCmdChar = "S",
		AXMenuItemCmdModifiers = { "cmd" },
	}
	local sparseRoot = { [1] = validLeaf, [3] = validLeaf }
	local sparseChildren = { [1] = validLeaf, [3] = { AXTitle = "Quitter" } }

	assertMalformedMenuError(sparseRoot, "sparse root")
	assertMalformedMenuError({ { AXTitle = "Fichier", AXChildren = sparseChildren } }, "sparse children")
end)

test("findStartAction rejects cyclic menu nesting without throwing", function()
	local cyclicItem = { AXTitle = "Boucle" }
	cyclicItem.AXChildren = { cyclicItem }
	local first = { AXTitle = "Premier" }
	local second = { AXTitle = "Deuxieme" }
	first.AXChildren = { second }
	second.AXChildren = { first }

	assertMalformedMenuError({ cyclicItem }, "self-referential nesting")
	assertMalformedMenuError({ first }, "cyclic nesting")
end)

test("findStartAction rejects malformed menu nodes and child collections", function()
	local validLeaf = {
		AXTitle = "Demarrer",
		AXEnabled = true,
		AXMenuItemCmdChar = "S",
		AXMenuItemCmdModifiers = { "cmd" },
	}
	local malformedTrees = {
		{ name = "non-table tree", tree = "invalid" },
		{ name = "non-array root", tree = { menu = { AXTitle = "Fichier" } } },
		{ name = "non-table node", tree = { "Fichier" } },
		{ name = "malformed node after candidate", tree = { validLeaf, "invalid" } },
		{ name = "non-array children", tree = { { AXTitle = "Fichier", AXChildren = { menu = {} } } } },
		{ name = "non-table children", tree = { { AXTitle = "Fichier", AXChildren = "invalid" } } },
	}

	for _, malformed in ipairs(malformedTrees) do
		assertMalformedMenuError(malformed.tree, malformed.name)
	end
end)

test("findStartAction tolerates an untitled separator outside the selected path", function()
	local tree = {
		{
			AXTitle = "Fichier",
			AXChildren = {
				{ AXTitle = "", AXEnabled = false },
				{
					AXTitle = "Demarrer",
					AXEnabled = true,
					AXMenuItemCmdChar = "S",
					AXMenuItemCmdModifiers = { "cmd" },
				},
			},
		},
	}

	local path, menuError = model.findStartAction(tree, "S")
	assert(path, tostring(menuError))
	assertPath(path, { "Fichier", "Demarrer" }, "separator sibling")
end)

test("findStartAction traverses the production AXMenu collection wrapper transparently", function()
	local tree = {
		wrappedMenu("Fichier", {
			{ AXRole = "AXMenuItem", AXTitle = "", AXEnabled = false },
			startLeaf("Se connecter", "s"),
		}),
	}

	local path, menuError = model.findStartAction(tree, "S")
	assert(path, tostring(menuError))
	assertPath(path, { "Fichier", "Se connecter" }, "production wrapper")
end)

test("findStartAction rejects multiple candidates discovered through collection wrappers", function()
	local tree = {
		wrappedMenu("Datei", { startLeaf("Starten") }),
		wrappedMenu("Fenster", { startLeaf("Seitenleiste", "s") }),
	}

	local path, menuError = model.findStartAction(tree, "S")
	assert(path == nil, "wrapped ambiguity must not return a path")
	assertEqual(menuError, "multiple start actions", "wrapped ambiguity error")
end)

test("findStartAction rejects malformed anonymous collection wrappers", function()
	local sparse = { [1] = startLeaf("Demarrer"), [3] = { AXTitle = "Quitter" } }
	local mixed = { startLeaf("Demarrer") }
	mixed.AXTitle = "not collection-only"
	local malformedAncestor = { AXChildren = { startLeaf("Demarrer") } }
	local malformedWrappers = {
		{ name = "empty wrapper", tree = { wrappedMenu("Fichier", {}) } },
		{ name = "sparse wrapper", tree = { wrappedMenu("Fichier", sparse) } },
		{ name = "mixed wrapper", tree = { wrappedMenu("Fichier", mixed) } },
		{ name = "untitled node inside wrapper", tree = { wrappedMenu("Fichier", { malformedAncestor }) } },
	}

	for _, malformed in ipairs(malformedWrappers) do
		assertMalformedMenuError(malformed.tree, malformed.name)
	end
end)

test("findStartAction rejects collection-wrapper cycles and aliases", function()
	local cyclic = {}
	cyclic[1] = cyclic
	local sharedWrapper = { startLeaf("Demarrer") }
	local sharedLeaf = startLeaf("Demarrer")

	assertMalformedMenuError({ wrappedMenu("Fichier", cyclic) }, "cyclic wrapper")
	assertMalformedMenuError({
		wrappedMenu("Fichier", sharedWrapper),
		wrappedMenu("Fenster", sharedWrapper),
	}, "aliased wrapper")
	assertMalformedMenuError({
		wrappedMenu("Fichier", { sharedLeaf }),
		wrappedMenu("Fenster", { sharedLeaf }),
	}, "aliased wrapped item")
end)

test("new starts login grace with an isolated validated policy", function()
	local inputPolicy = policy()
	local state, stateError = model.new(inputPolicy, 100)
	assert(state, stateError)
	assertEqual(state.phase, "grace", "initial phase")
	assertEqual(state.graceUntil, 115, "startup grace deadline")
	assertEqual(state.absenceCount, 0, "initial absence evidence")
	assertEqual(state.lastTimestamp, 100, "initial timestamp")
	assert(state.policy ~= inputPolicy, "state must isolate its policy from caller mutation")
	assert(state.policy.retryDelays ~= inputPolicy.retryDelays, "state must deep-copy nested policy values")
	local successor = model.observe(state, { kind = "healthy" }, 101)
	assert(successor.policy ~= state.policy, "successor must not share its predecessor policy")
	assert(successor.policy.retryDelays ~= state.policy.retryDelays, "successor must isolate nested policy values")
	inputPolicy.retryDelays[1] = 99
	state.policy.retryDelays[1] = 88
	assertEqual(successor.policy.retryDelays[1], 5, "successor nested policy snapshot")
	successor.policy.retryDelays[2] = 77
	assertEqual(state.policy.retryDelays[2], 15, "predecessor nested policy snapshot")
	inputPolicy.absenceThreshold = 9
	assertEqual(state.policy.absenceThreshold, 2, "copied absence threshold")

	local invalidCases = {
		{ name = "missing policy", value = nil, now = 0 },
		{ name = "missing threshold", value = { startupGrace = 15, wakeGrace = 15 }, now = 0 },
		{ name = "zero threshold", value = policy({ absenceThreshold = 0 }), now = 0 },
		{ name = "fractional threshold", value = policy({ absenceThreshold = 1.5 }), now = 0 },
		{ name = "negative startup grace", value = policy({ startupGrace = -1 }), now = 0 },
		{ name = "infinite wake grace", value = policy({ wakeGrace = math.huge }), now = 0 },
		{ name = "missing attempt limit", value = policy({ attemptLimit = false }), now = 0 },
		{ name = "fractional attempt limit", value = policy({ attemptLimit = 2.5 }), now = 0 },
		{ name = "zero recovery window", value = policy({ recoveryWindow = 0 }), now = 0 },
		{ name = "short retry delays", value = policy({ retryDelays = { 5 } }), now = 0 },
		{ name = "extra retry delay", value = policy({ retryDelays = { 5, 15, 30 } }), now = 0 },
		{ name = "negative retry delay", value = policy({ retryDelays = { 5, -15 } }), now = 0 },
		{ name = "zero cooldown", value = policy({ cooldown = 0 }), now = 0 },
		{ name = "negative timestamp", value = policy(), now = -1 },
		{ name = "non-number timestamp", value = policy(), now = "now" },
	}
	for _, invalid in ipairs(invalidCases) do
		local invalidState, invalidError = model.new(invalid.value, invalid.now)
		assert(invalidState == nil, invalid.name .. " must fail closed")
		assert(type(invalidError) == "string" and invalidError ~= "", invalid.name .. " must explain rejection")
	end
end)

test("recovered result clears failed attempts and restores a fresh absence sequence", function()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local backingOff, failedDecisions =
		model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
	assertDecisionKinds(failedDecisions, { "retry-after" }, "first failed attempt")

	local retryFirst = model.observe(backingOff, { kind = "absent" }, 11)
	local retrying = model.observe(retryFirst, { kind = "absent" }, 16)
	local recovered, recoveredDecisions = model.recoveryResult(retrying, { kind = "recovered" }, 17)
	assertEqual(recovered.phase, "observing", "recovered phase")
	assertEqual(recovered.absenceCount, 0, "recovered absence evidence")
	assertEqual(#recovered.attemptHistory, 0, "recovered attempt history")
	assert(recovered.retryAt == nil, "recovered result must clear retry eligibility")
	assert(recovered.cooldownUntil == nil, "recovered result must clear cooldown")
	assert(next(recovered.alertKeys) == nil, "recovered result must clear stale alert keys")
	assertDecisionKinds(recoveredDecisions, {}, "recovered result")

	local freshMiss, freshMissDecisions = model.observe(recovered, { kind = "absent" }, 18)
	assertEqual(freshMiss.absenceCount, 1, "post-recovery first absence")
	assertDecisionKinds(freshMissDecisions, {}, "post-recovery first absence")
end)

test("failed attempts use exact approved retry delays before one cooldown alert", function()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local firstBackoff, firstDecisions =
		model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
	assertEqual(firstBackoff.phase, "backoff", "first failure phase")
	assertEqual(firstBackoff.retryAt, 11, "first retry deadline")
	assertExactDecision(firstDecisions[1], {
		kind = "retry-after",
		delay = 5,
		retryAt = 11,
	}, "first retry decision")

	local tooEarly, tooEarlyDecisions = model.observe(firstBackoff, { kind = "absent" }, 10)
	assertEqual(tooEarly.phase, "backoff", "pre-backoff phase")
	assertEqual(tooEarly.absenceCount, 0, "pre-backoff absence evidence")
	assertDecisionKinds(tooEarlyDecisions, {}, "pre-backoff observation")
	local retryFirst = model.observe(tooEarly, { kind = "absent" }, 11)
	local retrying = model.observe(retryFirst, { kind = "absent" }, 16)
	local secondBackoff, secondDecisions =
		model.recoveryResult(retrying, { kind = "failed", reason = "verification-timeout" }, 17)
	assertEqual(secondBackoff.retryAt, 32, "second retry deadline")
	assertExactDecision(secondDecisions[1], {
		kind = "retry-after",
		delay = 15,
		retryAt = 32,
	}, "second retry decision")

	local secondTooEarly = model.observe(secondBackoff, { kind = "absent" }, 31)
	assertEqual(secondTooEarly.phase, "backoff", "second pre-backoff phase")
	local thirdFirst = model.observe(secondTooEarly, { kind = "absent" }, 32)
	local thirdRecovery = model.observe(thirdFirst, { kind = "absent" }, 37)
	local cooldown, cooldownDecisions =
		model.recoveryResult(thirdRecovery, { kind = "failed", reason = "verification-timeout" }, 38)
	assertEqual(cooldown.phase, "cooldown", "third failure phase")
	assertEqual(cooldown.cooldownUntil, 338, "cooldown deadline")
	assertEqual(#cooldown.attemptHistory, 3, "bounded episode attempt count")
	assertDecisionKinds(cooldownDecisions, { "alert" }, "cooldown entry")
	assertExactDecision(cooldownDecisions[1], {
		kind = "alert",
		key = "recovery:cooldown",
		reason = "verification-timeout",
		cooldownUntil = 338,
	}, "cooldown alert decision")
end)

test("cooldown expiry with continued absence starts a new bounded episode", function()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local firstBackoff = model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
	local secondRecoveryFirst = model.observe(firstBackoff, { kind = "absent" }, 11)
	local secondRecovery = model.observe(secondRecoveryFirst, { kind = "absent" }, 16)
	local secondBackoff = model.recoveryResult(secondRecovery, { kind = "failed", reason = "verification-timeout" }, 17)
	local thirdRecoveryFirst = model.observe(secondBackoff, { kind = "absent" }, 32)
	local thirdRecovery = model.observe(thirdRecoveryFirst, { kind = "absent" }, 37)
	local cooldown = model.recoveryResult(thirdRecovery, { kind = "failed", reason = "verification-timeout" }, 38)

	local beforeExpiry, beforeExpiryDecisions = model.observe(cooldown, { kind = "absent" }, 337)
	assertEqual(beforeExpiry.phase, "cooldown", "pre-expiry cooldown phase")
	assertDecisionKinds(beforeExpiryDecisions, {}, "pre-expiry cooldown")
	local newEpisodeFirst, expiryDecisions = model.observe(beforeExpiry, { kind = "absent" }, 338)
	assertEqual(newEpisodeFirst.phase, "observing", "cooldown expiry phase")
	assertEqual(newEpisodeFirst.absenceCount, 1, "new episode first absence")
	assertEqual(#newEpisodeFirst.attemptHistory, 0, "expired episode history")
	assert(newEpisodeFirst.cooldownUntil == nil, "expired cooldown deadline")
	assert(newEpisodeFirst.alertKeys["recovery:cooldown"] == nil, "expired cooldown alert key")
	assertDecisionKinds(expiryDecisions, {}, "cooldown expiry")

	local newEpisodeRecovery, recoveryDecisions = model.observe(newEpisodeFirst, { kind = "absent" }, 343)
	assertDecisionKinds(recoveryDecisions, { "recover" }, "new episode recovery")
	local newEpisodeBackoff, retryDecisions =
		model.recoveryResult(newEpisodeRecovery, { kind = "failed", reason = "verification-timeout" }, 344)
	assertEqual(#newEpisodeBackoff.attemptHistory, 1, "new episode first failure")
	assertExactDecision(retryDecisions[1], {
		kind = "retry-after",
		delay = 5,
		retryAt = 349,
	}, "new episode retry decision")
end)

test("wake grace remains separate from sleeping backoff when health clears retry state", function()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local backoff = model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
	local sleeping, sleepDecisions = model.lifecycle(backoff, "sleep", 7)
	assertEqual(sleeping.phase, "sleeping", "backoff sleep phase")
	assertEqual(sleeping.retryAt, 11, "sleeping retry deadline")
	assertDecisionKinds(sleepDecisions, {}, "backoff sleep")

	local waking, wakeDecisions = model.lifecycle(sleeping, "wake", 8)
	assertEqual(waking.phase, "grace", "backoff wake phase")
	assertEqual(waking.graceUntil, 23, "independent backoff wake grace")
	assertEqual(waking.retryAt, 11, "backoff eligibility retained during wake grace")
	assertDecisionKinds(wakeDecisions, {}, "backoff wake")

	local healthy, healthyDecisions = model.observe(waking, { kind = "healthy" }, 9)
	assertEqual(healthy.phase, "grace", "healthy before wake grace phase")
	assertEqual(healthy.graceUntil, 23, "healthy preserves genuine wake grace")
	assert(healthy.retryAt == nil, "healthy clears sleeping backoff eligibility")
	assertEqual(#healthy.attemptHistory, 0, "healthy clears backoff attempt history")
	assertDecisionKinds(healthyDecisions, {}, "healthy before backoff wake grace")

	local beforeGrace, beforeGraceDecisions = model.observe(healthy, { kind = "absent" }, 22)
	assertEqual(beforeGrace.phase, "grace", "backoff pre-grace absence phase")
	assertEqual(beforeGrace.absenceCount, 0, "backoff pre-grace absence evidence")
	assertDecisionKinds(beforeGraceDecisions, {}, "backoff pre-grace absence")
	local firstMiss = model.observe(beforeGrace, { kind = "absent" }, 23)
	local retrying, retryDecisions = model.observe(firstMiss, { kind = "absent" }, 28)
	assertEqual(retrying.phase, "activating", "healthy-reset backoff recovery phase")
	assertDecisionKinds(retryDecisions, { "recover" }, "healthy-reset backoff recovery")
end)

test("wake grace dominates a sleeping backoff that expires during grace", function()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local backoff = model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
	local sleeping = model.lifecycle(backoff, "sleep", 7)
	local waking = model.lifecycle(sleeping, "wake", 8)

	local beforeGrace, beforeGraceDecisions = model.observe(waking, { kind = "absent" }, 22)
	assertEqual(beforeGrace.phase, "grace", "expired-backoff pre-grace phase")
	assertEqual(beforeGrace.retryAt, 11, "expired backoff retained until grace transition")
	assertEqual(beforeGrace.absenceCount, 0, "expired-backoff pre-grace evidence")
	assertDecisionKinds(beforeGraceDecisions, {}, "expired-backoff pre-grace absence")

	local firstMiss, firstMissDecisions = model.observe(beforeGrace, { kind = "absent" }, 23)
	assertEqual(firstMiss.phase, "observing", "expired backoff post-grace phase")
	assert(firstMiss.retryAt == nil, "expired backoff clears at grace transition")
	assertEqual(firstMiss.absenceCount, 1, "expired backoff first post-grace absence")
	assertEqual(#firstMiss.attemptHistory, 1, "expired backoff retains rolling attempt history")
	assertDecisionKinds(firstMissDecisions, {}, "expired backoff first post-grace absence")
	local retrying, retryDecisions = model.observe(firstMiss, { kind = "absent" }, 28)
	assertEqual(retrying.phase, "activating", "expired backoff recovery phase")
	assertDecisionKinds(retryDecisions, { "recover" }, "expired backoff recovery")
end)

test("health before wake grace clears inherited cooldown without shortening wake grace", function()
	local cooldown = enterCooldown()
	assertEqual(cooldown.cooldownUntil, 338, "pre-sleep cooldown deadline")
	local sleeping = model.lifecycle(cooldown, "sleep", 39)
	local waking = model.lifecycle(sleeping, "wake", 40)
	assertEqual(waking.graceUntil, 55, "independent cooldown wake grace")
	assertEqual(waking.cooldownUntil, 338, "cooldown retained during wake grace")

	local healthy, healthyDecisions = model.observe(waking, { kind = "healthy" }, 41)
	assertEqual(healthy.phase, "grace", "pre-grace cooldown health phase")
	assertEqual(healthy.graceUntil, 55, "pre-grace health preserves wake grace")
	assert(healthy.cooldownUntil == nil, "pre-grace health clears cooldown")
	assertEqual(#healthy.attemptHistory, 0, "pre-grace health clears cooldown attempts")
	assert(healthy.alertKeys["recovery:cooldown"] == nil, "pre-grace health clears cooldown alert key")
	assertDecisionKinds(healthyDecisions, {}, "pre-grace cooldown health")

	local beforeGrace = model.observe(healthy, { kind = "absent" }, 54)
	assertEqual(beforeGrace.phase, "grace", "healthy cooldown pre-grace absence phase")
	assertEqual(beforeGrace.absenceCount, 0, "healthy cooldown pre-grace absence evidence")
	local firstMiss = model.observe(beforeGrace, { kind = "absent" }, 55)
	local recovering, recoveryDecisions = model.observe(firstMiss, { kind = "absent" }, 60)
	assertEqual(recovering.phase, "activating", "pre-grace health recovery phase")
	assertDecisionKinds(recoveryDecisions, { "recover" }, "pre-grace health recovery")
end)

test("health after wake grace clears inherited cooldown immediately", function()
	local sleeping = model.lifecycle(enterCooldown(), "sleep", 39)
	local waking = model.lifecycle(sleeping, "wake", 40)
	local beforeGrace = model.observe(waking, { kind = "absent" }, 54)
	local waiting, waitingDecisions = model.observe(beforeGrace, { kind = "absent" }, 55)
	assertEqual(waiting.phase, "cooldown", "post-grace inherited cooldown phase")
	assertEqual(waiting.cooldownUntil, 338, "post-grace inherited cooldown deadline")
	assertEqual(waiting.absenceCount, 0, "post-grace inherited cooldown evidence")
	assertDecisionKinds(waitingDecisions, {}, "post-grace inherited cooldown")

	local healthy, healthyDecisions = model.observe(waiting, { kind = "healthy" }, 56)
	assertEqual(healthy.phase, "observing", "post-grace cooldown health phase")
	assert(healthy.cooldownUntil == nil, "post-grace health clears cooldown")
	assertEqual(#healthy.attemptHistory, 0, "post-grace health clears cooldown attempts")
	assertDecisionKinds(healthyDecisions, {}, "post-grace cooldown health")
	local firstMiss = model.observe(healthy, { kind = "absent" }, 57)
	local recovering, recoveryDecisions = model.observe(firstMiss, { kind = "absent" }, 62)
	assertEqual(recovering.phase, "activating", "post-grace health recovery phase")
	assertDecisionKinds(recoveryDecisions, { "recover" }, "post-grace health recovery")
end)

test("inherited cooldown expires independently after wake grace", function()
	local sleeping = model.lifecycle(enterCooldown(), "sleep", 39)
	local waking = model.lifecycle(sleeping, "wake", 40)
	local beforeGrace = model.observe(waking, { kind = "absent" }, 54)
	local waiting = model.observe(beforeGrace, { kind = "absent" }, 55)
	local beforeExpiry, beforeExpiryDecisions = model.observe(waiting, { kind = "absent" }, 337)
	assertEqual(beforeExpiry.phase, "cooldown", "inherited pre-expiry cooldown phase")
	assertDecisionKinds(beforeExpiryDecisions, {}, "inherited pre-expiry cooldown")

	local firstMiss, expiryDecisions = model.observe(beforeExpiry, { kind = "absent" }, 338)
	assertEqual(firstMiss.phase, "observing", "inherited cooldown expiry phase")
	assertEqual(firstMiss.absenceCount, 1, "inherited cooldown expiry evidence")
	assertEqual(#firstMiss.attemptHistory, 0, "inherited cooldown expired attempts")
	assert(firstMiss.cooldownUntil == nil, "inherited cooldown expired deadline")
	assert(firstMiss.alertKeys["recovery:cooldown"] == nil, "inherited cooldown expired alert key")
	assertDecisionKinds(expiryDecisions, {}, "inherited cooldown expiry")
	local recovering, recoveryDecisions = model.observe(firstMiss, { kind = "absent" }, 343)
	assertEqual(recovering.phase, "activating", "inherited cooldown expiry recovery phase")
	assertDecisionKinds(recoveryDecisions, { "recover" }, "inherited cooldown expiry recovery")
end)

test("rolling attempt window retains its exact edge and expires older attempts", function()
	local function secondBackoff()
		local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
		local firstBackoff = model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 6)
		local secondFirst = model.observe(firstBackoff, { kind = "absent" }, 11)
		local secondRecovery = model.observe(secondFirst, { kind = "absent" }, 16)
		return model.recoveryResult(secondRecovery, { kind = "failed", reason = "verification-timeout" }, 17)
	end

	local edgeThirdFirst = model.observe(secondBackoff(), { kind = "absent" }, 300)
	local edgeThirdRecovery = model.observe(edgeThirdFirst, { kind = "absent" }, 305)
	local edgeCooldown, edgeDecisions =
		model.recoveryResult(edgeThirdRecovery, { kind = "failed", reason = "verification-timeout" }, 306)
	assertEqual(edgeCooldown.phase, "cooldown", "exact-window-edge phase")
	assertEqual(edgeCooldown.attemptHistory[1], 6, "exact-window-edge retained attempt")
	assertDecisionKinds(edgeDecisions, { "alert" }, "exact-window-edge cooldown")

	local expiredThirdFirst = model.observe(secondBackoff(), { kind = "absent" }, 301)
	local expiredThirdRecovery = model.observe(expiredThirdFirst, { kind = "absent" }, 306)
	local expiredBackoff, expiredDecisions =
		model.recoveryResult(expiredThirdRecovery, { kind = "failed", reason = "verification-timeout" }, 307)
	assertEqual(expiredBackoff.phase, "backoff", "expired-window phase")
	assertEqual(#expiredBackoff.attemptHistory, 2, "expired-window attempt count")
	assertEqual(expiredBackoff.attemptHistory[1], 17, "expired-window oldest attempt")
	assertExactDecision(expiredDecisions[1], {
		kind = "retry-after",
		delay = 15,
		retryAt = 322,
	}, "expired-window retry decision")
end)

test("persistent reason alerts deduplicate by exact key until reason changes or health returns", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
	local ambiguous, ambiguousDecisions = model.observe(initial, { kind = "ambiguous", reason = "core-parent" }, 0)
	assertDecisionKinds(ambiguousDecisions, { "alert" }, "first ambiguous reason")
	assertExactDecision(ambiguousDecisions[1], {
		kind = "alert",
		key = "ambiguous:core-parent",
		reason = "core-parent",
	}, "ambiguous alert")

	local persistent, persistentDecisions = model.observe(ambiguous, { kind = "ambiguous", reason = "core-parent" }, 1)
	assertDecisionKinds(persistentDecisions, {}, "persistent ambiguous reason")
	local changed, changedDecisions = model.observe(persistent, { kind = "error", reason = "snapshot-failed" }, 2)
	assertDecisionKinds(changedDecisions, { "alert" }, "changed error reason")
	assertExactDecision(changedDecisions[1], {
		kind = "alert",
		key = "error:snapshot-failed",
		reason = "snapshot-failed",
	}, "changed error alert")
	assert(changed.alertKeys["ambiguous:core-parent"] == nil, "changed reason must discard stale key")

	local prerequisite, prerequisiteDecisions =
		model.observe(changed, { kind = "error", reason = "accessibility-denied" }, 3)
	assertDecisionKinds(prerequisiteDecisions, { "alert" }, "prerequisite reason")
	assertExactDecision(prerequisiteDecisions[1], {
		kind = "alert",
		key = "error:accessibility-denied",
		reason = "accessibility-denied",
	}, "prerequisite alert")
	local repeatedPrerequisite, repeatedPrerequisiteDecisions =
		model.observe(prerequisite, { kind = "error", reason = "accessibility-denied" }, 4)
	assertDecisionKinds(repeatedPrerequisiteDecisions, {}, "persistent prerequisite reason")

	local healthy, healthyDecisions = model.observe(repeatedPrerequisite, { kind = "healthy" }, 5)
	assert(next(healthy.alertKeys) == nil, "healthy observation must clear stale alert keys")
	assert(healthy.persistentAlertKey == nil, "healthy observation must clear persistent alert key")
	assertDecisionKinds(healthyDecisions, {}, "healthy alert reset")
	local recurring, recurringDecisions = model.observe(healthy, { kind = "error", reason = "accessibility-denied" }, 6)
	assertDecisionKinds(recurringDecisions, { "alert" }, "reason after healthy reset")
	assertExactDecision(recurringDecisions[1], {
		kind = "alert",
		key = "error:accessibility-denied",
		reason = "accessibility-denied",
	}, "reason after healthy alert")
end)

test("recovery-result reason alerts once while healthy clears cooldown and retry state", function()
	local recovering = startRecovery(assert(model.new(policy({ startupGrace = 0 }), 0)), 0, 5)
	local firstBackoff, firstDecisions =
		model.recoveryResult(recovering, { kind = "unavailable", reason = "start-action-unavailable" }, 6)
	assertDecisionKinds(firstDecisions, { "alert", "retry-after" }, "first unavailable result")
	assertExactDecision(firstDecisions[1], {
		kind = "alert",
		key = "unavailable:start-action-unavailable",
		reason = "start-action-unavailable",
	}, "unavailable alert")

	local secondFirst = model.observe(firstBackoff, { kind = "absent" }, 11)
	local secondRecovery = model.observe(secondFirst, { kind = "absent" }, 16)
	local secondBackoff, secondDecisions =
		model.recoveryResult(secondRecovery, { kind = "unavailable", reason = "start-action-unavailable" }, 17)
	assertDecisionKinds(secondDecisions, { "retry-after" }, "repeated unavailable result")
	local thirdFirst = model.observe(secondBackoff, { kind = "absent" }, 32)
	local thirdRecovery = model.observe(thirdFirst, { kind = "absent" }, 37)
	local cooldown, cooldownDecisions =
		model.recoveryResult(thirdRecovery, { kind = "unavailable", reason = "start-action-unavailable" }, 38)
	assertDecisionKinds(cooldownDecisions, { "alert" }, "unavailable cooldown result")
	assertEqual(cooldownDecisions[1].key, "recovery:cooldown", "unavailable cooldown alert key")

	local healthy, healthyDecisions = model.observe(cooldown, { kind = "healthy" }, 39)
	assertEqual(healthy.phase, "observing", "healthy cooldown reset phase")
	assertEqual(#healthy.attemptHistory, 0, "healthy attempt reset")
	assert(healthy.cooldownUntil == nil, "healthy cooldown reset")
	assert(healthy.retryAt == nil, "healthy retry reset")
	assert(next(healthy.alertKeys) == nil, "healthy recovery alert reset")
	assertDecisionKinds(healthyDecisions, {}, "healthy recovery reset")
end)

test("startup grace ignores absence before requiring two post-grace observations", function()
	local initial = assert(model.new(policy(), 100))
	local duringGrace, duringDecisions = model.observe(initial, { kind = "absent" }, 114)
	assertEqual(duringGrace.phase, "grace", "pre-deadline phase")
	assertEqual(duringGrace.absenceCount, 0, "pre-deadline absence evidence")
	assertDecisionKinds(duringDecisions, {}, "pre-deadline observation")
	assertEqual(initial.lastTimestamp, 100, "observe must not mutate its input state")

	local firstMiss, firstDecisions = model.observe(duringGrace, { kind = "absent" }, 115)
	assertEqual(firstMiss.phase, "observing", "phase after startup grace")
	assertEqual(firstMiss.absenceCount, 1, "first post-grace absence")
	assertDecisionKinds(firstDecisions, {}, "first post-grace absence")

	local recovering, recoveryDecisions = model.observe(firstMiss, { kind = "absent" }, 120)
	assertEqual(recovering.phase, "activating", "recovery admission phase")
	assertEqual(recovering.absenceCount, 0, "consumed absence evidence")
	assertDecisionKinds(recoveryDecisions, { "recover" }, "second post-grace absence")

	local thresholdThree = assert(model.new(policy({ absenceThreshold = 3, startupGrace = 0 }), 200))
	local thresholdThreeFirst, thresholdThreeFirstDecisions = model.observe(thresholdThree, { kind = "absent" }, 200)
	local thresholdThreeSecond, thresholdThreeSecondDecisions =
		model.observe(thresholdThreeFirst, { kind = "absent" }, 205)
	local thresholdThreeRecovery, thresholdThreeRecoveryDecisions =
		model.observe(thresholdThreeSecond, { kind = "absent" }, 210)
	assertDecisionKinds(thresholdThreeFirstDecisions, {}, "custom threshold first absence")
	assertDecisionKinds(thresholdThreeSecondDecisions, {}, "custom threshold second absence")
	assertDecisionKinds(thresholdThreeRecoveryDecisions, { "recover" }, "custom threshold third absence")
	assertEqual(thresholdThreeRecovery.phase, "activating", "custom threshold recovery phase")
end)

test("healthy observations reset consecutive absence evidence without using connection state", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
	local firstMiss = model.observe(initial, { kind = "absent" }, 0)
	assertEqual(firstMiss.absenceCount, 1, "first absence")

	local healthy, healthyDecisions = model.observe(firstMiss, {
		kind = "healthy",
		peerReachable = false,
		connectionState = "disconnected",
	}, 1)
	assertEqual(healthy.phase, "observing", "healthy phase")
	assertEqual(healthy.absenceCount, 0, "healthy reset")
	assertDecisionKinds(healthyDecisions, {}, "healthy observation")

	local nextMiss, nextDecisions = model.observe(healthy, { kind = "absent" }, 2)
	assertEqual(nextMiss.absenceCount, 1, "fresh absence sequence")
	assertDecisionKinds(nextDecisions, {}, "fresh first absence")
end)

test("intentional stop is recoverable absence and peer metadata cannot suppress it", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
	local firstMiss = model.observe(initial, {
		kind = "absent",
		reason = "operator-stopped",
		peerReachable = true,
		connectionState = "connected",
	}, 0)
	local recovering, decisions = model.observe(firstMiss, {
		kind = "absent",
		reason = "operator-stopped",
		peerReachable = true,
		connectionState = "connected",
	}, 5)

	assertEqual(recovering.phase, "activating", "intentional-stop recovery phase")
	assertDecisionKinds(decisions, { "recover" }, "intentional-stop recovery")
end)

test("ambiguous and error observations break absence sequences without recovery", function()
	for _, unsafeKind in ipairs({ "ambiguous", "error" }) do
		local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
		local firstMiss = model.observe(initial, { kind = "absent" }, 0)
		local unsafe, unsafeDecisions = model.observe(firstMiss, { kind = unsafeKind }, 1)
		assertEqual(unsafe.absenceCount, 0, unsafeKind .. " reset")
		assertDecisionKinds(unsafeDecisions, { "alert" }, unsafeKind .. " observation")
		assertExactDecision(unsafeDecisions[1], {
			kind = "alert",
			key = unsafeKind .. ":" .. unsafeKind,
			reason = unsafeKind,
		}, unsafeKind .. " alert")

		local nextMiss, nextDecisions = model.observe(unsafe, { kind = "absent" }, 2)
		assertEqual(nextMiss.phase, "observing", unsafeKind .. " fresh sequence phase")
		assertEqual(nextMiss.absenceCount, 1, unsafeKind .. " fresh sequence evidence")
		assertDecisionKinds(nextDecisions, {}, unsafeKind .. " fresh first absence")
	end
end)

test("overlapping polls cannot start a second recovery in any active phase", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
	local firstMiss = model.observe(initial, { kind = "absent" }, 0)
	local activating = model.observe(firstMiss, { kind = "absent" }, 5)
	local selecting = model.advanceRecovery(activating, "selecting", 6)
	local verifying = model.advanceRecovery(selecting, "verifying", 7)

	for _, active in ipairs({ activating, selecting, verifying }) do
		local afterPoll, decisions = model.observe(active, { kind = "absent" }, 10)
		assertEqual(afterPoll.phase, active.phase, active.phase .. " overlap phase")
		assertDecisionKinds(decisions, {}, active.phase .. " overlap")
	end
end)

test("advanceRecovery owns ordered activating to selecting to verifying progression", function()
	local initial = assert(model.new(policy({ startupGrace = 0, retryDelays = { 5, 15 } }), 0))
	local firstMiss = model.observe(initial, { kind = "absent" }, 0)
	local activating = model.observe(firstMiss, { kind = "absent" }, 5)

	local selecting, selectingDecisions = model.advanceRecovery(activating, "selecting", 6)
	assertEqual(selecting.phase, "selecting", "selecting progression")
	assertEqual(selecting.lastTimestamp, 6, "selecting timestamp")
	assert(selecting.policy ~= activating.policy, "selecting must isolate predecessor policy")
	assert(selecting.policy.retryDelays ~= activating.policy.retryDelays, "selecting must deep-copy policy")
	assertDecisionKinds(selectingDecisions, {}, "selecting progression")

	local verifying, verifyingDecisions = model.advanceRecovery(selecting, "verifying", 7)
	assertEqual(verifying.phase, "verifying", "verifying progression")
	assertEqual(verifying.lastTimestamp, 7, "verifying timestamp")
	assertDecisionKinds(verifyingDecisions, {}, "verifying progression")

	local invalidTransitions = {
		{ name = "skip selecting", state = activating, phase = "verifying", now = 6 },
		{ name = "repeat activating", state = activating, phase = "activating", now = 6 },
		{ name = "reverse selecting", state = selecting, phase = "activating", now = 7 },
		{ name = "reverse verifying", state = verifying, phase = "selecting", now = 8 },
		{ name = "unknown phase", state = selecting, phase = "finished", now = 7 },
		{ name = "stale transition", state = activating, phase = "selecting", now = 4 },
		{ name = "outside recovery", state = initial, phase = "selecting", now = 1 },
	}
	for _, invalid in ipairs(invalidTransitions) do
		local unchanged, decisions = model.advanceRecovery(invalid.state, invalid.phase, invalid.now)
		assert(unchanged == invalid.state, invalid.name .. " must preserve state")
		assertDecisionKinds(decisions, {}, invalid.name)
	end
end)

test("sleep aborts every active recovery phase and requests focus restoration", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
	local firstMiss = model.observe(initial, { kind = "absent" }, 0)
	local activating = model.observe(firstMiss, { kind = "absent" }, 5)
	local selecting = model.advanceRecovery(activating, "selecting", 6)
	local verifying = model.advanceRecovery(selecting, "verifying", 7)

	for _, active in ipairs({ activating, selecting, verifying }) do
		local sleeping, decisions = model.lifecycle(active, "sleep", 10)
		assertEqual(sleeping.phase, "sleeping", active.phase .. " sleep phase")
		assertEqual(sleeping.recoveryPhase, "aborted", active.phase .. " aborted recovery")
		assertEqual(sleeping.interruptedRecoveryPhase, active.phase, active.phase .. " interruption source")
		assertEqual(sleeping.absenceCount, 0, active.phase .. " cleared absence evidence")
		assertDecisionKinds(decisions, { "abort-recovery", "restore-focus" }, active.phase .. " sleep")
	end

	local observing = assert(model.new(policy({ startupGrace = 0 }), 20))
	observing = model.observe(observing, { kind = "healthy" }, 20)
	local sleeping, decisions = model.lifecycle(observing, "sleep", 21)
	assertEqual(sleeping.phase, "sleeping", "idle sleep phase")
	assert(sleeping.recoveryPhase == nil, "idle sleep must not invent an aborted recovery")
	assertDecisionKinds(decisions, {}, "idle sleep")

	local sleepingAfterPoll, sleepingPollDecisions = model.observe(sleeping, { kind = "absent" }, 22)
	assertEqual(sleepingAfterPoll.phase, "sleeping", "sleeping observation phase")
	assertEqual(sleepingAfterPoll.absenceCount, 0, "sleeping observation evidence")
	assertDecisionKinds(sleepingPollDecisions, {}, "sleeping observation")
end)

test("wake clears prior evidence and starts a fresh wake grace period", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 0))
	local firstMiss = model.observe(initial, { kind = "absent" }, 0)
	local recovering = model.observe(firstMiss, { kind = "absent" }, 5)
	local sleeping = model.lifecycle(recovering, "sleep", 12)
	assertEqual(sleeping.recoveryPhase, "aborted", "pre-wake aborted recovery")
	local staleWake, staleWakeDecisions = model.lifecycle(sleeping, "wake", 11)
	assert(staleWake == sleeping, "stale wake must preserve sleeping state")
	assertEqual(staleWake.lastTimestamp, 12, "stale wake timestamp")
	assert(staleWake.graceUntil == nil, "stale wake must not create grace")
	assertDecisionKinds(staleWakeDecisions, {}, "stale wake")
	local waking, wakeDecisions = model.lifecycle(sleeping, "wake", 20)
	assertEqual(waking.phase, "grace", "wake phase")
	assertEqual(waking.graceUntil, 35, "wake grace deadline")
	assertEqual(waking.absenceCount, 0, "wake absence reset")
	assert(waking.recoveryPhase == nil, "wake must clear recovery state")
	assert(waking.interruptedRecoveryPhase == nil, "wake must clear interruption state")
	assertDecisionKinds(wakeDecisions, {}, "wake")

	local duringGrace, duringDecisions = model.observe(waking, { kind = "absent" }, 34)
	assertEqual(duringGrace.absenceCount, 0, "wake-grace absence evidence")
	assertDecisionKinds(duringDecisions, {}, "wake-grace observation")

	local firstPostWake = model.observe(duringGrace, { kind = "absent" }, 35)
	assertEqual(firstPostWake.phase, "observing", "post-wake observing phase")
	assertEqual(firstPostWake.absenceCount, 1, "first post-wake absence")
	local postWakeRecovery, recoveryDecisions = model.observe(firstPostWake, { kind = "absent" }, 40)
	assertEqual(postWakeRecovery.phase, "activating", "post-wake recovery phase")
	assertDecisionKinds(recoveryDecisions, { "recover" }, "post-wake recovery")
end)

test("non-monotonic timestamps and malformed events fail closed", function()
	local initial = assert(model.new(policy({ startupGrace = 0 }), 10))
	local observing = model.observe(initial, { kind = "healthy" }, 10)

	local staleObservation, staleDecisions = model.observe(observing, { kind = "absent" }, 9)
	assert(staleObservation == observing, "stale observation must preserve state")
	assertDecisionKinds(staleDecisions, {}, "stale observation")

	local invalidObservation, invalidDecisions = model.observe(observing, { kind = "unknown" }, 11)
	assert(invalidObservation == observing, "invalid observation must preserve state")
	assertDecisionKinds(invalidDecisions, {}, "invalid observation")

	local staleLifecycle, staleLifecycleDecisions = model.lifecycle(observing, "sleep", 9)
	assert(staleLifecycle == observing, "stale lifecycle event must preserve state")
	assertDecisionKinds(staleLifecycleDecisions, {}, "stale lifecycle event")

	local invalidLifecycle, invalidLifecycleDecisions = model.lifecycle(observing, "restart", 11)
	assert(invalidLifecycle == observing, "invalid lifecycle event must preserve state")
	assertDecisionKinds(invalidLifecycleDecisions, {}, "invalid lifecycle event")

	local firstMiss = model.observe(observing, { kind = "absent" }, 11)
	local recovering = model.observe(firstMiss, { kind = "absent" }, 16)
	local staleResult, staleResultDecisions =
		model.recoveryResult(recovering, { kind = "failed", reason = "verification-timeout" }, 15)
	assert(staleResult == recovering, "stale recovery result must preserve state")
	assertDecisionKinds(staleResultDecisions, {}, "stale recovery result")

	local invalidResult, invalidResultDecisions = model.recoveryResult(recovering, { kind = "unknown" }, 17)
	assert(invalidResult == recovering, "invalid recovery result must preserve state")
	assertDecisionKinds(invalidResultDecisions, {}, "invalid recovery result")
end)

print("Deskflow watchdog model tests passed (" .. testCount .. " cases)")
