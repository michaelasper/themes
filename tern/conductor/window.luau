--!nonstrict
local ui = tern.ui

local BOARD, READER = "Conductor board", "Conductor reader"
local POLL_MS, TAIL_LINES = 1000, 40
local TERN = tern.getenv("TERN_EXE") or "/Applications/Tern.app/Contents/MacOS/tern"

local BAYS = {
	{ id = "review", label = "REVIEW READY", empty = nil },
	{ id = "working", label = "WORKING", empty = nil },
	{ id = "idle", label = "IDLE", empty = nil },
}
local BADGE = { working = "info", review = "success", idle = "muted" }

local selected = nil
local working = {}
local inspecting = false
local armed = 0
local lastView = {}

local function base(path) return string.match(path or "", "([^/\\]+)/*$") or path or "" end

local function shortTitle(title)
	local t = string.gsub(title or "", "^π%s*%-%s*", "")
	return if t == "" then "pi" else t
end

local function canvases(cx)
	local found = {}
	for _, c in cx.canvas:list() do
		if c.owner == tern.plugin.id then found[c.title] = c.pane end
	end
	return found
end

local function conductorTab(cx)
	local own = canvases(cx)
	return own[BOARD] and cx.session:tab_of(own[BOARD]) or nil
end

local function collect(cx)
	local skip = conductorTab(cx)
	local list = {}
	for _, p in cx.session:panes() do
		local name = p.program and base(p.program)
		if p.kind == "terminal" and name == "pi" and p.tab ~= skip and not p.exited then
			local key = string.format("%.0f", p.pane)
			local state = "idle"
			if working[key] then state = "working" elseif p.alert then state = "review" end
			table.insert(list, { pane = p.pane, key = key, title = shortTitle(p.title), cwd = p.cwd, state = state, ms = p.running and p.running.ms or 0 })
		end
	end
	table.sort(list, function(a, b) return a.pane < b.pane end)
	return list
end

local function strip(s)
	local act = "select=" .. s.key
	local cls = "cd-strip cd-" .. s.state .. (if tostring(selected) == s.key then " cd-selected" else "")
	return ui.el("div", { key = "s" .. s.key, class = cls, actions = { click = act }, title = s.cwd }, {
		ui.el("div", { key = "l1", class = "cd-line" }, {
			ui.node("text", { key = "n", grow = 1, wrap = "none", truncate = "end", spans = { ui.span(s.title, "strong") } }),
			ui.node("badge", { key = "b", text = s.state, tone = BADGE[s.state] }),
		}),
		ui.node("text", { key = "p", wrap = "none", truncate = "start", spans = { ui.span(s.cwd, "path muted") } }),
	})
end

