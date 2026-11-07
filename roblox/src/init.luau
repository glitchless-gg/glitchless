--!strict
-- Glitchless for Roblox: game observability for coding agents (https://glitchless.gg).
--
-- Put this module in ReplicatedStorage (by Rojo, Wally or the Creator Store model) and start it from one server Script:
--
--   local Glitchless = require(game:GetService("ReplicatedStorage").Glitchless)
--   Glitchless.init({ service = "my-game", clientToken = "gl_pub_…" })
--
-- That measures every player's frames, hitches, errors and connection (the GlitchlessClient LocalScript it ships is
-- put in StarterPlayerScripts), the server's own frames, players and errors, and sends it all from the server, the
-- only place Roblox lets a script make HTTP requests (turn on Allow HTTP Requests in Game Settings → Security).
-- What the game says goes through the same module, from a server Script with the player first, or from a LocalScript
-- for the player whose device it runs on:
--
--   Glitchless.levelStart(player, "desert_loop", { mode = "ranked" })   -- server
--   Glitchless.track(player, "boost_used", { kind = "nitro" })
--   Glitchless.server.track("race_started", { racers = 8 })            -- the server's own session
--   Glitchless.track("settings_opened")                                -- LocalScript
--
-- A call made before Glitchless has started (a LocalScript that runs before GlitchlessClient, a server Script that runs
-- before the one that calls init, a PlayerAdded handler that runs before Glitchless's) waits for it, and is made when
-- it starts: a client's at the time it was made.
--
-- See README.md for every call, SPEC §5e for what goes on the wire, and PRIVACY.md for what is sent about players
-- (no user ID, name or display name, ever).

local RunService = game:GetService("RunService")

local Glitchless = {}

Glitchless.VERSION = "0.2.0"
Glitchless.SDK = "glitchless-roblox/0.2.0"

local Json = require(script.Json)

local server: any = nil
local client: any = nil

-- ───────────────────────────── calls made before Glitchless starts ─────────────────────────────
--
-- On a client, the GlitchlessClient LocalScript starts Glitchless, and the game's own LocalScripts may run before it;
-- on the server, a Script that calls Glitchless may run before the one that calls init, and a game's PlayerAdded
-- handler before Glitchless's. Such calls are held here and made when Glitchless starts (or, for a player Glitchless
-- hadn't seen join yet, when it does). Held calls are bounded (128: past that they are dropped, with one warning in
-- Studio), and only the latest zone, properties (merged by key), gauges and on/off choice of each session are kept.
-- A client's are made at the time they were made; a server's at the time Glitchless starts, since every session
-- starts then (and only scripts racing init at boot make them).
--
-- Glitchless starts the client from its own GlitchlessClient script, never from the first call a game makes: on
-- Roblox the connections and threads a call starts belong to the script that made it, and a LocalScript that is
-- destroyed (one in StarterCharacterScripts, at every respawn) would take Glitchless's frame measuring with it.

local MAX_HELD = 128
local SERVER = table.freeze({}) -- the target of a call for the server's own session
type Held = { kind: string?, target: any, ts: number, data: any, run: (Held) -> () }
local held: { Held } = {}
local heldDropped = 0
local heldWarned = false

local function nowMs(): number
	local ok, t = pcall(function()
		return workspace:GetServerTimeNow()
	end)
	return math.floor((if ok then t else os.time()) * 1000)
end

local function heldOf(kind: string, target: any): (Held?, number?)
	for i, h in held do
		if h.kind == kind and h.target == target then
			return h, i
		end
	end
	return nil, nil
end

