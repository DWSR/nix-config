local Model = {}

local expectedBundlePath = "/Applications/Deskflow.app"
local expectedCorePath = expectedBundlePath .. "/Contents/MacOS/deskflow-core"

local encodedBytes = {
	["%09"] = "\t",
	["%0A"] = "\n",
	["%0D"] = "\r",
	["%25"] = "%",
}

local function decodeField(encoded)
	local decoded = {}
	local index = 1

	while index <= #encoded do
		local byte = encoded:sub(index, index)
		if byte == "%" then
			local escape = encoded:sub(index, index + 2)
			local value = encodedBytes[escape]
			if value == nil then
				return nil, "invalid field escape"
			end
			table.insert(decoded, value)
			index = index + 3
		elseif byte == "\t" or byte == "\r" or byte == "\n" or byte == "\0" then
			return nil, "unencoded control byte"
		else
			table.insert(decoded, byte)
			index = index + 1
		end
	end

	return table.concat(decoded)
end

local function parseInteger(encoded, positive)
	local canonical = encoded == "0" or encoded:match("^[1-9]%d*$") ~= nil
	if not canonical or (positive and encoded == "0") then
		return nil
	end

	local value = tonumber(encoded)
	if value == nil or math.type(value) ~= "integer" then
		return nil
	end
	return value
end

local function splitRow(row)
	local fields = {}
	local fieldStart = 1

	for fieldIndex = 1, 3 do
		local separator = row:find("\t", fieldStart, true)
		if separator == nil then
			return nil, "expected four tab-separated fields"
		end
		fields[fieldIndex] = row:sub(fieldStart, separator - 1)
		fieldStart = separator + 1
	end

	fields[4] = row:sub(fieldStart)
	if fields[4]:find("\t", 1, true) then
		return nil, "expected four tab-separated fields"
	end
	return fields
end

local function parseRow(row)
	if row == "" then
		return nil, "empty row"
	end

	local fields, fieldError = splitRow(row)
	if fields == nil then
		return nil, fieldError
	end

	local pid = parseInteger(fields[1], true)
	if pid == nil then
		return nil, "invalid PID"
	end

	local ppid = parseInteger(fields[2], false)
	if ppid == nil then
		return nil, "invalid parent PID"
	end

	local executablePath, pathError = decodeField(fields[3])
	if executablePath == nil then
		return nil, pathError
	end
	if executablePath:sub(1, 1) ~= "/" then
		return nil, "executable path must be absolute"
	end

	local role, roleError = decodeField(fields[4])
	if role == nil then
		return nil, roleError
	end
	if role == "" then
		role = nil
	end

	return {
		pid = pid,
		ppid = ppid,
		executablePath = executablePath,
		role = role,
	}
end

function Model.parseSnapshot(text)
	if type(text) ~= "string" then
		return nil, "snapshot must be a string"
	end
	if text == "" then
		return {}
	end
	if text:sub(-1) ~= "\n" then
		return nil, "snapshot must end with a newline"
	end

	local records = {}
	local rowStart = 1
	local rowNumber = 1
	while rowStart <= #text do
		local rowEnd = text:find("\n", rowStart, true)
		local record, rowError = parseRow(text:sub(rowStart, rowEnd - 1))
		if record == nil then
			return nil, "row " .. rowNumber .. ": " .. rowError
		end
		table.insert(records, record)
		rowStart = rowEnd + 1
		rowNumber = rowNumber + 1
	end

	return records
end

local function isInteger(value)
	return type(value) == "number" and math.type(value) == "integer"
end

local function isArrayOf(records, validateRecord)
	if type(records) ~= "table" then
		return false
	end

	local length = #records
	for key in pairs(records) do
		if not isInteger(key) or key < 1 or key > length then
			return false
		end
	end
	for _, record in ipairs(records) do
		if not validateRecord(record) then
			return false
		end
	end
	return true
end

