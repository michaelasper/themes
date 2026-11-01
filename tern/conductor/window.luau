--!nonstrict
local ui = tern.ui
local Logic = require("./logic")

local BOARD, READER, HOST = "Conductor board", "Conductor reader", "Conductor host"
local TAIL_LINES = 40
local CLOCK_MS = 60000 -- re-sample the epoch clock (no epoch in Luau: one `date +%s`)
local TICK_MS, VOICE_TICK_MS, HIDDEN_MS = 1000, 400, 20000
local INSPECT_MS = 2000 -- tern inspect (one process) at most this often, and only while the tab is shown
local GIT_MS, GIT_TIMEOUT_MS = 8000, 5000 -- git for the selected review/needs-you session only
local TERN = tern.getenv("TERN_EXE") or "/Applications/Tern.app/Contents/MacOS/tern"
local HOME = tern.getenv("HOME") or ""
local STATUS_DIR = HOME .. "/.local/state/conductor/tern-status"
local VOICE_FILE = tern.getenv("PI_SPEAK_STATE_FILE") or (HOME .. "/.pi/agent/pi-speak/state.json")
local MANAGER_FILE = tern.getenv("CONDUCTOR_SESSION_FILE") or (HOME .. "/.config/conductor/session.json")

local selected = nil
local working = {} -- from tern inspect
local seen = {} -- per pane: Logic.since records
local voiceTrack = {}
local voice = { state = "offline", level = 0 }
local inspecting, lastInspect = false, -math.huge
local clockBusy, epochBase, epochAt = false, nil, -math.huge -- epochBase = epoch ms minus tern.now() at the sample
local armed = 0
local gen = 0 -- lifecycle: bumped when the board is opened or found gone, so older async work is dropped
local lastView = {}
local git = {} -- by cwd: { at, status = {lines}, diff = {lines}, err }
local gitBusy, gitWant = false, nil -- ONE git job in flight globally; gitWant = latest-selected cwd
local current = {} -- last collected list, for key commands
local managerPane = nil
local wasShown, digestBase = false, nil
local lastErr = nil

local function key(n) return string.format("%.0f", n) end

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

-- True when the Conductor tab is the one on screen.
local function shown(cx)
	local own = canvases(cx)
	if not own[BOARD] then return false end
	local f = cx.session:focused()
	if not f then return false end
	local tab = cx.session:tab_of(f)
	return tab ~= nil and tab == cx.session:tab_of(own[BOARD])
end

-- An async completion may touch state only if it is the same lifecycle, has a fresh cx, and the board is on screen.
local function live(cx, g)
	return g == gen and cx ~= nil and shown(cx)
end

local function readFile(path, max)
	local ok, text = pcall(tern.fs.read, path, max)
	return ok and text or nil
end

local function epochNow(now)
	return epochBase and (epochBase + now) or nil
end

local function readManager()
	local text = readFile(MANAGER_FILE, 4096)
	return text and Logic.parseManager(text, tern.json.decode) or nil
end

-- Only live panes' status files are read (never the whole directory). A file that is not fresh on the epoch
-- clock, or whose age is unknown, is stale: never trusted, shown as "stale" in IDLE.
local function collect(cx, now)
	local skip = conductorTab(cx)
	local epoch = epochNow(now)
	local list, liveKeys = {}, {}
	managerPane = readManager()
	for _, p in cx.session:panes() do
		if (p.kind == "terminal" or p.kind == "agent") and p.tab ~= skip and not p.exited and p.pane ~= managerPane then
			local k = key(p.pane)
			local file = Logic.parseStatus(readFile(STATUS_DIR .. "/" .. k .. ".json", Logic.STATUS_MAX_BYTES), tern.json.decode)
			local prog = p.program and Logic.base(p.program)
			local piLike = prog == "pi" or (prog == nil and string.find(p.title or "", "π", 1, true) == 1)
			if file or piLike then
				liveKeys[k] = true
				local stale = file ~= nil and not Logic.fresh(file, epoch)
				local trusted = if stale then nil else file
				local bay = if stale then "idle" else Logic.bay(trusted, { working = working[k], alert = p.alert })
				local since = Logic.since(seen, k, bay, now)
				local fileAge = Logic.fileAge(file, epoch)
				local ageText = if stale and fileAge then Logic.age(fileAge) elseif stale then "?" else Logic.age(now - since)
				local title = string.gsub(p.title or "", "^π%s*%-%s*", "")
				local event
				if stale then event = "stale status file (" .. ageText .. " old), not trusted"
				elseif trusted then event = if trusted.turn then "turn " .. trusted.turn else "status file"
				else event = "no status file; tern flags only" end
				table.insert(list, {
					pane = p.pane, key = k, bay = bay, cwd = p.cwd or "", folder = Logic.base(p.cwd),
					name = if title == "" then "pi" else title,
					msg = trusted and trusted.msg or "",
					kind = trusted and trusted.kind or nil,
					stale = stale, event = event, age = ageText,
				})
			end
		end
	end
	for k in seen do
		if not liveKeys[k] then seen[k] = nil end
	end
	Logic.order(list)
	return list
