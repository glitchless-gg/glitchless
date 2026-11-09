--!strict
-- Glitchless on a Roblox game server (SPEC §5e): it keeps every session in the experience and sends them all.
--
-- Only server scripts can make HTTP requests on Roblox, so the server does what an engine SDK does on a device, for
-- each player at once and for itself:
--   - a session per player, from PlayerAdded to PlayerRemoving (its end says why: they left, they were kicked, the
--     server closed), fed by the game's calls from server scripts and by what the player's client measured and sent
--     over the RemoteEvent (Inbox.luau checks every message, and each player gets 10 messages at once, then 1 a
--     second);
--   - the server's own session (role "server", filed under "<service>.server"): a server_window every 5 s with the
--     server's frames, players, memory and data, and the errors its scripts raise;
--   - sending: one session's batch a request, each session on its own turn, within a budget of requests a minute
--     (Sender.luau), and everything at once when the server closes (BindToClose).
-- Players are anonymous: their sessions carry random IDs, never a user ID, name or display name, and every text sent
-- is scrubbed of the names and user IDs of the players in the server (PRIVACY.md).
-- Extras the game turns on, each off by default, counts and true/false only: ProximityPrompts triggered (`prompts`),
-- seats sat in (`seats`), whether the player followed a friend in (`joinedWithFriend`), and how many of their friends
-- are in the server (`friendsInServer`). And a top-down map of the place for heatmaps (`captureMap`, Map.luau).

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local HttpService = game:GetService("HttpService")
local ScriptContext = game:GetService("ScriptContext")
local Stats = game:GetService("Stats")

local Json = require(script.Parent.Json)
local Words = require(script.Parent.Words)
local Errors = require(script.Parent.Errors)
local Session = require(script.Parent.Session)
local Ticks = require(script.Parent.Ticks)
local Sender = require(script.Parent.Sender)
local Inbox = require(script.Parent.Inbox)
local Map = require(script.Parent.Map)

local Server = {}
Server.__index = Server

local SDK = "glitchless-roblox/0.3.0"
local MAX_SERVER_SESSION_MS = 6 * 3600 * 1000
local NAME_MEMORY_S = 120 -- a player who left is still scrubbed from text this long (their character's errors)

export type Options = {
	service: string,
	clientToken: string,
	intake: string?,
	version: string?,
	env: string?,
	sampleRate: number?,
	requestsPerMinute: number?,
	flushInterval: number?,
	windowSeconds: number?,
	positions: boolean?,
	positionHz: number?,
	deaths: boolean?,
	serverAsMatch: boolean?,
	hashGroupIds: boolean?,
	optIn: boolean?,
	saveChoice: boolean?,
	sessionType: string?,
	properties: { [string]: any }?,
	region: string?,
	client: boolean?,
	debug: boolean?,
	prompts: boolean?,
	seats: boolean?,
	joinedWithFriend: boolean?,
	friendsInServer: boolean?,
	-- for tests: the service objects and clocks to use
	request: ((any) -> (boolean, any))?,
}

local function warnOnce(self: any, key: string, message: string)
	if self.warned[key] then
		return
	end
	self.warned[key] = true
	if self.debug then
		warn("[glitchless] " .. message)
	end
end

local function nowMs(): number
	return math.floor(workspace:GetServerTimeNow() * 1000)
end

local function randomHex(n: number): string
	local hex = string.lower((string.gsub(HttpService:GenerateGUID(false), "-", "")))
	while #hex < n do
		hex ..= string.lower((string.gsub(HttpService:GenerateGUID(false), "-", "")))
	end
	return string.sub(hex, 1, n)
end

-- HttpService:RequestAsync, as Sender wants it: (true, {status, body, headers}) or (false, message).
local function httpRequest(req: any): (boolean, any)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = req.url,
			Method = req.method,
			Headers = if req.body then { ["Content-Type"] = "application/json" } else nil,
			Body = req.body,
			Compress = if req.gzip then Enum.HttpCompression.Gzip else nil,
		})
	end)
	if not ok then
		return false, res
	end
	local headers = {}
	for k, v in (res.Headers or {}) do
		headers[string.lower(k)] = v
	end
	return true, { status = res.StatusCode, body = res.Body, headers = headers }
end

