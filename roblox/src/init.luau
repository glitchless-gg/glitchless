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
-- See README.md for every call, SPEC §5e for what goes on the wire, and PRIVACY.md for what is sent about players
-- (no user ID, name or display name, ever).

local RunService = game:GetService("RunService")

local Glitchless = {}

Glitchless.VERSION = "0.1.0"
Glitchless.SDK = "glitchless-roblox/0.1.0"

local server: any = nil
local client: any = nil

local function warnBefore(name: string)
	if RunService:IsStudio() then
		warn("[glitchless] " .. name .. " was called before Glitchless.init: it does nothing")
	end
end

-- Starts Glitchless. On the server, `options` needs `service` (the game's name in Glitchless) and `clientToken`; see
-- README.md for the rest. On a client (a LocalScript) it takes none, and the shipped GlitchlessClient script calls it
-- for you. A second call does nothing.
function Glitchless.init(options: any?)
	if RunService:IsServer() then
		if not server then
			server = require(script.Server).start(script, options :: any)
		end
	elseif not client then
		client = require(script.Client).start(script, options)
	end
	return Glitchless
end

-- A call for a player's session: on the server the player comes first; on a client there's no player argument.
local function call(name: string, fn: (any, any, ...any) -> ...any): (...any) -> ...any
	return function(...)
		if server then
			local args = table.pack(...)
			local s = server:sessionOf(args[1])
			if not s then
				return nil
			end
			return fn(server, s, table.unpack(args, 2, args.n))
		elseif client then
			return fn(client, nil, ...)
		end
		warnBefore(name)
		return nil
	end
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
Glitchless.setProperties = call("setProperties", function(impl, s, props)
	if s then
		s:setProperties(props)
	else
		impl:setProperties(props)
	end
end)

Glitchless.clearProperty = call("clearProperty", function(impl, s, key)
	if s then
		s:setProperties({}, nil, { key })
	else
		impl:clearProperty(key)
	end
end)

-- Where the player is in an open world (a region, a room); nil clears it.
Glitchless.setZone = call("setZone", function(impl, s, zone)
	if s then
		s:setZone(zone)
		impl:changed(s.player)
	else
		impl:setZone(zone)
	end
end)

-- An error the game caught itself, with attributes.
Glitchless.error = call("error", function(impl, s, err, attrs)
	if s then
		impl:reportError(s, "manual", tostring(err), debug.traceback("", 2), attrs, nil)
	else
		impl:error(err, attrs)
	end
end)

-- ───────────────────────────── groups (server) ─────────────────────────────

-- The match, party or run the player's next events belong to. Match and party IDs come from the game's server and
-- are sent hashed; Glitchless.setGroup(player, "run") makes a run ID and returns it. Until the game sets a match of
-- its own, a server's players and the server share one: the server itself (serverAsMatch).
function Glitchless.setGroup(player: Player, kind: string, id: string?, attrs: { [string]: any }?): string?
	if not server then
		if client then
			warn("[glitchless] setGroup is the server's call: a match is set where it is made")
		else
			warnBefore("setGroup")
		end
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
	if not server then
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

function Glitchless.isEnabled(player: Player?): boolean
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

local function serverCall(name: string, fn: (any, any, ...any) -> ...any): (...any) -> ...any
	return function(...)
		if not server then
			if client then
				warn("[glitchless] Glitchless.server." .. name .. " is for server scripts")
			else
				warnBefore("Glitchless.server." .. name)
			end
			return nil
		end
		return fn(server, server.serverSession, ...)
	end
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
end)
Glitchless.server.setZone = serverCall("setZone", function(_, s, zone)
	s:setZone(zone)
end)
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
Glitchless.server.error = serverCall("error", function(impl, s, err, attrs)
	impl:reportError(s, "manual", tostring(err), debug.traceback("", 2), attrs, nil)
end)

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