local function isProcessRecord(record)
	return type(record) == "table"
		and isInteger(record.pid)
		and record.pid > 0
		and isInteger(record.ppid)
		and record.ppid >= 0
		and type(record.executablePath) == "string"
		and record.executablePath:sub(1, 1) == "/"
		and (record.role == nil or (type(record.role) == "string" and record.role ~= ""))
end

local function isGuiRecord(record)
	return type(record) == "table"
		and isInteger(record.pid)
		and record.pid > 0
		and type(record.bundlePath) == "string"
		and record.bundlePath:sub(1, 1) == "/"
end

local function observation(kind, reason)
	return {
		kind = kind,
		reason = reason,
	}
end

function Model.classify(records, guiRecords, expected)
	if
		type(expected) ~= "table"
		or expected.bundlePath ~= expectedBundlePath
		or (expected.role ~= "client" and expected.role ~= "server")
	then
		return observation("error", "invalid-expected")
	end
	if not isArrayOf(records, isProcessRecord) then
		return observation("error", "invalid-process-records")
	end
	if not isArrayOf(guiRecords, isGuiRecord) then
		return observation("error", "invalid-gui-records")
	end

	if #guiRecords == 0 then
		if #records == 0 then
			return observation("absent", "gui-and-core-absent")
		end
		return observation("ambiguous", "core-without-gui")
	end
	if #guiRecords ~= 1 then
		return observation("ambiguous", "gui-cardinality")
	end

	local gui = guiRecords[1]
	if gui.bundlePath ~= expectedBundlePath then
		return observation("ambiguous", "gui-path")
	end
	if #records == 0 then
		return observation("absent", "core-absent")
	end
	if #records ~= 1 then
		return observation("ambiguous", "core-cardinality")
	end

	local core = records[1]
	if core.executablePath ~= expectedCorePath then
		return observation("ambiguous", "core-path")
	end
	if core.ppid ~= gui.pid then
		return observation("ambiguous", "core-parent")
	end
	if core.role ~= expected.role then
		return observation("ambiguous", "core-role")
	end

	return observation("healthy", "expected-core")
end

local function hasOnlyCommandModifier(modifiers)
	if type(modifiers) ~= "table" then
		return false
	end

	local count = 0
	for _, modifier in pairs(modifiers) do
		if modifier ~= "cmd" then
			return false
		end
		count = count + 1
	end
	return count == 1
end

local function copyPath(path)
	local copy = {}
	for index, title in ipairs(path) do
		copy[index] = title
	end
	return copy
end

local function denseArrayLength(items)
	if type(items) ~= "table" then
		return nil
	end

	local count = 0
	for key in pairs(items) do
		if not isInteger(key) or key < 1 then
			return nil
		end
		count = count + 1
	end
	for index = 1, count do
		if items[index] == nil then
			return nil
		end
	end
	return count
end

local function hasNumericKey(item)
	for key in pairs(item) do
		if type(key) == "number" then
			return true
		end
	end
	return false
end

function Model.findStartAction(menuTree, shortcut)
	if type(menuTree) ~= "table" then
		return nil, "invalid menu tree"
	end
	if type(shortcut) ~= "string" or shortcut == "" then
		return nil, "invalid menu selector input"
	end

	local candidates = {}
	local path = {}
	local normalizedShortcut = shortcut:lower()
	local seenCollections = {}
	local seenItems = {}
	local function visit(items)
		local itemCount = denseArrayLength(items)
		if itemCount == nil or seenCollections[items] then
			return false
		end
		seenCollections[items] = true

		for index = 1, itemCount do
			local item = items[index]
			if type(item) ~= "table" then
				return false
			end

			local wrapperCount = denseArrayLength(item)
			if wrapperCount ~= nil then
				if wrapperCount == 0 or not visit(item) then
					return false
				end
			else
				if hasNumericKey(item) or seenItems[item] then
					return false
				end
				seenItems[item] = true

				local title = item.AXTitle
				if title ~= nil and type(title) ~= "string" then
					return false
				end
				local hasTitle = type(title) == "string" and title ~= ""

				local children = item.AXChildren
				local childCount = 0
				if children ~= nil then
					childCount = denseArrayLength(children)
					if childCount == nil then
						return false
					end
				end
				if childCount > 0 and not hasTitle then
					return false
				end

				if hasTitle then
					table.insert(path, title)
				end

				if childCount > 0 then
					if not visit(children) then
						return false
					end
				elseif
					item.AXEnabled == true
					and type(item.AXMenuItemCmdChar) == "string"
					and item.AXMenuItemCmdChar:lower() == normalizedShortcut
					and hasOnlyCommandModifier(item.AXMenuItemCmdModifiers)
				then
					if not hasTitle then
						return false
					end
					table.insert(candidates, copyPath(path))
				end

				if hasTitle then
					table.remove(path)
				end
			end
		end
		return true
	end
	if not visit(menuTree) then
		return nil, "invalid menu tree"
	end

	if #candidates == 1 then
		return candidates[1]
	end
	if #candidates == 0 then
		return nil, "start action unavailable"
	end
	return nil, "multiple start actions"