function Server.start(module: Instance, options: Options)
	assert(type(options) == "table", "Glitchless.init needs options: { service = ..., clientToken = ... }")
	assert(type(options.service) == "string" and options.service ~= "", "Glitchless.init: service (your game's name in Glitchless) is required")
	assert(type(options.clientToken) == "string" and options.clientToken ~= "", "Glitchless.init: clientToken (from Glitchless) is required")
	local studio = RunService:IsStudio()
	local self = setmetatable({
		module = module,
		options = options,
		service = options.service,
		version = options.version or tostring(game.PlaceVersion),
		env = options.env or (if studio then "dev" else "prod"),
		studio = studio,
		debug = if options.debug ~= nil then options.debug else studio,
		windowS = options.windowSeconds or 5,
		flushS = math.max(options.flushInterval or 15, 5),
		perMinute = options.requestsPerMinute or 100,
		sessionType = options.sessionType or (if studio then "tester" else "user"),
		positions = options.positions == true,
		positionHz = math.clamp(options.positionHz or 4, 0.5, 10),
		hashGroupIds = options.hashGroupIds ~= false,
		warned = {},
		entries = {} :: { [Player]: any },
		names = {} :: { [string]: number }, -- name → when it may be forgotten (math.huge while in the server)
		gameDeaths = false, -- the game reports deaths itself, so automatic ones are off
		connections = {} :: { RBXScriptConnection },
		closing = false,
		lastWindowAt = os.clock(),
		lastSecondAt = os.clock(),
		lastPosAt = os.clock(),
		lastBeat = nil :: number?,
		datastore = nil :: any,
		gone = setmetatable({}, { __mode = "k" }) :: { [Player]: boolean }, -- players who left (their Player lingers)
		friendPairs = {} :: { [string]: boolean }, -- "<user ID>:<user ID>", smaller first → friends (friendsInServer)
		friendJobs = {} :: { any },
		friendsBusy = false,
		-- init.luau's: calls made for a player before Glitchless saw them join, made when it does (or dropped)
		onPlayer = nil :: ((Player) -> ())?,
		onPlayerGone = nil :: ((Player) -> ())?,
	}, Server)
	self.warn = function(key: string, message: string)
		warnOnce(self, key, message)
	end
	local jobId = if game.JobId ~= "" then game.JobId else HttpService:GenerateGUID(false)
	self.matchId = if options.serverAsMatch ~= false then jobId else nil
	self.sender = Sender.new({
		intake = options.intake or "https://api.glitchless.gg",
		token = options.clientToken,
		perMinute = self.perMinute,
		request = options.request or httpRequest,
		spawn = function(fn)
			task.spawn(fn)
		end,
		now = os.clock,
		warn = self.warn,
	})
	self.ticks = Ticks.new(nowMs)
	self.serverSession = self:newSession("server", nil)
	if self.matchId then
		self.serverSession:setGroup("match", self.matchId, nil)
	end
	self.serverSession.nextFlushAt = os.clock() + self.flushS
	self:setUpRemote()
	self:startClient()
	self:connect()
	for _, player in Players:GetPlayers() do
		self:playerAdded(player)
	end
	return self
end

export type Server = typeof(Server.start(...))

function Server.newSession(self: Server, role: string, device: any): any
	local s = Session.new({
		role = role,
		service = self.service,
		now = nowMs,
		sessionId = "s_" .. randomHex(24),
		sessionType = self.sessionType,
		hashGroupIds = self.hashGroupIds,
		positions = self.positions,
		warn = self.warn,
		device = device or (if role == "server"
			then { browser = "Roblox", browser_version = version(), os = "Roblox", mobile = false }
			else { browser = "Roblox" }),
		server = if role == "server"
			then {
				tick_hz = Ticks.TARGET_HZ,
				tick_source = "heartbeat",
				max_players = Players.MaxPlayers,
				build = if self.studio then "studio" else "dedicated",
				region = self.options.region,
				host = { os = "Roblox" },
			}
			else nil,
		props = self.options.properties,
	})
	s.autoMatch = self.matchId ~= nil
	s.loadSent = false
	return s
end

-- ───────────────────────────── the client and the RemoteEvent ─────────────────────────────

function Server.setUpRemote(self: Server)
	local remote = self.module:FindFirstChild("GlitchlessRemote")
	if not remote then
		remote = Instance.new("RemoteEvent")
		remote.Name = "GlitchlessRemote"
		remote.Parent = self.module
	end
	self.remote = remote :: RemoteEvent
end

-- Puts the GlitchlessClient LocalScript (shipped inside the module) in StarterPlayerScripts, so every player who
-- joins measures their frames without a line of client code. `client = false` leaves it to the game.
function Server.startClient(self: Server)
	if self.options.client == false then
		return
	end
	local boot = self.module:FindFirstChild("GlitchlessClient")
	local starter = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
	if not boot or not starter or starter:FindFirstChild("GlitchlessClient") then
		return
	end
	local copy = boot:Clone()
	local ref = Instance.new("ObjectValue")
	ref.Name = "Module"
	ref.Value = self.module
	ref.Parent = copy
	copy.Parent = starter
