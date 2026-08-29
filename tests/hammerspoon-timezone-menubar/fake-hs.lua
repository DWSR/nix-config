local fakeHs = {
	_canvases = {},
	_menubars = {},
	_tasks = {},
	_timers = {},
	_failStarts = {},
}

fakeHs.menubar = {}
function fakeHs.menubar.new(inMenuBar, autosaveName)
	local menubar = {
		inMenuBar = inMenuBar,
		autosaveName = autosaveName,
	}
	function menubar:setTitle(title)
		self.title = title
		return self
	end
	function menubar:setIcon(icon, template)
		self.icon = icon
		self.iconTemplate = template
		return self
	end
	function menubar:setTooltip(tooltip)
		self.tooltip = tooltip
		return self
	end
	table.insert(fakeHs._menubars, menubar)
	return menubar
end

local styledTextMt = {}
styledTextMt.__index = styledTextMt
local function newStyledText(segments)
	return setmetatable({ segments = segments }, styledTextMt)
end

local function appendSegments(destination, value)
	if getmetatable(value) == styledTextMt then
		for _, segment in ipairs(value.segments) do
			table.insert(destination, segment)
		end
	else
		table.insert(destination, { text = tostring(value) })
	end
end

function styledTextMt.__concat(left, right)
	local segments = {}
	appendSegments(segments, left)
	appendSegments(segments, right)
	return newStyledText(segments)
end

function styledTextMt:getString()
	local parts = {}
	for index, segment in ipairs(self.segments) do
		parts[index] = segment.text
	end
	return table.concat(parts)
end

fakeHs.styledtext = {}
function fakeHs.styledtext.convertFont(font, heavier)
	assert(heavier == true)
	return { name = "System-Bold", size = font.size }
end
function fakeHs.styledtext.new(text, attributes)
	return newStyledText({ { text = text, attributes = attributes } })
end

fakeHs.canvas = {}
function fakeHs.canvas.new(frame)
	local canvas = {
		elements = {},
		frame = frame,
	}
	function canvas:appendElements(...)
		for _, element in ipairs({ ... }) do
			table.insert(self.elements, element)
		end
		return self
	end
	function canvas:imageFromCanvas()
		return { elements = self.elements, frame = self.frame }
	end
	function canvas:delete()
		self.deleted = true
	end
	table.insert(fakeHs._canvases, canvas)
	return canvas
end

fakeHs.task = {}
function fakeHs.task.new(path, callback, arguments)
	local task = {
		path = path,
		callback = callback,
		arguments = arguments,
	}
	function task:setEnvironment(environment)
		self.environment = environment
		return self
	end
	function task:start()
		if fakeHs._failStarts[self.environment.TZ] then
			return false
		end
		self.started = true
		table.insert(fakeHs._tasks, self)
		return self
	end
	function task:complete(exitCode, stdOut, stdErr)
		assert(self.started, "cannot complete a task that did not start")
		assert(not self.completed, "task completed twice")
		self.completed = true
		self.callback(exitCode, stdOut, stdErr or "")
	end
	return task
end

fakeHs.timer = {}
function fakeHs.timer.doEvery(interval, callback)
	local timer = {
		interval = interval,
		callback = callback,
	}
	table.insert(fakeHs._timers, timer)
	return timer
end

return fakeHs
