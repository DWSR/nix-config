local source = debug.getinfo(1, "S").source
local testDirectory = assert(source:match("^@(.*/)"), "cannot locate fixture test directory")
local fixturePath = testDirectory .. "fixtures.lua"

local chunk, loadError = loadfile(fixturePath, "t", {})
assert(chunk, loadError)

local loaded, fixtures = pcall(chunk)
assert(loaded, fixtures)
assert(type(fixtures) == "table", "fixtures.lua must return a table")

local expectedConstants = {
	bundlePath = "/Applications/Deskflow.app",
	guiExecutablePath = "/Applications/Deskflow.app/Contents/MacOS/Deskflow",
	coreExecutablePath = "/Applications/Deskflow.app/Contents/MacOS/deskflow-core",
}

assert(type(fixtures.constants) == "table", "fixtures.constants must be a table")
for name, expectedValue in pairs(expectedConstants) do
	assert(fixtures.constants[name] == expectedValue, "unexpected constant: " .. name)
end

local function parseSnapshot(snapshot, fixtureName)
	assert(type(snapshot) == "string", fixtureName .. " snapshot must be a string")
	assert(snapshot == "" or snapshot:sub(-1) == "\n", fixtureName .. " snapshot must end with a newline")

	local records = {}
	local consumed = ""
	for row in snapshot:gmatch("([^\n]+)\n") do
		consumed = consumed .. row .. "\n"
		local pid, ppid, executablePath, role = row:match("^([1-9]%d*)\t(%d+)\t([^\t\r\n]+)\t([^\t\r\n]*)$")
		assert(pid and ppid and executablePath and role, fixtureName .. " has a malformed TSV row")
		table.insert(records, {
			pid = tonumber(pid),
			ppid = tonumber(ppid),
			executablePath = executablePath,
			role = role,
		})
	end
	assert(consumed == snapshot, fixtureName .. " snapshot has data outside complete TSV rows")
	return records
end

