--!strict
-- Glitchless: one session as the Roblox server keeps it, a player's or the server's own (SPEC §2, §5e).
--
-- On Roblox only the server can send, so the server holds every session in the experience: one per player, from
-- PlayerAdded to PlayerRemoving, and its own (role "server", filed under "<service>.server"). A session here is its
-- queue of events and what every event carries: the level, the zone and the groups (match, party, run) at the time
-- the event happened, its properties and its counters. The game's calls from server scripts and what a player's
-- client sends (Inbox.luau checks that first) both land here, so the rules are applied once, in one place:
--   - a level's outcome needs its start: one for a level not started in this session is dropped, and one that comes
--     after the session ended (a level torn down as the player leaves) too, since the session already sent the
--     level_abandon;
--   - what each event carries is looked up by its time (`history`), so a frame window the client measured before a
--     level started carries the level before it, even though it arrives after;
--   - properties go in session_start when set before the first batch, later as one `props` event a window at most;
--   - counters (`count`) add up into one `counts` event a window.
-- Pure Luau: no Roblox APIs, so Lune drives it in roblox/test.

local Json = require(script.Parent.Json)
local Words = require(script.Parent.Words)
local Sketch = require(script.Parent.Sketch)

local Session = {}
Session.__index = Session

local MAX_QUEUE = 2000
local MAX_HISTORY = 32
local MAX_RECENT = 20
local MAX_COUNT_ENTRIES = 64
local MAX_COUNT_ATTRS = 4
local MAX_COUNT_N = 1000000
local MAX_ERRORS_PER_FINGERPRINT = 25
local MAX_DISCONNECTS = 20

export type Config = {
	role: string, -- "player" or "server"
	service: string,
	now: () -> number, -- epoch ms
	sessionId: string,
	sessionType: string,
	hashGroupIds: boolean,
	positions: boolean,
	warn: (key: string, message: string) -> (),
	device: { [string]: any }?,
	server: { [string]: any }?,
	props: { [string]: any }?,
	groups: { [string]: { id: string, attrs: { [string]: any }? } }?,
	level: string?,
	zone: string?,
}

type Ctx = { ts: number, level: string?, zone: string?, match: string?, party: string?, run: string? }

