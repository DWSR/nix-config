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

return Model