local function hold(h: Held)
	if h.kind then
		local _, i = heldOf(h.kind, h.target)
		if i then
			table.remove(held, i) -- the latest goes last, in its place in time
		end
	end
	if #held >= MAX_HELD then
		heldDropped += 1
		if heldDropped == 1 and RunService:IsStudio() then
			warn("[glitchless] more than " .. MAX_HELD .. " calls were made before Glitchless started: the rest are dropped")
		end
		return
	end
	table.insert(held, h)
	if not heldWarned and RunService:IsStudio() then
		heldWarned = true
		task.delay(30, function()
			if not server and not client and #held > 0 then
				warn("[glitchless] " .. #held .. " calls are waiting for Glitchless to start: call Glitchless.init({ service = ..., clientToken = ... }) from a server Script")
			end
		end)
	end
end

-- Makes the held calls for `target` (a player Glitchless has just seen join), or all of them (nil: it just started).
local function release(target: any?)
	if #held == 0 then
		return
	end
	local now, keep = {}, {}
	for _, h in held do
		table.insert(if target == nil or h.target == target then now else keep, h)
	end
	held = keep
	for _, h in now do
		if client then
			client.at = h.ts
		end
		local ok, err = pcall(h.run, h)
		if client then
			client.at = nil
		end
		if not ok and RunService:IsStudio() then
			warn("[glitchless] a call made before Glitchless started failed: " .. tostring(err))
		end
	end
end

-- Drops the held calls of a player who left before Glitchless saw them join.
local function forget(target: any)
	local keep = {}
	for _, h in held do
		if h.target ~= target then
			table.insert(keep, h)
		end
	end
	held = keep
end

-- Holds a call made with `args` (the player first on the server) to be made again by `again`. `kind` keeps only the
-- latest of its kind for the session ("zone", "enabled", "group:<kind>"); "props" and "ctx" merge into the one held.
local function holdCall(target: any, kind: string?, again: (...any) -> ...any, args: any)
	hold({
		kind = kind,
		target = target,
		ts = nowMs(),
		data = nil,
		run = function()
			again(table.unpack(args, 1, args.n))
		end,
	})
end

local function holdMerged(target: any, kind: string, values: any, again: (any) -> ())
	local h = heldOf(kind, target)
	local merged = if h then h.data else {}
	if type(values) == "table" then
		for k, v in values do
			merged[k] = v
		end
	end
	hold({ kind = kind, target = target, ts = nowMs(), data = merged, run = function(self)
		again(self.data)
	end })
end

-- Whether a call made now is to be held, and for which session: on the server before init (the player first, or
-- SERVER), and for a player Glitchless hasn't seen join yet; on a client before it starts (target nil).
local function holding(player: any): (boolean, any)
	if server then
		return server:awaiting(player), player
	elseif client then
		return false, nil
	end
	return true, if RunService:IsServer() then player else nil
end

-- Starts Glitchless. On the server, `options` needs `service` (the game's name in Glitchless) and `clientToken`; see
-- README.md for the rest. On a client (a LocalScript) it takes none, and the shipped GlitchlessClient script calls it
-- for you. A second call does nothing. Calls made before it are made now.
function Glitchless.init(options: any?)
	if RunService:IsServer() then
		if not server then
			server = require(script.Server).start(script, options :: any)
			server.onPlayer = release
			server.onPlayerGone = forget
			release(nil)
		end
	elseif not client then
		client = require(script.Client).start(script, options)
		release(nil)
	end
	return Glitchless
end

-- A call for a player's session: on the server the player comes first; on a client there's no player argument.
-- `kind`: only the latest call of this kind waits for Glitchless to start (see holdCall).
local function call(name: string, fn: (any, any, ...any) -> ...any, kind: string?): (...any) -> ...any
	local f
	f = function(...)
		if server then
			local args = table.pack(...)
			local s = server:sessionOf(args[1])
			if not s then
				if server:awaiting(args[1]) then
					holdCall(args[1], kind, f, args)
				end
				return nil
			end
			return fn(server, s, table.unpack(args, 2, args.n))
		elseif client then
			return fn(client, nil, ...)
		end
		holdCall(if RunService:IsServer() then (...) else nil, kind, f, table.pack(...))
		return nil
	end
	return f
end

-- ───────────────────────────── levels, deaths and events ─────────────────────────────

-- A level, stage, race or round begins: every event after it carries it. `attrs` say what the attempt is.
Glitchless.levelStart = call("levelStart", function(impl, s, level, attrs)
	if s then
		local l = (require(script.Words) :: any).name(level)
		if l then
			s:levelStart(l, attrs)
			impl:changed(s.player)
		end
	else
		impl:levelStart(level, attrs)
	end
end)

-- The level was beaten: { durationS = seconds, score = n } (both optional).
Glitchless.levelComplete = call("levelComplete", function(impl, s, level, info)
	if s then
		s:levelComplete(level, info)
	else
		impl:levelComplete(level, info)
	end
end)

-- The player lost the level: { cause = "fell" }.
Glitchless.levelFail = call("levelFail", function(impl, s, level, info)
	if s then
		s:levelFail(level, info)
	else
		impl:levelFail(level, info)
	end
end)

-- The player left the level before it ended (back to the lobby, a restart). Never a fail.
Glitchless.levelAbandon = call("levelAbandon", function(impl, s, level)
	if s then
		s:levelAbandon(level)
	else
		impl:levelAbandon(level)
	end
end)

-- The player died: { cause = "lava" }. On the server, deaths of the character's Humanoid are sent by themselves
-- (`deaths = false` turns that off); the first call to death from a server script turns them off, as the game then
-- reports its own, with their causes.
Glitchless.death = call("death", function(impl, s, info)
	if s then
		impl.gameDeaths = true
		impl:death(impl.entries[s.player], if type(info) == "table" then info else {})
	else
		impl:death(info)
	end
end)

-- Any event of the game's own: Glitchless.track(player, "boost_used", { kind = "nitro", lap = 2 }).
Glitchless.track = call("track", function(impl, s, name, attrs)
	if s then
		s:track(name, attrs)
	else
		impl:track(name, attrs)
	end
end)

-- A stream of events (coins, hits, kills), added up and sent once a window: Glitchless.count(player, "coin", { source = "track" }, 5).
Glitchless.count = call("count", function(impl, s, name, what, n)
	if s then
		s:count(name, what, n)
	else
		impl:count(name, what, n)
	end
end)

-- What holds for the session in the game's words (a mode, a car class, a rank tier): { car_class = "s" }.
-- Glitchless.clearProperty removes one.
local setProperties = call("setProperties", function(impl, s, props)
	if s then
		s:setProperties(props)
	else
		impl:setProperties(props)
	end
end)

local clearProperty = call("clearProperty", function(impl, s, key)
	if s then
		s:setProperties({}, nil, { key })
	else
		impl:clearProperty(key)
	end
end)

-- Before Glitchless starts, properties wait merged: each key's latest value, Json.null for one cleared.
local function heldProps(target: any, values: any)
	holdMerged(target, "props", values, function(merged)
		if target == nil then
			setProperties(merged)
		else
			setProperties(target, merged)
		end
	end)
end

function Glitchless.setProperties(...)
	local args = table.pack(...)
	local wait, target = holding(args[1])
	if wait then
		heldProps(target, if target == nil then args[1] else args[2])
		return
	end
	setProperties(...)
end

function Glitchless.clearProperty(...)
	local args = table.pack(...)
	local wait, target = holding(args[1])
	if wait then
		local key = if target == nil then args[1] else args[2]
		if type(key) == "string" then
			heldProps(target, { [key] = Json.null })
		end
		return
	end
	clearProperty(...)
end

-- Where the player is in an open world (a region, a room); nil clears it.
Glitchless.setZone = call("setZone", function(impl, s, zone)
	if s then
		s:setZone(zone)
		impl:changed(s.player)
	else
		impl:setZone(zone)
	end
end, "zone")

-- An error the game caught itself, with attributes.
local reportError = call("error", function(impl, s, err, attrs, stack)
	if s then
		impl:reportError(s, "manual", tostring(err), stack, attrs, nil)
	else
		impl:error(err, attrs, stack)
	end
end)

-- The stack is read where the game called, so an error that waited for Glitchless to start keeps its own.
function Glitchless.error(...)
	local args = table.pack(...)
	local stack = debug.traceback("", 2)
	if RunService:IsServer() then
		reportError(args[1], args[2], args[3], stack)
	else
		reportError(args[1], args[2], stack)
	end
end

-- ───────────────────────────── groups (server) ─────────────────────────────

-- The match, party or run the player's next events belong to. Match and party IDs come from the game's server and
-- are sent hashed; Glitchless.setGroup(player, "run") makes a run ID and returns it. Until the game sets a match of
-- its own, a server's players and the server share one: the server itself (serverAsMatch).
function Glitchless.setGroup(player: Player, kind: string, id: string?, attrs: { [string]: any }?): string?
	if not RunService:IsServer() then
		warn("[glitchless] setGroup is the server's call: a match is set where it is made")
		return nil
	end
	local wait, target = holding(player)
	if wait then
		-- made when Glitchless starts; a run's ID is made then too, so none is returned now
		holdCall(target, "group:" .. tostring(kind), Glitchless.setGroup, table.pack(player, kind, id, attrs))
		return nil
	end
	local s = server:sessionOf(player)
	if not s then
		return nil
	end
	local sent
	if id == nil and kind ~= "run" then
		server:endGroup(s, kind)
	else
		sent = server:setGroup(s, kind, id, attrs)
	end
	server:changed(player)
	return sent
end

-- Ends a group: the match, party or run is over for this player.
function Glitchless.endGroup(player: Player, kind: string)
	if not RunService:IsServer() then
		return
	end
	local wait, target = holding(player)
	if wait then
		holdCall(target, "group:" .. tostring(kind), Glitchless.endGroup, table.pack(player, kind))
		return
	end
	local s = server:sessionOf(player)
	if s then
		server:endGroup(s, kind)
		server:changed(player)
	end
end

-- ───────────────────────────── the client's gauges ─────────────────────────────

-- Numbers to watch on the player's device (enemies alive, particles), attached to each frame window and hitch, where a
-- number that only climbs reads as a leak. A LocalScript's call.
function Glitchless.setContext(gauges: { [string]: number })
	if not server and not client then
		holdMerged(if RunService:IsServer() then SERVER else nil, "ctx", gauges, Glitchless.setContext)
		return
	end
	if client then
		client:setContext(gauges)
	elseif server then
		-- on the server: gauges of the server's own windows
		for k, v in gauges do
			if type(k) == "string" and type(v) == "number" then
				server.ticks:gauge(k, v)
			end
		end
	end
end

-- ───────────────────────────── the player's off switch ─────────────────────────────

-- The player's "share performance data" setting (SPEC §4d): false stops measuring and sending for them at once and
-- drops what was waiting; true starts a new session. The choice is kept in the game's DataStore (key "u<UserId>"
-- in the "Glitchless" store) and read when they next join. From a LocalScript: Glitchless.setEnabled(on); from the
-- server: Glitchless.setEnabled(player, on).
function Glitchless.setEnabled(a: any, b: any?)
	local wait, target = holding(a)
	if wait then
		local on = if RunService:IsServer() then b == true else a == true
		hold({ kind = "enabled", target = target, ts = nowMs(), data = on, run = function()
			if target == nil then
				Glitchless.setEnabled(on)
			else
				Glitchless.setEnabled(target, on)
			end
		end })
		return
	end
	if server then
		local entry = server:entryOf(a)
		if entry then
			if b then
				server:turnOn(entry)
			else
				server:turnOff(entry, true)
			end
		end
	elseif client then
		client:setEnabled(a == true)
	end
end

-- Whether Glitchless is on for the player. Before it has started (or seen the player join), whether a call made now
-- will be kept for it: true, unless setEnabled(false) was called meanwhile.
function Glitchless.isEnabled(player: Player?): boolean
	local wait, target = holding(player)
	if wait then
		if RunService:IsServer() and not (typeof(player) == "Instance" and (player :: any):IsA("Player")) then
			return false
		end
		local h = heldOf("enabled", target)
		return if h then h.data == true else true
	end
	if server then
		local entry = server:entryOf(player)
		return entry ~= nil and entry.on and entry.session ~= nil
	elseif client then
		return client:isEnabled()
	end
	return false
end

-- ───────────────────────────── the server's own session ─────────────────────────────

-- The server's own events: its level (the map it runs), its match, its errors, the game's events about the server.
Glitchless.server = {}

local function serverCall(name: string, fn: (any, any, ...any) -> ...any, kind: string?): (...any) -> ...any
	local f
	f = function(...)
		if not server then
			if not RunService:IsServer() then
				warn("[glitchless] Glitchless.server." .. name .. " is for server scripts")
			elseif kind == "props" then
				holdMerged(SERVER, "props", (...), function(merged)
					f(merged)
				end)
			else
				holdCall(SERVER, kind, f, table.pack(...))
			end
			return nil
		end
		return fn(server, server.serverSession, ...)
	end
	return f
end

Glitchless.server.levelStart = serverCall("levelStart", function(_, s, level, attrs)
	local l = (require(script.Words) :: any).name(level)
	if l then
		s:levelStart(l, attrs)
	end
end)
Glitchless.server.levelComplete = serverCall("levelComplete", function(_, s, level, info)
	s:levelComplete(level, info)
end)
Glitchless.server.levelFail = serverCall("levelFail", function(_, s, level, info)
	s:levelFail(level, info)
end)
Glitchless.server.track = serverCall("track", function(_, s, name, attrs)
	s:track(name, attrs)
end)
Glitchless.server.count = serverCall("count", function(_, s, name, what, n)
	s:count(name, what, n)
end)
Glitchless.server.setProperties = serverCall("setProperties", function(_, s, props)
	s:setProperties(props)
end, "props")
Glitchless.server.setZone = serverCall("setZone", function(_, s, zone)
	s:setZone(zone)
end, "zone")
Glitchless.server.setGroup = serverCall("setGroup", function(impl, s, kind, id, attrs)
	if id == nil and kind ~= "run" then
		impl:endGroup(s, kind)
		return nil
	end
	return impl:setGroup(s, kind, id, attrs)
end)
Glitchless.server.endGroup = serverCall("endGroup", function(impl, s, kind)
	impl:endGroup(s, kind)
end)
local serverError = serverCall("error", function(impl, s, err, attrs, stack)
	impl:reportError(s, "manual", tostring(err), stack, attrs, nil)
end)

function Glitchless.server.error(err: any, attrs: any?)
	serverError(err, attrs, debug.traceback("", 2))
end

-- ───────────────────────────── the map ─────────────────────────────

-- A top-down picture of the place for heatmaps (SPEC §5e `map`), drawn by the server: one ray straight down per
-- pixel, coloured by what it hits, with dark lines where the height jumps. From a server Script, after the place is
-- built:
--   task.spawn(Glitchless.captureMap, { zone = "hall", area = workspace.Zones.Hall })
--   task.spawn(Glitchless.captureMap)                  -- the whole place
-- Options: `level` or `zone` (the map is that level's or zone's; neither: the whole place), `area` (a part, model or
-- folder whose parts bound it: a zone's volume), `bounds` ({ min = { x, z }, max = { x, z } } in studs, instead of
-- an area), `top` (rays start here: below a roof), `size` (pixels on the longer side, 256; 512 at most), `exclude`
-- (instances left out; players' characters always are). It takes a few seconds, at most 3 ms of each frame, and
-- returns { axis = "xz", bounds, size, image, top, bottom }. Started, it sends the map (once per version is enough:
-- a board uses the latest); in Studio's Edit mode (the command bar, or an agent over Studio's MCP server), it only
-- draws it and prints its bounds.
function Glitchless.captureMap(options: any?): any
	local opts = if type(options) == "table" then options else {}
	if RunService:IsRunning() and not RunService:IsServer() then
		warn("[glitchless] captureMap is the server's call: the server has the whole place")
		return nil
	end
	if not RunService:IsRunning() then
		local map, why = require(script.Map).capture(opts)
		if not map then
			warn("[glitchless] the map wasn't drawn: " .. tostring(why))
			return nil
		end
		print(string.format("[glitchless] map drawn (not sent: Glitchless isn't running): %d×%d px, %s", map.size[1], map.size[2], game:GetService("HttpService"):JSONEncode({ axis = map.axis, bounds = map.bounds })))
		return map
	end
	-- a script that runs before init: wait for it (a minute at most)
	local deadline = os.clock() + 60
	while not server and os.clock() < deadline do
		task.wait(0.5)
	end
	if not server then
		warn("[glitchless] captureMap waited a minute for Glitchless.init: the map isn't sent")
		return nil
	end
	return (server:captureMap(opts))
end

-- The place's extent on the x and z axes in studs, or an area's (a part, model or folder: a zone's volume), with the
-- heights its parts reach: { min = { x, z }, max = { x, z }, top, bottom }. Printed as JSON too, for an agent to read
-- in Studio's Output when it takes the top-down picture itself (README: "A map from Studio"). Works anywhere, started
-- or not, Edit mode included.
function Glitchless.mapBounds(area: Instance?, exclude: { Instance }?): any
	local b = require(script.Map).bounds(area, exclude)
	if not b then
		warn("[glitchless] no parts to bound" .. (if area then " in " .. area:GetFullName() else ""))
		return nil
	end
	print("[glitchless] map bounds" .. (if area then " of " .. area:GetFullName() else "") .. ": " .. game:GetService("HttpService"):JSONEncode({ axis = "xz", bounds = { min = b.min, max = b.max }, top = b.top, bottom = b.bottom }))
	return b
end

-- Sends what is waiting now, within the request budget (the server sends every 15 s by itself, and everything as
-- it closes).
function Glitchless.flush()
	if server then
		server:closeWindows()
		for _, entry in server.entries do
			if entry.session then
				server:flushSession(entry.session, false)
			end
		end
		server:flushSession(server.serverSession, true)
	elseif client then
		client:closeWindow()
	end
end

return Glitchless
