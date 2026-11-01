--!nonstrict
-- Pure helpers for the Conductor board. No Tern API calls and no clock: callers pass times in,
-- so these can be read and checked in isolation.
local Logic = {}

Logic.BAYS = {
	{ id = "needs", label = "NEEDS YOU" },
	{ id = "working", label = "WORKING" },
	{ id = "review", label = "REVIEW READY" },
	{ id = "idle", label = "IDLE" },
}
Logic.TAG = { needs = "needs you", working = "working", review = "review", idle = "idle" }
Logic.TONE = { needs = "warning", working = "info", review = "success", idle = "muted" }
Logic.MAX_KEYS = 8

-- Status files are rewritten by the pi extension about every 10 s. Luau cannot kill(0) the file's pid, so
-- a file whose `updated_ms` is older than this on the epoch clock is stale whatever its pid, and is never trusted.
Logic.STATUS_STALE_MS = 30000
Logic.STATUS_MAX_BYTES = 8192

local FILE_STATES = { working = true, blocked = true, idle = true, done = true }

local function str(v, max)
	if type(v) ~= "string" then return "" end
	local s = string.gsub(v, "[%c\n\r]", " ")
	if #s > max then s = string.sub(s, 1, max) end
	return s
end

-- Strict parse of {v:1,pane,state,msg,kind,updated_ms,...}. Returns nil for anything else.
-- `decode` is tern.json.decode (injected).
function Logic.parseStatus(text, decode)
	if type(text) ~= "string" or #text == 0 or #text > Logic.STATUS_MAX_BYTES then return nil end
	local ok, j = pcall(decode, text)
	if not ok or type(j) ~= "table" or j.v ~= 1 then return nil end
	if not FILE_STATES[j.state] or type(j.updated_ms) ~= "number" then return nil end
	local kind = if type(j.kind) == "string" then str(j.kind, 16) else nil
	return {
		pane = tostring(j.pane),
		state = j.state,
		msg = str(j.msg, 160),
		kind = kind,
		turn = if type(j.turn) == "number" then j.turn else nil,
		cwd = if type(j.cwd) == "string" then j.cwd else nil,
		updatedMs = j.updated_ms,
	}
end

-- Which bay a session belongs in. `file` is a fresh parsed status (or nil); `flags` come from tern:
-- `working` (inspect flag) and `alert` (unseen alert on the pane).
function Logic.bay(file, flags)
	if file then
		if file.state == "blocked" then return "needs" end
		if file.state == "working" then return "working" end
		if file.state == "done" then return "review" end
		return "idle"
	end
	if flags.working then return "working" end
	if flags.alert then return "review" end
	return "idle"
end

-- Epoch age of a status file in ms, or nil when the epoch clock is unknown (then nothing is trusted).
function Logic.fileAge(file, epochNow)
	if not file or not epochNow then return nil end
	return epochNow - file.updatedMs
end

-- A file is trusted only with a known epoch age within the window (a future timestamp beyond 5 s is not trusted).
function Logic.fresh(file, epochNow)
	local a = Logic.fileAge(file, epochNow)
	return a ~= nil and a <= Logic.STATUS_STALE_MS and a >= -5000
end