end

function Server.tell(self: Server, player: Player, message: any)
	pcall(function()
		self.remote:FireClient(player, message)
	end)
end

-- ───────────────────────────── players ─────────────────────────────

function Server.remember(self: Server, player: Player, untilT: number)
	for _, n in { player.Name, player.DisplayName, tostring(player.UserId) } do
		if n ~= "" then
			self.names[n] = untilT
		end
	end
end

function Server.scrubList(self: Server): { string }
	local t = os.clock()
	local out = {}
	for n, untilT in self.names do
		if untilT >= t then
			table.insert(out, n)
		else
			self.names[n] = nil
		end
	end
	-- longest first, so "Bob_2" goes before "Bob"
	table.sort(out, function(a, b)
		return #a > #b
	end)
	return out
end

function Server.playerAdded(self: Server, player: Player)
	if self.entries[player] then
		return
	end
	self:remember(player, math.huge)
	local entry = {
		player = player,
		session = nil :: any,
		sampled = math.random() < (self.options.sampleRate or 1),
		on = true,
		ready = false, -- the saved choice has been read
		tokens = 10,
		tokensAt = os.clock(),
		device = { browser = "Roblox" },
		budgets = {},
		budgetAt = os.clock(),
		level = nil :: string?,
	}
	self.entries[player] = entry
	if self.options.friendsInServer then
		self:queueFriends(player)
	end
	if not entry.sampled then
		self:tell(player, { op = "state", on = false })
		self:added(player)
		return
	end
	entry.session = self:newSession("player", nil)
	entry.session.player = player
	-- spread over the flush interval, so a full server's first batches don't all go in the same second
	entry.session.nextFlushAt = os.clock() + self.flushS * (0.5 + 0.5 * math.random())
	if entry.session.autoMatch then
		entry.session:setGroup("match", self.matchId, nil)
	end
	if self.options.joinedWithFriend then
		-- Followed a friend into this server (joined from their profile or a friend's join button): only the yes or no
		-- is kept, never whose ID it was.
		local ok, follow = pcall(function()
			return player.FollowUserId
		end)
		entry.followed = ok and type(follow) == "number" and follow ~= 0
		entry.session:setProperties({ joined_with_friend = entry.followed })
	end
	self:readChoice(entry)
	if self.options.deaths ~= false or self.options.seats then
		self:watchCharacter(entry)
	end
	self:added(player)
end

-- The calls the game made for this player before Glitchless saw them join are made now.
function Server.added(self: Server, player: Player)
	if self.onPlayer then
		self.onPlayer(player)
	end
end

-- A player in the server whose join Glitchless hasn't handled yet (the game's PlayerAdded ran before Glitchless's, or
-- Glitchless.init came after they joined): calls for them wait for it.
function Server.awaiting(self: Server, player: any): boolean
	return typeof(player) == "Instance"
		and player:IsA("Player")
		and self.entries[player] == nil
		and not self.gone[player]
		and player.Parent == Players
end

-- The player's saved choice (SPEC §4d), from the game's DataStore: "off" ends the session before anything is sent.
function Server.readChoice(self: Server, entry: any)
	local function decide(choice: string?)
		if self.entries[entry.player] ~= entry then
			return
		end
		entry.ready = true
		if entry.chosen ~= nil then
			-- the player chose while the saved choice was being read: theirs stands
			self:tell(entry.player, { op = "state", on = entry.on and entry.sampled })
			return
		end
		local on = if choice == "off" then false elseif choice == "on" then true else not self.options.optIn
		if not on then
			self:turnOff(entry, false)
		else
			self:tell(entry.player, { op = "state", on = true })
		end
	end
	if self.options.saveChoice == false then
		decide(nil)
		return
	end
	task.spawn(function()
		local ok, value = pcall(function()
			return self:store():GetAsync("u" .. entry.player.UserId)
		end)
		if not ok then
			self.warn("datastore", "the player's Glitchless setting couldn't be read from DataStore (in Studio, turn on Enable Studio Access to API Services): " .. tostring(value))
		end
		decide(if ok and type(value) == "string" then value else nil)
	end)
end

function Server.store(self: Server): any
	if not self.datastore then
		self.datastore = game:GetService("DataStoreService"):GetDataStore("Glitchless")
	end
	return self.datastore
end