local function boardView(list)
	local counts = { review = 0, working = 0, idle = 0 }
	for _, s in list do counts[s.state] += 1 end
	local kids = {
		ui.stats({
			{ label = "Review", value = tostring(counts.review), tone = "success" },
			{ label = "Working", value = tostring(counts.working), tone = "info" },
			{ label = "Idle", value = tostring(counts.idle) },
		}),
	}
	if #list == 0 then
		table.insert(kids, ui.node("text", { key = "empty", spans = { ui.span("No pi sessions running. Open one in another tab.", "muted") } }))
	end
	for _, bay in BAYS do
		local rows = {}
		for _, s in list do
			if s.state == bay.id then table.insert(rows, strip(s)) end
		end
		if #rows > 0 then
			table.insert(kids, ui.el("div", { key = "h" .. bay.id, class = "cd-bay" }, { ui.node("text", { key = "t", spans = { ui.span(bay.label .. "  " .. #rows, "muted strong") } }) }))
			for _, r in rows do table.insert(kids, r) end
		end
	end
	return ui.col(kids)
end

local function readerView(cx, s)
	if not s then
		return ui.col({ ui.node("text", { key = "none", spans = { ui.span("Select a session on the board.", "muted") } }) })
	end
	local tail = cx.session:read(s.pane, { as = "text", lines = TAIL_LINES })
	return ui.col({
		ui.row({
			ui.node("text", { key = "n", grow = 1, spans = { ui.span(s.title, "strong") } }),
			ui.node("badge", { key = "b", text = s.state, tone = BADGE[s.state] }),
			ui.button("Go to session", { key = "go", variant = "primary", actions = { click = "go=" .. s.key } }),
		}),
		ui.node("text", { key = "cwd", wrap = "none", truncate = "start", spans = { ui.span(s.cwd, "path muted") } }),
		ui.rule(""),
		ui.code(type(tail) == "string" and tail or "", "text"),
	})
end

local function set(cx, pane, view)
	local encoded = tern.json.encode(view)
	if lastView[pane] == encoded then return end
	lastView[pane] = encoded
	cx.canvas:set(pane, { view = view })
end

local function render(cx)
	local own = canvases(cx)
	if not own[BOARD] then return false end
	local list = collect(cx)
	local current
	for _, s in list do
		if tostring(selected) == s.key then current = s end
	end
	if not current and #list > 0 then selected, current = list[1].key, list[1] end
	set(cx, own[BOARD], boardView(list))
	if own[READER] then set(cx, own[READER], readerView(cx, current)) end
	return true
end

local loop
local function arm(ms)
	armed += 1
	local mine = armed
	tern.timer(ms, function(cx)
		if mine == armed and cx then loop(cx) end
	end)
end

loop = function(cx)
	if inspecting then return arm(POLL_MS) end
	if not canvases(cx)[BOARD] then return end
	inspecting = true
	local ok = pcall(tern.process.run, { TERN, "inspect", "--json" }, { timeout_ms = 1500 }, function(result, now)
		inspecting = false
		working = {}
		if result.status == 0 then
			local good, doc = pcall(tern.json.decode, result.stdout)
			if good and type(doc) == "table" and type(doc.panes) == "table" then
				for _, item in doc.panes do
					if item.working == true then working[string.format("%.0f", item.pane)] = true end
				end
			end
		end
		local okr, drawn = pcall(render, now)
		if now and okr and drawn then arm(POLL_MS) end
	end)
	if not ok then
		inspecting = false
		render(cx)
		arm(POLL_MS)
	end
end

local function open(cx)
	local own = canvases(cx)
	if own[BOARD] then
		cx.layout:focus(own[BOARD])
		return arm(0)
	end
	local tab = cx.layout:tab({ name = "Conductor", launch = { command = "pi" } })
	if not tab then return cx:toast("error", "Conductor", "could not open its tab") end
	local manager
	for _, p in cx.session:panes() do
		if p.tab == tab then manager = p.pane end
	end
	local board, err = cx.canvas:open({
		title = BOARD,
		about = "Pi sessions grouped by what they need. Click a strip to read it on the right.",
		view = ui.col({}),
		target = manager, dir = "right", ratio = 0.67, focus = false,
	})
	if not board then return cx:toast("error", "Conductor board", err) end
	local _, rerr = cx.canvas:open({
		title = READER,
		about = "The selected session's recent output. Go to session focuses its pane.",
		view = ui.col({}),
		target = board, dir = "right", ratio = 0.5, focus = false,
	})
	if rerr then cx:toast("error", "Conductor reader", rerr) end
	cx.layout:focus(manager)
	arm(300)
end

tern.command({ id = "open", title = "Open Conductor", icon = "grid", run = open })

tern.on("canvas_action", function(ev, cx)
	local own = canvases(cx)
	if ev.pane ~= own[BOARD] and ev.pane ~= own[READER] then return false end
	if ev.act == "select" and ev.value then
		selected = ev.value
		lastView = {}
		render(cx)
		return true
	end
	if ev.act == "go" and ev.value then
		for _, s in collect(cx) do
			if s.key == ev.value then
				cx.layout:focus(s.pane)
				break
			end
		end
		return true
	end
	return false
end)

tern.on("window_start", function() arm(300) end)
tern.timer(300, function() arm(0) end)