end

local activeRecoveryPhases = {
	activating = true,
	selecting = true,
	verifying = true,
}

local waitingPhases = {
	backoff = true,
	cooldown = true,
}

local observationKinds = {
	healthy = true,
	absent = true,
	ambiguous = true,
	error = true,
}

local function isFiniteNonnegativeNumber(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge and value >= 0
end

local function validatePolicy(policy)
	if type(policy) ~= "table" then
		return "policy must be a table"
	end
	if
		type(policy.absenceThreshold) ~= "number"
		or math.type(policy.absenceThreshold) ~= "integer"
		or policy.absenceThreshold < 1
	then
		return "absence threshold must be a positive integer"
	end
	if not isFiniteNonnegativeNumber(policy.startupGrace) then
		return "startup grace must be a finite non-negative number"
	end
	if not isFiniteNonnegativeNumber(policy.wakeGrace) then
		return "wake grace must be a finite non-negative number"
	end
	if not isInteger(policy.attemptLimit) or policy.attemptLimit < 1 then
		return "attempt limit must be a positive integer"
	end
	if not isFiniteNonnegativeNumber(policy.recoveryWindow) or policy.recoveryWindow == 0 then
		return "recovery window must be a finite positive number"
	end
	local retryDelayCount = denseArrayLength(policy.retryDelays)
	if retryDelayCount ~= policy.attemptLimit - 1 then
		return "retry delays must contain one delay before each remaining attempt"
	end
	for _, delay in ipairs(policy.retryDelays) do
		if not isFiniteNonnegativeNumber(delay) then
			return "retry delays must be finite non-negative numbers"
		end
	end
	if not isFiniteNonnegativeNumber(policy.cooldown) or policy.cooldown == 0 then
		return "cooldown must be a finite positive number"
	end
	return nil
end

local function deepCopy(value, seen)
	if type(value) ~= "table" then
		return value
	end
	seen = seen or {}
	if seen[value] ~= nil then
		return seen[value]
	end

	local copy = {}
	seen[value] = copy
	for key, item in pairs(value) do
		copy[deepCopy(key, seen)] = deepCopy(item, seen)
	end
	return copy
end

local function graceDeadline(now, duration)
	local deadline = now + duration
	if not isFiniteNonnegativeNumber(deadline) then
		return nil
	end
	return deadline
end

local function isValidState(state)
	if type(state) ~= "table" or validatePolicy(state.policy) ~= nil then
		return false
	end
	if not isFiniteNonnegativeNumber(state.lastTimestamp) then
		return false
	end
	if
		type(state.absenceCount) ~= "number"
		or math.type(state.absenceCount) ~= "integer"
		or state.absenceCount < 0
		or state.absenceCount >= state.policy.absenceThreshold
	then
		return false
	end
	local attemptCount = denseArrayLength(state.attemptHistory)
	if attemptCount == nil or attemptCount > state.policy.attemptLimit then
		return false
	end
	local previousAttempt = -1
	for _, attemptAt in ipairs(state.attemptHistory) do
		if
			not isFiniteNonnegativeNumber(attemptAt)
			or attemptAt < previousAttempt
			or attemptAt > state.lastTimestamp
		then
			return false
		end
		previousAttempt = attemptAt
	end
	if type(state.alertKeys) ~= "table" then
		return false
	end
	for key, present in pairs(state.alertKeys) do
		if type(key) ~= "string" or key == "" or present ~= true then
			return false
		end
	end
	if state.persistentAlertKey ~= nil then
		if
			type(state.persistentAlertKey) ~= "string"
			or state.persistentAlertKey == ""
			or state.alertKeys[state.persistentAlertKey] ~= true
		then
			return false
		end
	end

	local phase = state.phase
	if
		phase ~= "grace"
		and phase ~= "observing"
		and phase ~= "sleeping"
		and not activeRecoveryPhases[phase]
		and not waitingPhases[phase]
	then
		return false
	end
	if phase == "grace" then
		if
			not isFiniteNonnegativeNumber(state.graceUntil)
			or state.graceUntil < state.lastTimestamp
			or state.absenceCount ~= 0
		then
			return false
		end
	elseif state.graceUntil ~= nil then
		return false
	end
	if (phase == "sleeping" or activeRecoveryPhases[phase]) and state.absenceCount ~= 0 then
		return false
	end
	if phase == "backoff" then
		if
			not isFiniteNonnegativeNumber(state.retryAt)
			or state.retryAt < state.lastTimestamp
			or state.cooldownUntil ~= nil
		then
			return false
		end
	elseif phase == "cooldown" then
		if
			not isFiniteNonnegativeNumber(state.cooldownUntil)
			or state.cooldownUntil < state.lastTimestamp
			or state.retryAt ~= nil
			or attemptCount < state.policy.attemptLimit
		then
			return false
		end
	elseif phase == "grace" then
		if state.retryAt ~= nil and state.cooldownUntil ~= nil then
			return false
		end
		if state.retryAt ~= nil and not isFiniteNonnegativeNumber(state.retryAt) then
			return false
		end
		if state.cooldownUntil ~= nil then
			if not isFiniteNonnegativeNumber(state.cooldownUntil) or attemptCount < state.policy.attemptLimit then
				return false
			end
		end
	elseif phase == "sleeping" then
		if state.retryAt ~= nil and state.cooldownUntil ~= nil then
			return false
		end
		if state.retryAt ~= nil then
			if not isFiniteNonnegativeNumber(state.retryAt) or attemptCount >= state.policy.attemptLimit then
				return false
			end
		end
		if state.cooldownUntil ~= nil then
			if not isFiniteNonnegativeNumber(state.cooldownUntil) or attemptCount < state.policy.attemptLimit then
				return false
			end
		end
	elseif state.retryAt ~= nil or state.cooldownUntil ~= nil then
		return false
	end
	if
		phase ~= "cooldown"
		and phase ~= "sleeping"
		and not (phase == "grace" and state.cooldownUntil ~= nil)
		and attemptCount >= state.policy.attemptLimit
	then
		return false
	end

	if state.recoveryPhase == nil and state.interruptedRecoveryPhase == nil then
		return true
	end
	return phase == "sleeping"
		and state.recoveryPhase == "aborted"
		and activeRecoveryPhases[state.interruptedRecoveryPhase] == true
end

function Model.new(policy, now)
	local policyError = validatePolicy(policy)
	if policyError ~= nil then
		return nil, policyError
	end
	if not isFiniteNonnegativeNumber(now) then
		return nil, "timestamp must be a finite non-negative number"
	end

	local deadline = graceDeadline(now, policy.startupGrace)
	if deadline == nil then
		return nil, "startup grace deadline is invalid"
	end

	return {
		phase = "grace",
		policy = deepCopy(policy),
		graceUntil = deadline,
		absenceCount = 0,
		attemptHistory = {},
		alertKeys = {},
		lastTimestamp = now,
	}
end

local function clearPersistentAlert(state)
	if state.persistentAlertKey ~= nil then
		state.alertKeys[state.persistentAlertKey] = nil
		state.persistentAlertKey = nil
	end
end

local function emitAlertOnce(state, decisions, key, reason, details)
	if state.alertKeys[key] then
		return
	end

	state.alertKeys[key] = true
	local decision = {
		kind = "alert",
		key = key,
		reason = reason,
	}
	for detail, value in pairs(details or {}) do
		decision[detail] = value
	end
	table.insert(decisions, decision)
end

local function recordPersistentAlert(state, decisions, kind, reason)
	if type(reason) ~= "string" or reason == "" then
		reason = kind
	end
	local key = kind .. ":" .. reason
	if state.persistentAlertKey ~= key then
		clearPersistentAlert(state)
		state.persistentAlertKey = key
	end
	emitAlertOnce(state, decisions, key, reason)
end

local function clearRecoveryState(state)
	state.absenceCount = 0
	state.attemptHistory = {}
	state.retryAt = nil
	state.cooldownUntil = nil
	state.alertKeys = {}
	state.persistentAlertKey = nil
end

local function advanceEligibility(state, now)
	if state.phase == "backoff" and now >= state.retryAt then
		state.phase = "observing"
		state.retryAt = nil
	elseif state.phase == "cooldown" and now >= state.cooldownUntil then
		state.phase = "observing"
		state.cooldownUntil = nil
		state.attemptHistory = {}
		state.alertKeys["recovery:cooldown"] = nil
	end
end

function Model.observe(state, observed, now)
	if
		not isValidState(state)
		or type(observed) ~= "table"
		or not observationKinds[observed.kind]
		or not isFiniteNonnegativeNumber(now)
		or now < state.lastTimestamp
	then
		return state, {}
	end

	local nextState = deepCopy(state)
	nextState.lastTimestamp = now
	if nextState.phase == "sleeping" or activeRecoveryPhases[nextState.phase] then
		return nextState, {}
	end

	if nextState.phase == "grace" then
		if now < nextState.graceUntil then
			if observed.kind == "healthy" then
				clearRecoveryState(nextState)
			else
				nextState.absenceCount = 0
			end
			return nextState, {}
		end
		if nextState.retryAt ~= nil then
			nextState.phase = "backoff"
		elseif nextState.cooldownUntil ~= nil then
			nextState.phase = "cooldown"
		else
			nextState.phase = "observing"
		end
		nextState.graceUntil = nil
		nextState.absenceCount = 0
	end

	advanceEligibility(nextState, now)
	if observed.kind == "healthy" then
		if waitingPhases[nextState.phase] then
			nextState.phase = "observing"
		end
		clearRecoveryState(nextState)
		return nextState, {}
	end
	if observed.kind == "ambiguous" or observed.kind == "error" then
		nextState.absenceCount = 0
		local decisions = {}
		recordPersistentAlert(nextState, decisions, observed.kind, observed.reason)
		return nextState, decisions
	end
	if waitingPhases[nextState.phase] then
		nextState.absenceCount = 0
		return nextState, {}
	end

	nextState.absenceCount = nextState.absenceCount + 1
	if nextState.absenceCount < nextState.policy.absenceThreshold then
		return nextState, {}
	end

	nextState.phase = "activating"
	nextState.absenceCount = 0
	return nextState, {
		{ kind = "recover", phase = "activating" },
	}
end

local recoveryTransitions = {
	activating = "selecting",
	selecting = "verifying",
}

-- Runtime reports completed GUI activation and menu selection through this pure phase transition.
function Model.advanceRecovery(state, nextPhase, now)
	if
		not isValidState(state)
		or not isFiniteNonnegativeNumber(now)
		or now < state.lastTimestamp
		or recoveryTransitions[state.phase] ~= nextPhase
	then
		return state, {}
	end

	local nextState = deepCopy(state)
	nextState.phase = nextPhase
	nextState.lastTimestamp = now
	return nextState, {}
end

local recoveryResultKinds = {
	recovered = true,
	unavailable = true,
	failed = true,
	ambiguous = true,
}

local function retainedAttempts(state, now)
	local cutoff = now - state.policy.recoveryWindow
	local attempts = {}
	for _, attemptAt in ipairs(state.attemptHistory) do
		if attemptAt >= cutoff then
			table.insert(attempts, attemptAt)
		end
	end
	table.insert(attempts, now)
	return attempts
end

function Model.recoveryResult(state, result, now)
	if
		not isValidState(state)
		or not activeRecoveryPhases[state.phase]
		or type(result) ~= "table"
		or not recoveryResultKinds[result.kind]
		or not isFiniteNonnegativeNumber(now)
		or now < state.lastTimestamp
	then
		return state, {}
	end

	local nextState = deepCopy(state)
	nextState.lastTimestamp = now
	if result.kind == "recovered" then
		nextState.phase = "observing"
		clearRecoveryState(nextState)
		return nextState, {}
	end

	local decisions = {}
	local reason = result.reason
	if type(reason) ~= "string" or reason == "" then
		reason = result.kind
	end
	if result.kind == "unavailable" or result.kind == "ambiguous" then
		recordPersistentAlert(nextState, decisions, result.kind, reason)
	else
		clearPersistentAlert(nextState)
	end

	nextState.absenceCount = 0
	nextState.attemptHistory = retainedAttempts(nextState, now)
	if #nextState.attemptHistory >= nextState.policy.attemptLimit then
		local cooldownUntil = graceDeadline(now, nextState.policy.cooldown)
		if cooldownUntil == nil then
			return state, {}
		end
		nextState.phase = "cooldown"
		nextState.retryAt = nil
		nextState.cooldownUntil = cooldownUntil
		emitAlertOnce(nextState, decisions, "recovery:cooldown", reason, {
			cooldownUntil = cooldownUntil,
		})
		return nextState, decisions
	end

	local delay = nextState.policy.retryDelays[#nextState.attemptHistory]
	local retryAt = graceDeadline(now, delay)
	if retryAt == nil then
		return state, {}
	end
	nextState.phase = "backoff"
	nextState.retryAt = retryAt
	nextState.cooldownUntil = nil
	table.insert(decisions, {
		kind = "retry-after",
		delay = delay,
		retryAt = retryAt,
	})
	return nextState, decisions
end

function Model.lifecycle(state, event, now)
	if not isValidState(state) or (event ~= "sleep" and event ~= "wake") then
		return state, {}
	end
	if not isFiniteNonnegativeNumber(now) or now < state.lastTimestamp then
		return state, {}
	end

	if event == "wake" then
		if state.phase ~= "sleeping" then
			return state, {}
		end
		local deadline = graceDeadline(now, state.policy.wakeGrace)
		if deadline == nil then
			return state, {}
		end
		local nextState = deepCopy(state)
		nextState.phase = "grace"
		nextState.graceUntil = deadline
		nextState.absenceCount = 0
		nextState.lastTimestamp = now
		nextState.recoveryPhase = nil
		nextState.interruptedRecoveryPhase = nil
		if nextState.retryAt ~= nil and nextState.retryAt <= now then
			nextState.retryAt = nil
		end
		if nextState.cooldownUntil ~= nil and nextState.cooldownUntil <= now then
			nextState.attemptHistory = {}
			nextState.alertKeys["recovery:cooldown"] = nil
			nextState.cooldownUntil = nil
		end
		return nextState, {}
	end

	local nextState = deepCopy(state)
	nextState.lastTimestamp = now
	if nextState.phase == "sleeping" then
		return nextState, {}
	end

	local interruptedRecoveryPhase = activeRecoveryPhases[nextState.phase] and nextState.phase or nil
	nextState.phase = "sleeping"
	nextState.graceUntil = nil
	nextState.absenceCount = 0
	if interruptedRecoveryPhase == nil then
		nextState.recoveryPhase = nil
		nextState.interruptedRecoveryPhase = nil
		return nextState, {}
	end

	nextState.recoveryPhase = "aborted"
	nextState.interruptedRecoveryPhase = interruptedRecoveryPhase
	return nextState,
		{
			{ kind = "abort-recovery", phase = interruptedRecoveryPhase },
			{ kind = "restore-focus" },
		}
end

return Model