function Server.saveChoice(self: Server, player: Player, on: boolean)
	if self.options.saveChoice == false then
		return
	end
	task.spawn(function()
		local ok, err = pcall(function()
			self:store():SetAsync("u" .. player.UserId, if on then "on" else "off")
		end)
		if not ok then
			self.warn("datastore-save", "the player's Glitchless setting couldn't be saved to DataStore: " .. tostring(err))
		end
	end)
end

-- The player turned Glitchless off: nothing more is measured or sent, and what was waiting is dropped.
function Server.turnOff(self: Server, entry: any, save: boolean)
	entry.on = false
	if save then
		entry.chosen = false
		self:saveChoice(entry.player, false)
	end
	local s = entry.session
	if s then
		local id = s.id
		entry.offLevel = if s.levelOpen then s.level else nil
		entry.level = s.level
		s:drop()
		self.sender:clear(function(envelope)
			return envelope.session_id == id
		end)
		entry.session = nil
	end
	self:tell(entry.player, { op = "state", on = false })
end

function Server.turnOn(self: Server, entry: any)
	entry.chosen = true
	if entry.on then
		self:saveChoice(entry.player, true)
		return
	end
	entry.on = true
	self:saveChoice(entry.player, true)
	if not entry.sampled then
		return
	end
	local s = self:newSession("player", entry.device)
	s.level = entry.level
	s.offLevel = entry.offLevel
	s:changeCtx(nowMs())
	s.nextFlushAt = os.clock() + self.flushS
	s.player = entry.player
	entry.session = s
	if s.autoMatch then
		s:setGroup("match", self.matchId, nil)
	end
	if entry.followed ~= nil then
		s:setProperties({ joined_with_friend = entry.followed })
	end
	self:tell(entry.player, { op = "state", on = true })
end

function Server.playerRemoving(self: Server, player: Player, reason: any)
	local entry = self.entries[player]
	self:remember(player, os.clock() + NAME_MEMORY_S)
	self.gone[player] = true
	if self.onPlayerGone then
		self.onPlayerGone(player)
	end
	if self.options.friendsInServer then
		self:forgetFriends(player)
	end
	if not entry then
		return
	end
	self.entries[player] = nil
	local s = entry.session
	if not s then
		return
	end
	local kicked = typeof(reason) == "EnumItem" and (reason.Name == "CreatorKick" or reason.Name == "PlatformKick")
	Server.flushPositions(s)
	s:finish(if kicked then "kicked" else "quit")
	self:flushSession(s, true)
end

-- Each character the player spawns: its Humanoid's deaths (`deaths`) and the seats it sits in (`seats`).
function Server.watchCharacter(self: Server, entry: any)
	local function watch(character: Model)
		local humanoid = character:FindFirstChildOfClass("Humanoid") or character:WaitForChild("Humanoid", 10)
		if not humanoid or not humanoid:IsA("Humanoid") then
			return
		end
		if self.options.seats then
			humanoid.Seated:Connect(function(active, seat)
				if active and seat then
					pcall(self.sat, self, entry, seat)
				end
			end)
		end
		if self.options.deaths == false then
			return
		end
		humanoid.Died:Connect(function()
			if self.gameDeaths or not entry.session then
				return
			end
			local token = {}
			entry.autoDeath = token
			local at = nowMs()
			local pos = self:positionOf(entry.player)
			-- A second for the game to report this death itself (with its cause); then it goes as it is.
			task.delay(1, function()
				if entry.autoDeath ~= token or self.gameDeaths or not entry.session then
					return
				end
				entry.autoDeath = nil
				entry.session:death(pos or {}, at)
			end)
		end)
	end
	if entry.player.Character then
		task.spawn(watch, entry.player.Character)
	end
	table.insert(self.connections, entry.player.CharacterAdded:Connect(watch))
end

function Server.positionOf(self: Server, player: Player): { x: number, y: number, z: number }?
	local character = player.Character
	local root = character and (character.PrimaryPart or character:FindFirstChild("HumanoidRootPart"))
	if root and root:IsA("BasePart") then
		local p = root.Position
		return { x = p.X, y = p.Y, z = p.Z }
	end
	return nil
end

-- ───────────────────────────── extras the game turns on ─────────────────────────────

-- A ProximityPrompt the player triggered (`prompts`): one more `prompt` in their counters, grouped by the prompt's
-- ActionText and ObjectText, the game's words, scrubbed of players' names first (a prompt on a player's plot can say
-- whose it is).
function Server.promptTriggered(self: Server, prompt: any, player: Player)
	local entry = self.entries[player]
	local s = entry and entry.session
	if not s then
		return
	end
	local names = self:scrubList()
	local what = {}
	local action = Words.name(prompt.ActionText)
	if action then
		what.action = Words.scrub(action, names)
	end
	local object = Words.name(prompt.ObjectText)
	if object then
		what.object = Words.scrub(object, names)
	end
	s:count("prompt", what)