end

-- ---- views ----
local function tagOf(s)
	if s.stale then return "stale", "muted" end
	if s.bay == "needs" and s.kind then return s.kind, "error" end
	return Logic.TAG[s.bay], if s.bay == "needs" then "error" else Logic.TONE[s.bay]
end

local function strip(s)
	local cls = "cd-strip cd-" .. s.bay .. (if selected == s.key then " cd-selected" else "")
	local tag, tone = tagOf(s)
	return ui.el("div", { key = "s" .. s.key, class = cls, actions = { click = "select=" .. s.key }, title = s.cwd }, {
		ui.el("div", { key = "l1", class = "cd-line" }, {
			ui.node("text", { key = "k", spans = { ui.span(s.n and tostring(s.n) or " ", "key") } }),
			ui.node("text", { key = "n", wrap = "none", spans = { ui.span(s.name, "strong") } }),
			ui.node("text", { key = "m", grow = 1, wrap = "none", truncate = "end", spans = { ui.span(s.msg, "muted") } }),
			ui.node("text", { key = "a", wrap = "none", spans = { ui.span(s.age, "muted") } }),
		}),
		ui.node("text", { key = "p", wrap = "none", truncate = "start", spans = { ui.span(s.folder .. "  ", "path"), ui.span(s.cwd, "path muted") } }),
		ui.el("div", { key = "l3", class = "cd-line" }, {
			ui.node("text", { key = "e", grow = 1, wrap = "none", truncate = "end", spans = { ui.span(s.event, "muted") } }),
			ui.node("badge", { key = "b", text = tag, tone = tone }),
		}),
	})
end

local function wave()
	local bars = {}
	local hist = voiceTrack.hist or {}
	local pad = Logic.WAVE_BARS - #hist
	for i = 1, Logic.WAVE_BARS do
		local lv = if i <= pad then 0 else hist[i - pad]
		table.insert(bars, ui.el("div", { key = "w" .. i, class = "cd-b cd-h" .. lv }, {}))
	end
	return ui.el("div", { key = "wave", class = "cd-wave cd-v-" .. voice.state }, bars)
end

local function countsOf(list)
	local counts = { needs = 0, working = 0, review = 0, idle = 0 }
	for _, s in list do counts[s.bay] += 1 end
	return counts
end

local function topBar(counts)
	return ui.el("div", { key = "top", class = "cd-top" }, {
		ui.node("text", { key = "brand", grow = 1, wrap = "none", spans = { ui.span("◆ conductor", "strong"), ui.span("  pi sessions", "muted") } }),
		ui.node("badge", { key = "cn", text = counts.needs .. " blocked", tone = "error" }),
		ui.node("badge", { key = "cw", text = counts.working .. " working", tone = "info" }),
		ui.node("badge", { key = "cr", text = counts.review .. " review", tone = "success" }),
		ui.node("badge", { key = "ci", text = counts.idle .. " idle", tone = "muted" }),
	})
end