-- Records when `pane` entered `bay` (caller's monotonic clock) and returns that time. Call once per collection.
function Logic.since(seen, pane, bay, now)
	local e = seen[pane]
	if not e or e.bay ~= bay then
		e = { bay = bay, since = now }
		seen[pane] = e
	end
	return e.since
end

-- Counts sessions now blocked / ready that were not in that bay in `base` ({pane = bay}); nil base: no digest.
function Logic.digest(base, list)
	if type(base) ~= "table" then return nil end
	local d = { blocked = 0, ready = 0 }
	for _, s in list do
		if base[s.key] ~= s.bay then
			if s.bay == "needs" then d.blocked += 1 elseif s.bay == "review" then d.ready += 1 end
		end
	end
	return d
end

function Logic.age(ms)
	local s = math.floor(math.max(0, ms) / 1000)
	if s < 60 then return s .. "s" end
	if s < 3600 then return math.floor(s / 60) .. "m" end
	if s < 86400 then return math.floor(s / 3600) .. "h" end
	return math.floor(s / 86400) .. "d"
end

function Logic.base(path)
	return string.match(path or "", "([^/\\]+)/*$") or path or ""
end

-- Orders sessions by bay (BAYS order), then pane id, and numbers the first 8 so on-screen order == key order.
function Logic.order(list)
	local rank = {}
	for i, b in Logic.BAYS do rank[b.id] = i end
	table.sort(list, function(a, b)
		if a.bay ~= b.bay then return rank[a.bay] < rank[b.bay] end
		return a.pane < b.pane
	end)
	for i, s in list do s.n = if i <= Logic.MAX_KEYS then i else nil end
	return list
end

-- Position of `key` in `list`, moved by `delta` and clamped; selects the first when nothing is selected.
function Logic.step(list, key, delta)
	if #list == 0 then return nil end
	local at = 0
	for i, s in list do
		if s.key == key then at = i end
	end
	if at == 0 then return list[1].key end
	return list[math.clamp(at + delta, 1, #list)].key
end

function Logic.byNumber(list, n)
	for _, s in list do
		if s.n == n then return s end
	end
	return nil
end

-- ---- voice (display only) ----
Logic.VOICE_STATES = { idle = true, listening = true, speaking = true, transcribing = true }
Logic.VOICE_ACTIVE_STALE_MS, Logic.VOICE_IDLE_STALE_MS = 3000, 15000
Logic.WAVE_BARS, Logic.LEVEL_STEPS = 24, 8

-- Parses the pi-speak state file {v:1,state,level,updated_ms}. Nothing else is read.
function Logic.parseVoice(text, decode)
	if type(text) ~= "string" or #text == 0 or #text > 4096 then return nil end
	local ok, j = pcall(decode, text)
	if not ok or type(j) ~= "table" or j.v ~= 1 or not Logic.VOICE_STATES[j.state] or type(j.updated_ms) ~= "number" then
		return nil
	end
	local level = if type(j.level) == "number" then math.clamp(j.level, 0, 1) else 0
	return { state = j.state, level = level, updatedMs = j.updated_ms }
end

function Logic.quantize(level)
	return math.floor(math.clamp(level, 0, 1) * Logic.LEVEL_STEPS + 0.5)
end

-- `track` = { last, changedAt, hist }. Returns the effective { state, level }: "offline" when the file is
-- missing, malformed, or its updated_ms has not changed within the staleness window.
function Logic.voiceStep(track, text, decode, now)
	local v = Logic.parseVoice(text, decode)
	track.hist = track.hist or {}
	if not v then
		track.last, track.changedAt = nil, nil
		return { state = "offline", level = 0 }
	end
	if not track.last or track.last.updatedMs ~= v.updatedMs then
		track.changedAt = now
		if v.state ~= "idle" then
			table.insert(track.hist, Logic.quantize(v.level))
			if #track.hist > Logic.WAVE_BARS then table.remove(track.hist, 1) end
		end
	end
	track.last = v
	local limit = if v.state == "idle" then Logic.VOICE_IDLE_STALE_MS else Logic.VOICE_ACTIVE_STALE_MS
	if now - track.changedAt > limit then return { state = "offline", level = 0 } end
	if v.state == "idle" then track.hist = {} end
	return { state = v.state, level = v.level }
end

-- ---- manager pin ----
-- ~/.config/conductor/session.json: {"v":1,"pane":"<TERN_PANE>","updated_ms":...}. The Herdr key
-- `terminal` is accepted when it is all digits. Returns the pane number or nil.
function Logic.parseManager(text, decode)
	if type(text) ~= "string" or #text == 0 or #text > 4096 then return nil end
	local ok, j = pcall(decode, text)
	if not ok or type(j) ~= "table" or j.v ~= 1 then return nil end
	local id = j.pane or j.terminal
	if type(id) == "number" then return id end
	if type(id) == "string" and string.match(id, "^%d+$") then return tonumber(id) end
	return nil
end

-- ---- git ----
-- Keeps the porcelain short listing small enough for a reader.
function Logic.clip(text, maxLines, maxCols)
	local out, n = {}, 0
	for line in string.gmatch(text or "", "[^\n]+") do
		n += 1
		if n <= maxLines then table.insert(out, if #line > maxCols then string.sub(line, 1, maxCols) else line) end
	end
	if n > maxLines then table.insert(out, "… " .. (n - maxLines) .. " more") end
	return out
end

return Logic