end

-- The player's character sat in a seat (`seats`): one more `sit`, grouped by the seat's name (its model's when the seat
-- still has its class's name) and whether it drives (`vehicle`, a VehicleSeat).
function Server.sat(self: Server, entry: any, seat: Instance)
	local s = entry.session
	if not s or not (seat:IsA("Seat") or seat:IsA("VehicleSeat")) then
		return
	end
	local name = seat.Name
	local parent = seat.Parent
	if (name == "Seat" or name == "VehicleSeat") and parent and parent ~= workspace then
		name = parent.Name
	end
	local word = Words.name(name)
	s:count("sit", { seat = if word then Words.scrub(word, self:scrubList()) else nil, vehicle = seat:IsA("VehicleSeat") })
end

local function pairKey(a: Player, b: Player): string
	local x, y = a.UserId, b.UserId
	if x > y then
		x, y = y, x
	end
	return tostring(x) .. ":" .. tostring(y)
end

-- A player joined (`friendsInServer`): whether they are friends with each player already here is asked of Roblox
-- (Player:IsFriendsWith, which waits on a web request), one pair at a time in a thread of its own, never in a frame,
-- and kept while both are in the server.
function Server.queueFriends(self: Server, player: Player)
	for _, other in Players:GetPlayers() do
		if other ~= player then
			table.insert(self.friendJobs, { a = player, b = other, tries = 0 })
		end
	end
	if #self.friendJobs == 0 or self.friendsBusy then
		return
	end
	self.friendsBusy = true
	task.spawn(function()
		while #self.friendJobs > 0 and not self.closing do
			local job = table.remove(self.friendJobs, 1)
			local key = pairKey(job.a, job.b)
			if self.entries[job.a] and self.entries[job.b] and self.friendPairs[key] == nil then
				local ok, yes = pcall(function()
					return job.a:IsFriendsWith(job.b.UserId)
				end)
				if ok then
					self.friendPairs[key] = yes == true
				elseif job.tries < 2 then
					-- Roblox's web request failed: try again in a moment, twice at most
					job.tries += 1
					table.insert(self.friendJobs, job)
					task.wait(2)
				end
			end
		end
		self.friendsBusy = false
	end)
end

function Server.forgetFriends(self: Server, player: Player)
	local id = tostring(player.UserId)
	for key in self.friendPairs do
		local a, b = string.match(key, "^(.-):(.*)$")
		if a == id or b == id then
			self.friendPairs[key] = nil
		end
	end
end

-- How many of the player's friends are in the server now. A player who turned Glitchless off isn't counted in anyone's.
function Server.friendsOf(self: Server, player: Player): number
	local n = 0
	for other, entry in self.entries do
		if other ~= player and entry.on and self.friendPairs[pairKey(player, other)] then
			n += 1
		end
	end
	return n
end

-- ───────────────────────────── the map ─────────────────────────────

-- Draws a top-down map of the place (or of `options.area`, within `options.bounds`) and sends it as a `map` event for
-- the level `options.level`, the zone `options.zone`, or the whole place (neither), in a batch of its own: a map is
-- the game's, not a player's, so it goes under the game's service with no session_start (it starts no session).
-- Returns the map ({ axis, bounds, size, image, top, bottom }), or nil and why.
function Server.captureMap(self: Server, options: any): (any, string?)
	local map, why = Map.capture(options)
	if not map then
		self.warn("map:" .. tostring(why), "the map wasn't drawn: " .. tostring(why))
		return nil, why
	end
	local names = self:scrubList()
	local level, zone = Words.name(options.level), Words.name(options.zone)
	local e = {
		type = "map",
		ts = nowMs(),
		level = if level then Words.scrub(level, names) else nil,
		zone = if zone then Words.scrub(zone, names) else nil,
		axis = map.axis,
		bounds = map.bounds,
		size = map.size,
		image = map.image,
	}
	self.sender:add({
		service = self.service,
		env = self.env,
		version = self.version,
		session_id = "s_" .. randomHex(24),
		sdk = SDK,
		batch_id = "b_" .. randomHex(16),
		events = Json.array({ e }),
	}, false)
	self.sender:pump()
	if self.debug then
		print(string.format("[glitchless] map of %s sent: %d×%d px, %.0f KB, bounds min [%g, %g], max [%g, %g] (x, z)", if level then "level " .. level elseif zone then "zone " .. zone else "the place", map.size[1], map.size[2], #map.image / 1024, map.bounds.min[1], map.bounds.min[2], map.bounds.max[1], map.bounds.max[2]))
	end
	return map, nil
end

-- ───────────────────────────── what clients send ─────────────────────────────

function Server.allow(self: Server, entry: any): boolean
	local t = os.clock()
	entry.tokens = math.min(10, entry.tokens + (t - entry.tokensAt))
	entry.tokensAt = t
	if entry.tokens < 1 then
		return false
	end
	entry.tokens -= 1
	return true
end

-- How many events of a type a player's client may send a minute.
local PER_MINUTE = {
	frame_window = 30, hitch = 60, counts = 30, load = 2, error = 60, props = 30, zone = 60,
	custom = 600, level_start = 120, level_complete = 120, level_fail = 120, level_abandon = 120, death = 120,
}

function Server.budget(self: Server, entry: any, kind: string): boolean
	local t = os.clock()
	if t - entry.budgetAt >= 60 then
		entry.budgets = {}
		entry.budgetAt = t
	end
	local used = (entry.budgets[kind] or 0) + 1
	entry.budgets[kind] = used
	return used <= (PER_MINUTE[kind] or 0)
end

function Server.onClient(self: Server, player: Player, message: any)
	local entry = self.entries[player]
	if not entry or type(message) ~= "table" or not self:allow(entry) then
		return
	end
	local op = message.op
	if op == "hello" then
		entry.device = Inbox.device(message.device)
		if entry.session then
			entry.session.device = entry.device
		end
		if entry.ready then
			self:tell(player, { op = "state", on = entry.on and entry.sampled })
		end
	elseif op == "enabled" then
		if message.on == true then
			self:turnOn(entry)
		elseif message.on == false then
			self:turnOff(entry, true)
		end
	elseif op == "events" and type(message.events) == "table" then
		local s = entry.session
		if not s then
			return
		end
		local n = 0
		for _, raw in message.events do
			n += 1
			if n > Inbox.MAX_EVENTS then
				break
			end
			local e = Inbox.event(raw)
			if e and self:budget(entry, e.type) then
				self:apply(entry, s, e)
			end
		end
	end
end

-- A checked client event, applied to the player's session.
function Server.apply(self: Server, entry: any, s: any, e: any)
	local t = nowMs()
	if e.ts == nil or e.ts > t + 2000 or e.ts < s.startedAt - 5000 then
		e.ts = t
	end
	local ty = e.type
	if ty == "frame_window" and self.options.friendsInServer then
		e.ctx = e.ctx or {}
		e.ctx.friends_in_server = self:friendsOf(entry.player)
		s:push(e)
	elseif ty == "frame_window" or ty == "counts" then
		s:push(e)
	elseif ty == "hitch" then
		e.recent = s:recentBefore(e.ts, 1500)
		s:push(e)
	elseif ty == "load" then
		if not s.loadSent then
			s.loadSent = true
			-- From the player joining the server to their first frame after the game loaded: the loading screen.
			s:push({ type = "load", ts = e.ts, ttff_ms = math.clamp(e.ts - s.startedAt, 0, 600000) })
		end
	elseif ty == "error" then
		self:reportError(s, e.kind, e.message, e.stack, e.attrs, e.ts)
	elseif ty == "custom" then
		s:track(e.name, e.attrs, e.ts)
	elseif ty == "level_start" then
		s:levelStart(e.level, e.attrs, e.ts)
	elseif ty == "level_complete" then
		s:levelComplete(e.level, { duration_s = e.duration_s, score = e.score }, e.ts)
	elseif ty == "level_fail" then
		s:levelFail(e.level, { cause = e.cause }, e.ts)
	elseif ty == "level_abandon" then
		s:levelAbandon(e.level, nil, e.ts)
	elseif ty == "death" then
		self:death(entry, { cause = e.cause }, e.ts)
	elseif ty == "props" then
		s:setProperties(e.props, e.ts, e.remove)
	elseif ty == "zone" then
		s:setZone(e.zone, e.ts)
	end
end

-- An error from a script: scrubbed of players' names, read into an error event and queued on `s`.
function Server.reportError(self: Server, s: any, kind: string, message: string, stack: string?, attrs: any, ts: number?)
	local names = self:scrubList()
	local report = Errors.read(Words.scrub(message, names), if stack then Words.scrub(stack, names) else nil)
	if report.own then
		return
	end
	s:error({
		ts = ts,
		kind = kind,
		message = report.message,
		stack = report.stack,
		source = report.source,
		line = report.line,
		fn = report.fn,
		fingerprint = Errors.fingerprint(kind, report.message, report.fn),
		attrs = Words.attrs(attrs),
	})
end

function Server.death(self: Server, entry: any, info: any, ts: number?)
	if not entry then
		return
	end
	entry.autoDeath = nil
	if not entry.session then
		return
	end
	local d = table.clone(info)
	if self.positions and d.x == nil then
		local p = self:positionOf(entry.player)
		if p then
			d.x, d.y, d.z = p.x, p.y, p.z
		end
	end
	entry.session:death(d, ts)
end

-- ───────────────────────────── the loop ─────────────────────────────

function Server.connect(self: Server)
	local c = self.connections
	table.insert(c, Players.PlayerAdded:Connect(function(player)
		self:playerAdded(player)
	end))
	table.insert(c, Players.PlayerRemoving:Connect(function(player, reason)
		self:playerRemoving(player, reason)
	end))
	if self.options.prompts then
		table.insert(c, game:GetService("ProximityPromptService").PromptTriggered:Connect(function(prompt, player)
			local ok, err = pcall(self.promptTriggered, self, prompt, player)
			if not ok then
				self.warn("prompt", "a ProximityPrompt couldn't be counted: " .. tostring(err))
			end
		end))
	end
	table.insert(c, self.remote.OnServerEvent:Connect(function(player, message)
		local ok, err = pcall(self.onClient, self, player, message)
		if not ok then
			self.warn("client-message", "a client's message couldn't be read: " .. tostring(err))
		end
	end))
	-- A server Script's error stops its thread, never the server, and a server often closes right after one (its
	-- last players left, a save failed at shutdown): `server_script`, which no one reads as a crash.
	table.insert(c, ScriptContext.Error:Connect(function(message, stack)
		pcall(self.reportError, self, self.serverSession, "server_script", tostring(message), tostring(stack), nil, nil)
	end))
	table.insert(c, RunService.Heartbeat:Connect(function(dt)
		local ok, err = pcall(self.beat, self, dt)
		if not ok then
			self.warn("loop", "Glitchless's server loop failed: " .. tostring(err))
		end
	end))
	game:BindToClose(function()
		self:close()
	end)
end

-- A Stats time, in milliseconds (Stats reports them in seconds).
function Server.statMs(key: string): number?
	local ok, v = pcall(function()
		return (Stats :: any)[key]
	end)
	return if ok and type(v) == "number" and v == v then v * 1000 else nil
end

function Server.beat(self: Server, dt: number)
	if self.closing then
		return
	end
	local t = os.clock()
	self.ticks:tick(dt * 1000, Server.statMs("HeartbeatTime"), Server.statMs("PhysicsStepTime"))
	if self.positions and t - self.lastPosAt >= 1 / self.positionHz then
		self.lastPosAt = t
		self:samplePositions()
	end
	if t - self.lastSecondAt >= 1 then
		self.lastSecondAt = t
		self:second()
	end
	if t - self.lastWindowAt >= self.windowS then
		self.lastWindowAt = t
		self:closeWindows()
	end
end

function Server.second(self: Server)
	local players = Players:GetPlayers()
	self.ticks:players(#players)
	for _, p in players do
		local ok, ping = pcall(function()
			return p:GetNetworkPing()
		end)
		if ok and type(ping) == "number" and ping > 0 then
			self.ticks:playerPing(ping * 1000)
		end
	end
	-- A server session lasts the server's life, cut every 6 hours so a day's numbers don't wait for it to close.
	local s = self.serverSession
	if nowMs() - s.startedAt >= MAX_SERVER_SESSION_MS then
		s:finish("max_duration")
		self:flushSession(s, true)
		local groups = table.clone(s.groups)
		self.serverSession = self:newSession("server", nil)
		for kind, id in groups do
			self.serverSession.groups[kind] = id
			self.serverSession:push({ type = "group", kind = kind, id = id })
		end
		self.serverSession:changeCtx(nowMs())
		self.serverSession.nextFlushAt = os.clock() + self.flushS
	end
	-- Each session's batch on its turn: every `flushInterval` seconds, longer when the budget has to go round more
	-- sessions (a full server's players each send less often, with more in each batch).
	local sessions = { self.serverSession }
	for _, entry in self.entries do
		if entry.session then
			table.insert(sessions, entry.session)
		end
	end
	local interval = math.max(self.flushS, #sessions * 60 / (self.perMinute * 0.8))
	local t = os.clock()
	for _, sess in sessions do
		if t >= (sess.nextFlushAt or 0) then
			sess.nextFlushAt = t + interval
			self:flushSession(sess, false)
		end
	end
	self.sender:pump()
end

function Server.samplePositions(self: Server)
	local t = nowMs()
	for _, entry in self.entries do
		local s = entry.session
		if s then
			local p = self:positionOf(entry.player)
			if p then
				s.pts = s.pts or Json.array({})
				if #s.pts < 200 then
					local function r(v: number): number
						return math.floor(v * 100 + 0.5) / 100
					end
					table.insert(s.pts, { t, r(p.x), r(p.y), r(p.z) })
				end
			end
		end
	end
end

function Server.closeWindows(self: Server)
	local countsOk = self.sender:has("counts")
	local mem
	pcall(function()
		mem = Stats:GetTotalMemoryUsageMb()
	end)
	local kbIn, kbOut
	pcall(function()
		kbIn, kbOut = Stats.DataReceiveKbps * 8, Stats.DataSendKbps * 8 -- Stats says kilobytes a second; the wire, kilobits
	end)
	local players = #Players:GetPlayers()
	local sw = self.ticks:close({ players = players, mem_mb = mem, in_kbps = kbIn, out_kbps = kbOut })
	self.serverSession:push(sw)
	self.serverSession:closeWindow(nil, countsOk)
	for _, entry in self.entries do
		local s = entry.session
		if s then
			s:closeWindow(nil, countsOk)
			Server.flushPositions(s)
		end
	end
end

-- The positions sampled since the window began, as one pos event.
function Server.flushPositions(s: any)
	if s.pts and #s.pts > 0 then
		s:push({ type = "pos", ts = s.pts[1][1], pts = s.pts })
		s.pts = nil
	end
end

-- Cuts a session's batch and gives it to the sender. `now`: it ended, so it goes on the next pump.
function Server.flushSession(self: Server, s: any, now: boolean)
	local events = s:take()
	if not events or #events == 0 then
		return
	end
	-- No player's name or user ID leaves the server, wherever the game or a client put one.
	local names = Words.names(self:scrubList())
	for _, e in events do
		Words.scrubTree(e, names)
	end
	local envelope: { [string]: any } = {
		service = self.service,
		env = self.env,
		version = self.version,
		session_id = s.id,
		sdk = SDK,
		batch_id = "b_" .. randomHex(16),
		events = Json.array(events),
	}
	if s.role == "server" then
		envelope.role = "server"
	end
	self.sender:add(envelope, s.role == "server")
	if now then
		self.sender:pump()
	end
end

-- The server is closing (BindToClose): every session ends and everything goes now. Roblox gives a closing server 30
-- seconds; this takes up to 25.
function Server.close(self: Server)
	if self.closing then
		return
	end
	self:closeWindows()
	self.closing = true
	for player, entry in self.entries do
		if entry.session then
			Server.flushPositions(entry.session)
			entry.session:finish("close")
			self:flushSession(entry.session, false)
		end
		self.entries[player] = nil
	end
	self.serverSession:finish("close")
	self:flushSession(self.serverSession, false)
	local deadline = os.clock() + 25
	while self.sender:waiting() > 0 and os.clock() < deadline and not self.sender.stopped do
		self.sender:pump(true)
		task.wait(0.25)
	end
	for _, c in self.connections do
		c:Disconnect()
	end
end

-- ───────────────────────────── the game's calls ─────────────────────────────

-- The session a call from a server script is for: a player's, or nil (with one warning) for anything else.
function Server.sessionOf(self: Server, player: any): any
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		self.warn("player-arg", "on the server, Glitchless's calls take the player first (Glitchless.track(player, name, attrs)); use Glitchless.server for the server's own events")
		return nil
	end
	local entry = self.entries[player]
	return entry and entry.session
end

function Server.entryOf(self: Server, player: any): any
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return nil
	end
	return self.entries[player]
end

-- Tells a player's client its context changed, so its frame window closes there too.
function Server.changed(self: Server, player: Player)
	self:tell(player, { op = "ctx" })
end

function Server.newRunId(): string
	return "r_" .. randomHex(12)
end

function Server.setGroup(self: Server, s: any, kind: string, id: any, attrs: any): string?
	if kind == "match" then
		s.autoMatch = false
	end
	if kind == "run" and id == nil then
		id = true
	end
	if kind == "run" and type(id) == "string" then
		-- A saved run carried on: in anonymous mode it becomes a new run, said to be resumed (SPEC §1 groups).
		return s:setGroup("run", true, attrs, nil, Server.newRunId, true)
	end
	return s:setGroup(kind, id, attrs, nil, Server.newRunId)
end

function Server.endGroup(self: Server, s: any, kind: string)
	if kind == "match" then
		s.autoMatch = false
	end
	s:setGroup(kind, nil, nil)
end

return Server