local function boardView(list)
	local counts = countsOf(list)
	local kids = { topBar(counts) }
	if #list == 0 then
		table.insert(kids, ui.node("text", { key = "empty", spans = { ui.span("No pi sessions running. Open one in another tab.", "muted") } }))
	end
	for _, bay in Logic.BAYS do
		local rows = {}
		for _, s in list do
			if s.bay == bay.id then table.insert(rows, strip(s)) end
		end
		table.insert(kids, ui.el("div", { key = "h" .. bay.id, class = "cd-bay cd-bay-" .. bay.id }, {
			ui.node("text", { key = "t", spans = { ui.span("● " .. bay.label .. "  ·  " .. #rows, "muted") } }),
		}))
		if #rows == 0 then
			table.insert(kids, ui.el("div", { key = "e" .. bay.id, class = "cd-none" }, {
				ui.node("text", { key = "t", spans = { ui.span("none", "muted") } }),
			}))
		end
		for _, r in rows do table.insert(kids, r) end
	end
	return ui.el("div", { key = "board", class = "cd-root" }, kids)
end

local function dockView()
	local function hint(k, label)
		return { ui.span(k, "key"), ui.span(" " .. label .. "   ", "muted") }
	end
	local spans = {}
	for _, h in { { "⌃⌥1-8", "select" }, { "⌃⌥j/k", "move" }, { "⌃⌥↵", "go to session" }, { "⌃⌥n", "new pi" } } do
		for _, sp in hint(h[1], h[2]) do table.insert(spans, sp) end
	end
	return ui.el("div", { class = "cd-dock" }, { ui.node("text", { key = "h", spans = spans }) })
end

local function hostView(list)
	local counts = countsOf(list)
	local stateLine = if voice.state == "offline" then "voice offline" else "voice " .. voice.state
	local d = Logic.digest(digestBase, list)
	local digest
	if d then
		digest = {
			ui.span("since you looked away  ", "strong"),
			ui.span(string.format("%d blocked, %d ready to review", d.blocked, d.ready), ""),
		}
	else
		digest = { ui.span("since you looked away  ", "strong"), ui.span("no earlier visit recorded", "muted") }
	end
	return ui.el("div", { key = "host", class = "cd-root cd-host" }, {
		ui.node("text", { key = "t", wrap = "none", spans = { ui.span("Conductor", "strong") } }),
		ui.node("text", { key = "s", wrap = "none", spans = { ui.span(stateLine .. " · " .. counts.needs .. " need you", "muted") } }),
		wave(),
		ui.el("div", { key = "dg", class = "cd-digest" }, { ui.node("text", { key = "t", spans = digest }) }),
	})
end

local function codeLines(lines)
	return if #lines == 0 then "" else table.concat(lines, "\n")
end

local function label(k, text)
	return ui.el("div", { key = k, class = "cd-lbl" }, { ui.node("text", { key = "t", wrap = "none", spans = { ui.span(text, "muted") } }) })
end

local function readerView(cx, s)
	if not s then
		return ui.el("div", { key = "detail", class = "cd-root" }, {
			ui.node("text", { key = "none", spans = { ui.span("Select a session on the board.", "muted") } }),
		})
	end
	local kids = {
		label("l", string.upper(Logic.TAG[s.bay]) .. " · " .. string.upper(s.folder)),
		ui.node("text", { key = "n", spans = { ui.span(s.name, "strong") } }),
		ui.node("text", { key = "cwd", wrap = "none", truncate = "start", spans = { ui.span(s.cwd, "path muted") } }),
	}
	if s.bay == "needs" then
		table.insert(kids, label("ld", "DIALOG"))
		table.insert(kids, ui.el("div", { key = "dlg", class = "cd-box cd-dialog" }, {
			ui.node("text", { key = "t", spans = { ui.span(if s.msg == "" then "(no message)" else s.msg, "strong") } }),
		}))
	elseif s.msg ~= "" then
		table.insert(kids, label("ls", "STATUS"))
		table.insert(kids, ui.el("div", { key = "st", class = "cd-box" }, {
			ui.node("text", { key = "t", spans = { ui.span(s.msg, "") } }),
		}))
	elseif s.stale then
		table.insert(kids, ui.node("text", { key = "stale", spans = { ui.span(s.event, "muted") } }))
	end
	table.insert(kids, ui.row({
		ui.button("Go to session", { key = "go", variant = "primary", keys = { "ctrl", "alt", "enter" }, actions = { click = "go=" .. s.key } }),
	}))
	local g = git[s.cwd]
	if (s.bay == "review" or s.bay == "needs") and g then
		table.insert(kids, label("lg", "GIT"))
		if g.err then
			table.insert(kids, ui.node("text", { key = "gerr", spans = { ui.span(g.err, "muted") } }))
		elseif g.status then
			table.insert(kids, ui.code(if #g.status == 0 then "clean" else codeLines(g.status), "text"))
			if g.diff and #g.diff > 0 then table.insert(kids, ui.code(codeLines(g.diff), "text")) end
		else
			table.insert(kids, ui.node("text", { key = "gwait", spans = { ui.span("reading…", "muted") } }))
		end
	end
	local tail = cx.session:read(s.pane, { as = "text", lines = TAIL_LINES })
	table.insert(kids, label("lo", "LAST OUTPUT"))
	table.insert(kids, ui.code(type(tail) == "string" and tail or "(output unavailable)", "text"))
	return ui.el("div", { key = "detail", class = "cd-root" }, kids)
end

-- Caches the view only after a successful set, so a failed update is retried and its error surfaces.
local function set(cx, pane, view)
	local encoded = tern.json.encode(view)
	if lastView[pane] == encoded then return end
	cx.canvas:set(pane, { view = view })
	lastView[pane] = encoded
end

local function find(list, k)
	for _, s in list do
		if s.key == k then return s end
	end
	return nil
end

-- One git job at a time, process-wide: status then diff --stat, each killed after GIT_TIMEOUT_MS. It reads
-- the latest-selected cwd (`gitWant`); results from an older lifecycle or a hidden board are dropped.
local function gitPump(now)
	if gitBusy or not gitWant then return end
	local cwd = gitWant
	local g = git[cwd]
	if g and now - g.at < GIT_MS then return end
	g = g or {}
	git[cwd] = g
	g.at, gitBusy = now, true
	local myGen = gen
	local function drop() gitBusy, g.at = false, -math.huge end
	local function run(args, done)
		local argv = { "git", "--no-optional-locks", "-C", cwd }
		for _, a in args do table.insert(argv, a) end
		if not pcall(tern.process.run, argv, { timeout_ms = GIT_TIMEOUT_MS }, done) then
			gitBusy, g.err = false, "git unavailable"
		end
	end
	run({ "status", "--short" }, function(r1, c1)
		if not live(c1, myGen) then return drop() end
		if r1.status ~= 0 then
			gitBusy, g.err, g.status = false, if r1.timed_out then "git timed out" else "not a git repository", nil
			return
		end
		g.err, g.status = nil, Logic.clip(r1.stdout, 14, 100)
		run({ "diff", "--stat" }, function(r2, c2)
			if not live(c2, myGen) then return drop() end
			gitBusy = false
			g.diff = if r2.status == 0 then Logic.clip(r2.stdout, 10, 100) else {}
		end)
	end)
end

local function render(cx, now)
	local own = canvases(cx)
	if not own[BOARD] then return false end
	local list = collect(cx, now)
	current = list
	local sel = find(list, selected)
	if not sel and #list > 0 then selected, sel = list[1].key, list[1] end
	gitWant = if sel and (sel.bay == "review" or sel.bay == "needs") and sel.cwd ~= "" then sel.cwd else nil
	gitPump(now)
	set(cx, own[BOARD], boardView(list))
	if own[READER] then set(cx, own[READER], readerView(cx, sel)) end
	if own[HOST] then set(cx, own[HOST], hostView(list)) end
	return true
end

-- Render errors are surfaced once per distinct message, not every tick.
local function safeRender(cx, now)
	local ok, err = pcall(render, cx, now)
	if ok then
		lastErr = nil
	elseif tostring(err) ~= lastErr then
		lastErr = tostring(err)
		pcall(function() cx:toast("error", "Conductor", "render failed: " .. lastErr) end)
	end
end

-- ---- loop ----
local tick
local function arm(ms)
	armed += 1
	local mine = armed
	tern.timer(ms, function(cx)
		if mine == armed and cx then tick(cx) end
	end)
end

local function readVoice(now)
	voice = Logic.voiceStep(voiceTrack, readFile(VOICE_FILE, 4096), tern.json.decode, now)
end

local function after(cx)
	if not canvases(cx)[BOARD] then return end -- board gone: stop the timer
	arm(if voice.state == "offline" or voice.state == "idle" then TICK_MS else VOICE_TICK_MS)
end

-- A completion that is no longer valid must not render or start work; it only keeps the slow wake alive.
local function dropped(cx, g)
	if g == gen and cx and canvases(cx)[BOARD] then arm(HIDDEN_MS) end
end

local function inspect(cx, now)
	if inspecting or now - lastInspect < INSPECT_MS then
		safeRender(cx, now)
		return after(cx)
	end
	inspecting, lastInspect = true, now
	local myGen = gen
	local ok = pcall(tern.process.run, { TERN, "inspect", "--json" }, { timeout_ms = 1500 }, function(result, c2)
		inspecting = false
		if not live(c2, myGen) then return dropped(c2, myGen) end
		working = {}
		if result.status == 0 then
			local good, doc = pcall(tern.json.decode, result.stdout)
			if good and type(doc) == "table" and type(doc.panes) == "table" then
				for _, item in doc.panes do
					if item.working == true then working[key(item.pane)] = true end
				end
			end
		end
		safeRender(c2, tern.now())
		after(c2)
	end)
	if not ok then
		inspecting = false
		safeRender(cx, now)
		after(cx)
	end
end

-- Luau has no epoch clock, so status-file age needs one `date +%s` sample (re-taken every CLOCK_MS). Until
-- it lands, no status file is trusted.
local function clock(cx, now)
	clockBusy = true
	local myGen = gen
	local sent = now
	local ok = pcall(tern.process.run, { "/bin/date", "+%s" }, { timeout_ms = 1500 }, function(r, c2)
		clockBusy = false
		if not live(c2, myGen) then return dropped(c2, myGen) end
		local secs = r.status == 0 and tonumber(string.match(r.stdout or "", "%d+")) or nil
		if secs then
			local t = tern.now()
			epochBase, epochAt = secs * 1000 + 500 - (sent + t) / 2, t
		end
		inspect(c2, tern.now())
	end)
	if not ok then
		clockBusy = false
		inspect(cx, now)
	end
end

local function saveBaseline()
	local snap = {}
	for _, s in current do snap[s.key] = s.bay end
	pcall(tern.kv.set, "baseline", snap)
end

tick = function(cx)
	if not canvases(cx)[BOARD] then -- board gone: no timer, drop in-flight work
		gen += 1
		wasShown = false
		return
	end
	if not shown(cx) then
		-- Not on screen: no files, no processes. A focus/tab event or this slow check wakes us.
		if wasShown then
			wasShown = false
			saveBaseline()
		end
		return arm(HIDDEN_MS)
	end
	if not wasShown then
		wasShown = true
		local ok, base = pcall(tern.kv.get, "baseline")
		digestBase = if ok and type(base) == "table" then base else nil
		lastView = {}
	end
	local now = tern.now()
	readVoice(now)
	if clockBusy or inspecting then
		safeRender(cx, now)
		return after(cx)
	end
	if not epochBase or now - epochAt > CLOCK_MS then return clock(cx, now) end
	inspect(cx, now)
end

-- ---- commands / keys ----
local function onBoard(cx)
	local own = canvases(cx)
	local f = cx.session:focused()
	return f ~= nil and (f == own[BOARD] or f == own[READER] or f == own[HOST])
end

local function reselect(cx, k)
	selected = k
	lastView = {}
	safeRender(cx, tern.now())
end

local function go(cx, s)
	if s then cx.layout:focus(s.pane) end
end

local function newPi(cx)
	local s = find(current, selected)
	local launch = { command = "pi" }
	if s and s.cwd ~= "" then launch.cwd = s.cwd end
	cx.layout:new_tab(launch, { focus = true })
end

local function open(cx)
	local own = canvases(cx)
	if own[BOARD] then
		cx.layout:focus(own[BOARD])
		gen += 1
		local okEnsure, eerr = pcall(function()
			cx.canvas:set(own[BOARD], { dock = dockView() })
			if not own[HOST] then -- a board from an older version: add the host panel above its manager
				local tab = cx.session:tab_of(own[BOARD])
				for _, p in cx.session:panes() do
					if p.tab == tab and p.pane ~= own[BOARD] and p.pane ~= own[READER] then
						local _, e = cx.canvas:open({ title = HOST, about = "Voice state and what changed since you last looked.", view = ui.col({}), target = p.pane, dir = "up", ratio = 0.38, focus = false })
						if e then error(e) end
						break
					end
				end
			end
		end)
		if not okEnsure then cx:toast("error", "Conductor", tostring(eerr)) end
		lastView = {}
		return arm(0)
	end
	local tab, manager
	local pinned = readManager()
	if pinned then
		local info = cx.session:pane(pinned)
		if info and not info.exited and (info.kind == "terminal" or info.kind == "agent") and Logic.base(info.program or "") == "pi" then
			tab = cx.layout:move_to_new_tab(pinned, nil, { focus = true })
			if tab then
				manager = pinned
				cx.layout:name_tab(tab, "Conductor")
			end
		end
	end
	if not tab then
		local err
		tab, err = cx.layout:tab({ name = "Conductor", launch = { command = "pi" } })
		if not tab then return cx:toast("error", "Conductor", err or "could not open its tab") end
		for _, p in cx.session:panes() do
			if p.tab == tab then manager = p.pane end
		end
	end
	gen += 1
	local board, err = cx.canvas:open({
		title = BOARD,
		about = "Pi sessions grouped by what they need. Click a strip, or press ctrl+alt+1-8 / j / k, to read it on the right.",
		view = ui.col({}), dock = dockView(),
		target = manager, dir = "right", ratio = 0.78, focus = false,
	})
	if not board then return cx:toast("error", "Conductor board", err) end
	local _, rerr = cx.canvas:open({
		title = READER,
		about = "The selected session's git state and recent output. Go to session focuses its pane.",
		view = ui.col({}),
		target = board, dir = "right", ratio = 0.42, focus = false,
	})
	if rerr then cx:toast("error", "Conductor reader", rerr) end
	local _, herr = cx.canvas:open({
		title = HOST,
		about = "Voice state and what changed since you last looked at the board. The manager pi pane sits below.",
		view = ui.col({}),
		target = manager, dir = "up", ratio = 0.38, focus = false,
	})
	if herr then cx:toast("error", "Conductor host", herr) end
	cx.layout:focus(manager)
	arm(300)
end

tern.command({ id = "open", title = "Open Conductor", icon = "grid", run = open })

-- Keys are chords scoped by `available`: they exist only while the board or reader has focus, so j, k
-- and the digits stay ordinary keystrokes in every terminal (including the manager pane).
local function bind(id, title, keys, run)
	tern.command({ id = id, title = title, group = "Conductor", keys = keys, available = onBoard, run = run })
end
for n = 1, Logic.MAX_KEYS do
	bind("select_" .. n, "Select session " .. n, { "ctrl+alt+" .. n }, function(cx)
		local s = Logic.byNumber(current, n)
		if s then reselect(cx, s.key) end
	end)
end
bind("next", "Select next session", { "ctrl+alt+j" }, function(cx)
	local k = Logic.step(current, selected, 1)
	if k then reselect(cx, k) end
end)
bind("prev", "Select previous session", { "ctrl+alt+k" }, function(cx)
	local k = Logic.step(current, selected, -1)
	if k then reselect(cx, k) end
end)
bind("go", "Go to selected session", { "ctrl+alt+enter", "ctrl+alt+g" }, function(cx) go(cx, find(current, selected)) end)
bind("new", "New pi tab", { "ctrl+alt+n" }, newPi)

tern.on("canvas_action", function(ev, cx)
	local own = canvases(cx)
	if ev.pane ~= own[BOARD] and ev.pane ~= own[READER] then return false end
	if ev.act == "select" and ev.value then
		reselect(cx, ev.value)
		return true
	end
	local s = ev.value and find(current, ev.value)
	if ev.act == "go" then go(cx, s) return true end
	return false
end)

-- A pane focus or tab change wakes the loop (it may have gone to its slow hidden check).
tern.on("focus", function(_, cx) if cx and canvases(cx)[BOARD] then arm(60) end end)
tern.on("window_start", function() arm(300) end)
tern.timer(300, function() arm(0) end)