local function assertProcessRecords(actual, expected, fixtureName)
	assert(#actual == #expected, fixtureName .. " has the wrong process count")
	for index, expectedRecord in ipairs(expected) do
		local actualRecord = actual[index]
		for _, field in ipairs({ "pid", "ppid", "executablePath", "role" }) do
			assert(
				actualRecord[field] == expectedRecord[field],
				fixtureName .. " process " .. index .. " has wrong " .. field
			)
		end
	end
end

local function assertGuiRecords(actual, expected, fixtureName)
	assert(type(actual) == "table", fixtureName .. " guiRecords must be a table")
	assert(#actual == #expected, fixtureName .. " has the wrong GUI count")
	for index, expectedRecord in ipairs(expected) do
		local actualRecord = actual[index]
		assert(actualRecord.pid == expectedRecord.pid, fixtureName .. " GUI " .. index .. " has wrong PID")
		assert(
			actualRecord.bundlePath == expectedRecord.bundlePath,
			fixtureName .. " GUI " .. index .. " has wrong bundle path"
		)
	end
end

local expectedProcessFixtures = {
	healthyClient = {
		classification = "healthy",
		expectedRole = "client",
		records = {
			{ pid = 4101, ppid = 4100, executablePath = expectedConstants.coreExecutablePath, role = "client" },
		},
		guiRecords = {
			{ pid = 4100, bundlePath = expectedConstants.bundlePath },
		},
	},
	healthyServer = {
		classification = "healthy",
		expectedRole = "server",
		records = {
			{ pid = 4201, ppid = 4200, executablePath = expectedConstants.coreExecutablePath, role = "server" },
		},
		guiRecords = {
			{ pid = 4200, bundlePath = expectedConstants.bundlePath },
		},
	},
	absent = {
		classification = "absent",
		expectedRole = "server",
		records = {},
		guiRecords = {
			{ pid = 4300, bundlePath = expectedConstants.bundlePath },
		},
	},
	orphan = {
		classification = "ambiguous",
		expectedRole = "server",
		records = {
			{ pid = 4401, ppid = 1, executablePath = expectedConstants.coreExecutablePath, role = "server" },
		},
		guiRecords = {},
	},
	wrongCorePath = {
		classification = "ambiguous",
		expectedRole = "server",
		records = {
			{ pid = 4501, ppid = 4500, executablePath = "/opt/deskflow-test/deskflow-core", role = "server" },
		},
		guiRecords = {
			{ pid = 4500, bundlePath = expectedConstants.bundlePath },
		},
	},
	wrongGuiPath = {
		classification = "ambiguous",
		expectedRole = "server",
		records = {
			{ pid = 4601, ppid = 4600, executablePath = expectedConstants.coreExecutablePath, role = "server" },
		},
		guiRecords = {
			{ pid = 4600, bundlePath = "/Applications/Deskflow Preview.app" },
		},
	},
	wrongRole = {
		classification = "ambiguous",
		expectedRole = "server",
		records = {
			{ pid = 4701, ppid = 4700, executablePath = expectedConstants.coreExecutablePath, role = "client" },
		},
		guiRecords = {
			{ pid = 4700, bundlePath = expectedConstants.bundlePath },
		},
	},
	duplicateGui = {
		classification = "ambiguous",
		expectedRole = "server",
		records = {
			{ pid = 4801, ppid = 4800, executablePath = expectedConstants.coreExecutablePath, role = "server" },
		},
		guiRecords = {
			{ pid = 4800, bundlePath = expectedConstants.bundlePath },
			{ pid = 4802, bundlePath = expectedConstants.bundlePath },
		},
	},
	duplicateCore = {
		classification = "ambiguous",
		expectedRole = "server",
		records = {
			{ pid = 4901, ppid = 4900, executablePath = expectedConstants.coreExecutablePath, role = "server" },
			{ pid = 4902, ppid = 4900, executablePath = expectedConstants.coreExecutablePath, role = "server" },
		},
		guiRecords = {
			{ pid = 4900, bundlePath = expectedConstants.bundlePath },
		},
	},
}

assert(type(fixtures.process) == "table", "fixtures.process must be a table")
local processRecords = {}
for fixtureName, expected in pairs(expectedProcessFixtures) do
	local fixture = assert(fixtures.process[fixtureName], "missing process fixture: " .. fixtureName)
	assert(type(fixture.name) == "string" and fixture.name ~= "", fixtureName .. " must have a name")
	assert(
		fixture.expectedClassification == expected.classification,
		fixtureName .. " must name its intended classification"
	)
	assert(fixture.expectedRole == expected.expectedRole, fixtureName .. " has the wrong expected role")

	local records = parseSnapshot(fixture.snapshot, fixtureName)
	assertProcessRecords(records, expected.records, fixtureName)
	assertGuiRecords(fixture.guiRecords, expected.guiRecords, fixtureName)
	processRecords[fixtureName] = records
end

assert(processRecords.healthyClient[1].ppid == fixtures.process.healthyClient.guiRecords[1].pid)
assert(processRecords.healthyServer[1].ppid == fixtures.process.healthyServer.guiRecords[1].pid)
assert(#processRecords.absent == 0 and #fixtures.process.absent.guiRecords == 1)
assert(#fixtures.process.orphan.guiRecords == 0 and processRecords.orphan[1].ppid == 1)
assert(processRecords.wrongCorePath[1].ppid == fixtures.process.wrongCorePath.guiRecords[1].pid)
assert(processRecords.wrongCorePath[1].executablePath ~= expectedConstants.coreExecutablePath)
assert(processRecords.wrongGuiPath[1].ppid == fixtures.process.wrongGuiPath.guiRecords[1].pid)
assert(fixtures.process.wrongGuiPath.guiRecords[1].bundlePath ~= expectedConstants.bundlePath)
assert(processRecords.wrongRole[1].role ~= fixtures.process.wrongRole.expectedRole)
assert(#fixtures.process.duplicateGui.guiRecords == 2 and #processRecords.duplicateGui == 1)
for _, record in ipairs(processRecords.duplicateCore) do
	assert(record.ppid == fixtures.process.duplicateCore.guiRecords[1].pid)
end

local function copyPath(path)
	local copy = {}
	for index, title in ipairs(path) do
		copy[index] = title
	end
	return copy
end

local function isExactCommandS(item)
	local modifiers = item.AXMenuItemCmdModifiers
	return type(item.AXMenuItemCmdChar) == "string"
		and item.AXMenuItemCmdChar:lower() == "s"
		and type(modifiers) == "table"
		and #modifiers == 1
		and modifiers[1] == "cmd"
end

local function collectMenuCandidates(tree, fixtureName)
	local candidates = { enabled = {}, disabled = {} }

	local function visit(item, parentPath)
		assert(type(item) == "table", fixtureName .. " contains a non-table menu item")
		assert(type(item.AXRole) == "string", fixtureName .. " menu item is missing AXRole")
		assert(type(item.AXTitle) == "string", fixtureName .. " menu item is missing AXTitle")

		local path = copyPath(parentPath)
		if item.AXTitle ~= "" then
			table.insert(path, item.AXTitle)
		end

		local children = item.AXChildren
		if children ~= nil then
			assert(type(children) == "table", fixtureName .. " AXChildren must be a table")
			for _, child in ipairs(children) do
				visit(child, path)
			end
		end

		if (children == nil or #children == 0) and isExactCommandS(item) then
			assert(type(item.AXEnabled) == "boolean", fixtureName .. " Command-S candidate needs boolean AXEnabled")
			local destination = item.AXEnabled == true and candidates.enabled or candidates.disabled
			table.insert(destination, path)
		end
	end

	assert(type(tree) == "table" and #tree > 0, fixtureName .. " tree must be non-empty")
	for _, item in ipairs(tree) do
		visit(item, {})
	end
	return candidates
end

local function assertPath(actual, expected, context)
	assert(type(actual) == "table", context .. " must be a path")
	assert(#actual == #expected, context .. " has the wrong depth")
	for index, title in ipairs(expected) do
		assert(actual[index] == title, context .. " has the wrong title at depth " .. index)
	end
end

local function assertCandidatePaths(actual, expected, context)
	assert(#actual == #expected, context .. " has the wrong candidate count")
	for index, expectedPath in ipairs(expected) do
		assertPath(actual[index], expectedPath, context .. " candidate " .. index)
	end
end

local expectedMenuFixtures = {
	serverStart = {
		outcome = "selected",
		expectedPath = { "Datei", "Starten" },
		enabledCandidates = { { "Datei", "Starten" } },
		disabledCandidates = {},
	},
	clientStartLocalized = {
		outcome = "selected",
		expectedPath = { "Fichier", "Se connecter" },
		enabledCandidates = { { "Fichier", "Se connecter" } },
		disabledCandidates = {},
	},
	disabledOnly = {
		outcome = "disabled-only",
		enabledCandidates = {},
		disabledCandidates = { { "Fichier", "Se connecter" } },
	},
	zeroCandidates = {
		outcome = "zero-candidates",
		enabledCandidates = {},
		disabledCandidates = {},
	},
	multipleCandidates = {
		outcome = "multiple-candidates",
		enabledCandidates = {
			{ "Datei", "Starten" },
			{ "Fenster", "Seitenleiste" },
		},
		disabledCandidates = {},
	},
}

assert(type(fixtures.menus) == "table", "fixtures.menus must be a table")
for fixtureName, expected in pairs(expectedMenuFixtures) do
	local fixture = assert(fixtures.menus[fixtureName], "missing menu fixture: " .. fixtureName)
	assert(type(fixture.name) == "string" and fixture.name ~= "", fixtureName .. " must have a name")
	assert(fixture.expectedMenuOutcome == expected.outcome, fixtureName .. " must name its intended menu outcome")

	local candidates = collectMenuCandidates(fixture.tree, fixtureName)
	assertCandidatePaths(candidates.enabled, expected.enabledCandidates, fixtureName .. " enabled")
	assertCandidatePaths(candidates.disabled, expected.disabledCandidates, fixtureName .. " disabled")

	if expected.expectedPath then
		assertPath(fixture.expectedPath, expected.expectedPath, fixtureName .. " selected path")
		assertPath(candidates.enabled[1], fixture.expectedPath, fixtureName .. " selected candidate")
	else
		assert(fixture.expectedPath == nil, fixtureName .. " must not name a selected path")
	end
end

print("loaded all Deskflow watchdog fixtures")