function Session.new(cfg: Config)
	local now = cfg.now()
	local self = setmetatable({
		cfg = cfg,
		role = cfg.role,
		id = cfg.sessionId,
		startedAt = now,
		queue = {} :: { any },
		dropped = 0,
		startSent = false,
		ended = false,
		device = cfg.device or {},
		-- context
		level = cfg.level,
		zone = cfg.zone,
		groups = {} :: { [string]: string },
		history = {} :: { Ctx },
		-- the attempt in play
		levelOpen = false,
		levelStartedAt = now,
		leftLevel = nil :: string?,
		offLevel = nil :: string?,
		-- properties
		props = {} :: { [string]: any },
		propKeys = {} :: { [string]: boolean },
		propKeyCount = 0,
		propsSent = {} :: { [string]: any },
		propsChangedAt = nil :: number?,
		-- counters: the server-side window (a player's client counts its own and sends counts events)
		countWin = nil :: any,
		-- errors and recent game events
		errorCounts = {} :: { [string]: number },
		recent = {} :: { { name: string, ts: number } },
		disconnects = 0,
	}, Session)
	self.countWin = self:newCountWindow(now)
	table.insert(self.history, { ts = now - 1, level = self.level, zone = self.zone })
	if cfg.props then
		self:setProperties(cfg.props, now)
	end
	return self
end

export type Session = typeof(Session.new(...))

-- ───────────────────────────── what every event carries ─────────────────────────────

function Session.ctxAt(self: Session, ts: number): Ctx
	local h = self.history
	for i = #h, 1, -1 do
		if h[i].ts <= ts then
			return h[i]
		end
	end
	return h[1]
end

-- The context changes at `ts`: a new entry with what changed and the rest as it was.
function Session.changeCtx(self: Session, ts: number)
	local entry: Ctx = {
		ts = ts,
		level = self.level,
		zone = self.zone,
		match = self.groups.match,
		party = self.groups.party,
		run = self.groups.run,
	}
	local last = self.history[#self.history]
	if last and last.ts == ts then
		self.history[#self.history] = entry
	else
		table.insert(self.history, entry)
	end
	if #self.history > MAX_HISTORY then
		table.remove(self.history, 1)
	end
end

local function stamp(e: any, ctx: Ctx)
	if e.level == nil then
		e.level = ctx.level
	end
	if e.zone == nil then
		e.zone = ctx.zone
	end
	for _, kind in { "match", "party", "run" } do
		if e[kind] == nil then
			e[kind] = (ctx :: any)[kind]
		end
	end
end

-- Queues an event, with what it carries at its time. Events after the session ended are dropped.
function Session.push(self: Session, e: any)
	if self.ended then
		return
	end
	e.ts = e.ts or self.cfg.now()
	stamp(e, self:ctxAt(e.ts))
	if #self.queue >= MAX_QUEUE then
		self.dropped += 1
		if self.dropped == 1 then
			self.cfg.warn("queue", "a session's queue is full (" .. MAX_QUEUE .. " events): events are dropped until it is sent")
		end
		return
	end
	table.insert(self.queue, e)
end

function Session.remember(self: Session, name: string, ts: number)
	table.insert(self.recent, { name = name, ts = ts })
	if #self.recent > MAX_RECENT then
		table.remove(self.recent, 1)
	end
end

-- The names of the game events in the `ms` before `ts`, oldest first, each once: what a hitch or error came after.
function Session.recentBefore(self: Session, ts: number, ms: number, max: number?): { string }
	local out = Json.array({})
	local seen = {}
	for _, r in self.recent do
		if r.ts <= ts and r.ts >= ts - ms and not seen[r.name] then
			seen[r.name] = true
			table.insert(out, r.name)
		end
	end
	if max and #out > max then
		out = Json.array(table.move(out, #out - max + 1, #out, 1, {}))
	end
	return out
end

local function round(v: number, digits: number): number
	return Sketch.round(v, digits)
end

-- ───────────────────────────── levels and deaths ─────────────────────────────

function Session.levelStart(self: Session, level: string, attrs: any, ts: number?)
	local t = ts or self.cfg.now()
	self:closeWindow(t) -- counters never span two levels
	self.level = level
	self.levelOpen = true
	self.levelStartedAt = t
	self.leftLevel = nil
	self.offLevel = nil
	self:changeCtx(t)
	self:push({ type = "level_start", ts = t, level = level, attrs = Words.attrs(attrs) })
	self:remember("level_start", t)
end

-- The attempt that was going when the player turned Glitchless off has no start in this session (SPEC §4d), and
-- one that ended with the session already has its outcome.
function Session.outcomeDropped(self: Session, level: string?): boolean
	if level ~= nil and level == self.offLevel then
		return true
	end
	return self.ended and level ~= nil and level == self.leftLevel
end

function Session.levelComplete(self: Session, level: string?, info: any, ts: number?)
	local t = ts or self.cfg.now()
	local lvl = level or self.level
	if self:outcomeDropped(lvl) then
		return
	end
	info = if type(info) == "table" then info else {}
	local duration = tonumber(info.durationS or info.duration_s)
	if lvl == self.level and duration == nil then
		duration = (t - self.levelStartedAt) / 1000
	end
	local score = tonumber(info.score)
	self.levelOpen = false
	self:push({
		type = "level_complete",
		ts = t,
		level = lvl,
		duration_s = if duration then round(duration, 2) else nil,
		score = if score and score == score and math.abs(score) ~= math.huge then score else nil,
	})
	self:remember("level_complete", t)
end

function Session.levelFail(self: Session, level: string?, info: any, ts: number?)
	local t = ts or self.cfg.now()
	local lvl = level or self.level
	if self:outcomeDropped(lvl) then
		return
	end
	info = if type(info) == "table" then info else {}
	local cause = Words.name(info.cause)
	if cause == "abandon" then
		-- the cause "abandon" is reserved: such a fail is a level_abandon (SPEC §2)
		self:levelAbandon(lvl, nil, t)
		return
	end
	self.levelOpen = false
	self:push({ type = "level_fail", ts = t, level = lvl, cause = cause })
	self:remember("level_fail", t)
end

function Session.levelAbandon(self: Session, level: string?, reason: string?, ts: number?)
	local t = ts or self.cfg.now()
	local lvl = level or self.level
	if reason == nil and self:outcomeDropped(lvl) then
		return
	end
	self.levelOpen = false
	self:push({
		type = "level_abandon",
		ts = t,
		level = lvl,
		duration_s = if lvl == self.level then round((t - self.levelStartedAt) / 1000, 2) else nil,
		reason = reason,
	})
	self:remember("level_abandon", t)
end

-- A death. Its place goes only when positions are on (`positions`); the cause always does.
function Session.death(self: Session, info: any, ts: number?)
	local t = ts or self.cfg.now()
	info = if type(info) == "table" then info else {}
	local cause = Words.name(info.cause)
	local e: { [string]: any } = { type = "death", ts = t, cause = cause }
	if self.cfg.positions then
		for _, k in { "x", "y", "z" } do
			local v = tonumber(info[k])
			if v and v == v and math.abs(v) < 1e7 then
				e[k] = round(v, 2)
			end
		end
	end
	self:push(e)
	self:remember("death:" .. (cause or ""), t)
end

-- ───────────────────────────── the game's own events ─────────────────────────────

function Session.track(self: Session, name: any, attrs: any, ts: number?)
	local n = Words.name(name)
	if not n then
		self.cfg.warn("track-name", "track() needs a name (a string of up to 64 characters)")
		return
	end
	local t = ts or self.cfg.now()
	self:push({ type = "custom", ts = t, name = n, attrs = Words.attrs(attrs) or {} })
	self:remember(n, t)
end

function Session.newCountWindow(self: Session, ts: number)
	return { startedAt = ts, entries = {}, list = {}, names = {}, dropped = 0 }
end

-- One more of a stream of events in this window (SPEC §1 count): the call's words and flags (the first 4 by key) say
-- which entry it adds to, its numbers (the first 4) are added up, `n` adds to the count.
function Session.count(self: Session, name: any, what: any, n: any, ts: number?)
	local nm = Words.name(name)
	if not nm then
		return
	end
	local k = tonumber(n) or 1
	k = math.min(math.floor(k), MAX_COUNT_N)
	if k < 1 then
		return
	end
	local attrs: { [string]: any } = {}
	if type(what) == "table" then
		attrs = what
	elseif what ~= nil then
		attrs = { what = what }
	end
	local keys = {}
	for key in attrs do
		if type(key) == "string" then
			table.insert(keys, key)
		end
	end
	table.sort(keys)
	local group, sums = {}, {}
	local grouped, summed = 0, 0
	local id = nm
	for _, key in keys do
		local v = attrs[key]
		local tv = typeof(v)
		if tv == "EnumItem" then
			v = v.Name
			tv = "string"
		end
		if tv == "boolean" or tv == "string" then
			if grouped < MAX_COUNT_ATTRS then
				local word = if tv == "string" then Words.cut(v, 64) else v
				group[Words.cut(key, 64)] = word
				id ..= "\n" .. key .. "=" .. (if tv == "string" then "s" .. word else (if v then "b1" else "b0"))
				grouped += 1
			end
		elseif tv == "number" and v == v and math.abs(v) ~= math.huge then
			if summed < MAX_COUNT_ATTRS then
				sums[Words.cut(key, 64)] = v
				summed += 1
			end
		end
	end
	local t = ts or self.cfg.now()
	local w = self.countWin
	local entry = w.entries[id]
	if not entry then
		if #w.list < MAX_COUNT_ENTRIES then
			entry = { name = nm, attrs = group, n = 0, sums = {}, first_ts = t }
			w.entries[id] = entry
			w.names[nm] = true
			table.insert(w.list, entry)
		elseif not w.names[nm] then
			w.dropped += k -- a new name in a full window
			return
		else
			-- a new group of a name already counted: its words become "(other)"
			local other = nm .. "\n(other)"
			entry = w.entries[other]
			if not entry then
				local blank = {}
				for gk in group do
					blank[gk] = "(other)"
				end
				entry = { name = nm, attrs = blank, n = 0, sums = {}, first_ts = t }
				w.entries[other] = entry
				table.insert(w.list, entry)
			end
		end
	end
	entry.n += k
	local sumCount = 0
	for _ in entry.sums do
		sumCount += 1
	end
	for sk, sv in sums do
		if entry.sums[sk] ~= nil then
			entry.sums[sk] += sv
		elseif sumCount < MAX_COUNT_ATTRS then
			entry.sums[sk] = sv
			sumCount += 1
		end
	end
end

-- ───────────────────────────── properties ─────────────────────────────

-- Sets properties (nil or Json.null removes one: pass `remove` for keys to remove). What breaks the rules is
-- dropped with one warning per key.
function Session.setProperties(self: Session, props: any, ts: number?, remove: { string }?)
	if type(props) ~= "table" then
		props = {}
	end
	local t = ts or self.cfg.now()
	local changed = false
	local function apply(key: string, value: any)
		local problem = Words.propKeyProblem(key)
		if problem then
			self.cfg.warn("prop:" .. tostring(key), "property " .. tostring(key) .. " is dropped: " .. problem)
			return
		end
		if not self.propKeys[key] then
			if self.propKeyCount >= Words.MAX_PROPS then
				self.cfg.warn("prop-count", "a session has at most " .. Words.MAX_PROPS .. " properties: " .. key .. " is dropped")
				return
			end
			self.propKeys[key] = true
			self.propKeyCount += 1
		end
		if value == nil or value == Json.null then
			if self.props[key] ~= nil then
				self.props[key] = nil
				changed = true
			end
			return
		end
		local v = Words.propValue(value)
		if v == nil then
			self.cfg.warn("prop-value:" .. key, "property " .. key .. " is dropped: its value is not a word, a flag or a whole number, or it looks like it says who the player is")
			return
		end
		if self.props[key] ~= v then
			self.props[key] = v
			changed = true
		end
	end
	local keys = {}
	for k in props do
		table.insert(keys, k)
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for _, k in keys do
		apply(k, props[k])
	end
	for _, k in remove or {} do
		apply(k, nil)
	end
	if changed then
		self.propsChangedAt = t
	end
end

-- The properties changed since the server last heard: a props event, or nil.
function Session.propsEvent(self: Session): any
	if not self.startSent or self.propsChangedAt == nil then
		return nil
	end
	local diff = {}
	local any = false
	for k, v in self.props do
		if self.propsSent[k] ~= v then
			diff[k] = v
			any = true
		end
	end
	for k in self.propsSent do
		if self.props[k] == nil then
			diff[k] = Json.null
			any = true
		end
	end
	local ts = self.propsChangedAt
	self.propsChangedAt = nil
	if not any then
		return nil -- set and changed back within the window
	end
	self.propsSent = table.clone(self.props)
	return { type = "props", ts = ts, props = diff }
end

-- ───────────────────────────── groups and zones ─────────────────────────────

-- Sets a group (`id` nil ends it). Returns the ID sent, or nil. A run with no ID gets a new one (`newRunId`).
function Session.setGroup(self: Session, kind: string, id: any, attrs: any, ts: number?, newRunId: (() -> string)?, resumed: boolean?): string?
	if not Words.GROUP_KINDS[kind] then
		self.cfg.warn("group-kind", "setGroup's kind is match, party or run, not " .. tostring(kind))
		return nil
	end
	local t = ts or self.cfg.now()
	local sent: string?
	if id == nil then
		if self.groups[kind] == nil then
			return nil
		end
		sent = nil
	elseif kind == "run" and id == true and newRunId then
		sent = newRunId()
	else
		if not Words.validGroupId(id) then
			self.cfg.warn("group-id", "a group ID is 8 to 64 of A-Z a-z 0-9 _ . : - (" .. tostring(id) .. " is dropped)")
			return nil
		end
		sent = if kind ~= "run" and self.cfg.hashGroupIds then Words.hashGroupId(self.cfg.service, id) else id
	end
	local a = Words.attrs(attrs)
	if sent ~= nil and self.groups[kind] == sent and a == nil then
		return sent -- the same group again, nothing new to say
	end
	self:closeWindow(t) -- a window never spans two matches
	self.groups[kind] = sent
	self:changeCtx(t)
	local e: { [string]: any } = { type = "group", ts = t, kind = kind, id = if sent == nil then Json.null else sent, attrs = a }
	if resumed then
		e.resumed = true
	end
	-- The event itself carries the group it sets (not the one it ends).
	self:push(e)
	return sent
end

function Session.setZone(self: Session, zone: any, ts: number?)
	local z: string? = nil
	if type(zone) == "string" then
		local s = Words.cut(Words.trim(zone), 64)
		z = if s ~= "" then s else nil
	end
	if z == self.zone then
		return
	end
	local t = ts or self.cfg.now()
	self:closeWindow(t)
	self.zone = z
	self:changeCtx(t)
end

-- ───────────────────────────── errors and the network ─────────────────────────────

-- An error event already read (Errors.read) and scrubbed. 25 a session per fingerprint.
function Session.error(self: Session, e: any)
	local n = (self.errorCounts[e.fingerprint] or 0) + 1
	self.errorCounts[e.fingerprint] = n
	if n > MAX_ERRORS_PER_FINGERPRINT then
		return
	end
	e.type = "error"
	e.ts = e.ts or self.cfg.now()
	e.recent = self:recentBefore(e.ts, 60000, 6)
	self:push(e)
	self:remember("error:" .. Words.cut(e.message or "", 40), e.ts)
end

function Session.disconnect(self: Session, reason: string, ts: number?)
	if self.disconnects >= MAX_DISCONNECTS then
		return
	end
	self.disconnects += 1
	self:push({ type = "disconnect", ts = ts or self.cfg.now(), reason = reason })
end

-- ───────────────────────────── windows, batches and the end ─────────────────────────────

-- Closes the server-side window: its counters as one counts event and the properties that changed as one props event.
-- `countsOk` false drops counters (a server whose /v1/health doesn't list "counts"); nil keeps them until it answers.
function Session.closeWindow(self: Session, ts: number?, countsOk: boolean?)
	local t = ts or self.cfg.now()
	local w = self.countWin
	if #w.list > 0 or w.dropped > 0 then
		self.countWin = self:newCountWindow(t)
		if countsOk ~= false then
			local list = Json.array({})
			for _, c in w.list do
				local entry: { [string]: any } = { name = c.name, attrs = c.attrs, n = c.n, first_ts = c.first_ts }
				if next(c.sums) then
					entry.sums = c.sums
				end
				table.insert(list, entry)
			end
			self:push({
				type = "counts",
				ts = w.startedAt,
				duration_s = round(math.max(t - w.startedAt, 1) / 1000, 2),
				dropped = w.dropped,
				counts = list,
			})
		end
	else
		w.startedAt = t
	end
	local props = self:propsEvent()
	if props then
		self:push(props)
	end
end

function Session.startEvent(self: Session): any
	local e: { [string]: any } = {
		type = "session_start",
		ts = self.startedAt,
		session_type = self.cfg.sessionType,
		privacy = "anonymous",
		device = self.device,
	}
	if self.role == "server" then
		e.server = self.cfg.server
	end
	if next(self.props) then
		e.props = table.clone(self.props)
	end
	self.propsSent = table.clone(self.props)
	self.propsChangedAt = nil
	return e -- no level, zone or group: session_start carries none (SPEC §5 groups)
end

-- The events to send now, oldest first, with session_start first in the session's first batch. Nil when there are
-- none.
function Session.take(self: Session): { any }?
	if #self.queue == 0 and self.startSent then
		return nil
	end
	local events = self.queue
	self.queue = {}
	if not self.startSent then
		self.startSent = true
		table.insert(events, 1, self:startEvent())
		-- Properties set before the first batch went in session_start: a props event for them says nothing new.
		local kept = {}
		for _, e in events do
			if e.type ~= "props" then
				table.insert(kept, e)
			end
		end
		events = kept
	end
	table.sort(events, function(a, b)
		if a.type == "session_start" then
			return b.type ~= "session_start"
		elseif b.type == "session_start" then
			return false
		end
		return a.ts < b.ts
	end)
	return events
end

-- The session ends: a level still open is abandoned (`reason`: quit, close, kicked…), then session_end.
function Session.finish(self: Session, reason: string, ts: number?)
	if self.ended then
		return
	end
	local t = ts or self.cfg.now()
	-- A player who leaves mid-level abandoned it; a server's map is never abandoned (it closes with the server).
	if self.levelOpen and self.level ~= nil and self.role ~= "server" then
		self.leftLevel = self.level
		self:levelAbandon(self.level, if reason == "close" then "close" else "quit", t)
	end
	self:closeWindow(t)
	self:push({ type = "session_end", ts = t, reason = reason, duration_s = round((t - self.startedAt) / 1000, 1) })
	self.ended = true
end

-- Turned off by the player (SPEC §4d): no session_end, no abandon, everything waiting dropped.
function Session.drop(self: Session)
	self.queue = {}
	self.countWin = self:newCountWindow(self.cfg.now())
	if self.levelOpen then
		self.offLevel = self.level
	end
	self.levelOpen = false
	self.ended = true
end

return Session
