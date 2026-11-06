--!nocheck
-- A small fake of Roblox for running the Glitchless SDK under Lune (https://lune-org.github.io/docs).
--
-- A world holds a server DataModel and one client DataModel per player, each with the services the SDK uses
-- (Players, RunService, HttpService, ScriptContext, Stats, UserInputService, GuiService, StarterPlayer,
-- DataStoreService, ContentProvider, Workspace), and loads roblox/src into each one's ReplicatedStorage as Rojo
-- would, so the SDK's own `require(script.Parent.X)` works. Each DataModel has its own module cache, as a Roblox
-- server and client do. A RemoteEvent the server makes is copied to every client, and firing it carries a deep copy
-- across (metatables dropped), as Roblox's remotes do.
--
-- Time is virtual: `world:step(dt)` moves the clock, fires each client's PreRender and every Heartbeat, and runs
-- task.delay/task.wait threads that are due. HTTP is either a function the test gives (`world.http`, answered at
-- once) or real (`world.realHttp`, through @lune/net, made from the test's own thread while the SDK's thread waits).

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")

local Roblox = {}

local SRC = "roblox/src"

-- ───────────────────────────── signals ─────────────────────────────

local Signal = {}
Signal.__index = Signal

function Signal.new(world)
	return setmetatable({ world = world, handlers = {}, waiting = {} }, Signal)
end

function Signal:Connect(fn)
	local h = { fn = fn, connected = true }
	table.insert(self.handlers, h)
	return {
		Connected = true,
		Disconnect = function(c)
			h.connected = false
			c.Connected = false
		end,
	}
end

function Signal:Once(fn)
	local c
	c = self:Connect(function(...)
		c:Disconnect()
		fn(...)
	end)
	return c
end

function Signal:Wait()
	local co = coroutine.running()
	table.insert(self.waiting, co)
	return coroutine.yield()
end

function Signal:Fire(...)
	for _, h in table.clone(self.handlers) do
		if h.connected then
			self.world:spawn(h.fn, ...)
		end
	end
	local waiting = self.waiting
	self.waiting = {}
	for _, co in waiting do
		self.world:resume(co, ...)
	end
end

-- ───────────────────────────── instances ─────────────────────────────

local Instance = {}
local CLASSES = {
	-- class → its superclasses (for IsA)
	Player = { "Instance" },
	RemoteEvent = { "Instance" },
	ModuleScript = { "LuaSourceContainer", "Instance" },
	LocalScript = { "BaseScript", "LuaSourceContainer", "Instance" },
	Script = { "BaseScript", "LuaSourceContainer", "Instance" },
	ObjectValue = { "ValueBase", "Instance" },
	Folder = { "Instance" },
	Model = { "PVInstance", "Instance" },
	Part = { "BasePart", "PVInstance", "Instance" },
	Humanoid = { "Instance" },
}

local function isA(inst, class)
	if inst.ClassName == class then
		return true
	end
	for _, c in CLASSES[inst.ClassName] or { "Instance" } do
		if c == class then
			return true
		end
	end
	return false
end

local Methods = {}

function Methods.GetFullName(self)
	local parts = {}
	local i = self
	while i and i.ClassName ~= "DataModel" do
		table.insert(parts, 1, i.Name)
		i = i.Parent
	end
	return table.concat(parts, ".")
end

function Methods.FindFirstChild(self, name)
	for _, c in rawget(self, "_children") do
		if c.Name == name then
			return c
		end
	end
	return nil
end

function Methods.FindFirstChildOfClass(self, class)
	for _, c in rawget(self, "_children") do
		if c.ClassName == class then
			return c
		end
	end
	return nil
end

function Methods.WaitForChild(self, name, timeout)
	local found = self:FindFirstChild(name)
	if found then
		return found
	end
	local world = rawget(self, "_world")
	local co = coroutine.running()
	local done = false
	local conn
	conn = rawget(self, "_props").ChildAdded:Connect(function(child)
		if not done and child.Name == name then
			done = true
			conn:Disconnect()
			world:resume(co, child)
		end
	end)
	if timeout then
		world:delay(timeout, function()
			if not done then
				done = true
				conn:Disconnect()
				world:resume(co, nil)
			end
		end)
	end
	return coroutine.yield()
end

function Methods.GetChildren(self)
	return table.clone(rawget(self, "_children"))
end

function Methods.IsA(self, class)
	return isA(self, class)
end

function Methods.Clone(self)
	local world = rawget(self, "_world")
	local copy = Instance.new(world, self.ClassName)
	for k, v in rawget(self, "_props") do
		if k ~= "Parent" and type(v) ~= "table" then
			rawget(copy, "_props")[k] = v
		end
	end
	rawset(copy, "_source", rawget(self, "_source"))
	for _, c in rawget(self, "_children") do
		c:Clone().Parent = copy
	end
	return copy
end

function Methods.Destroy(self)
	self.Parent = nil
end

function Methods.GetService(self, name)
	local s = self:FindFirstChild(name)
	assert(s, "the fake Roblox has no service " .. name)
	return s
end

-- Properties that are nil until set (Parent, a player's Character, an ObjectValue's Value…)
local NILABLE = { Parent = true, Character = true, Value = true, PrimaryPart = true, LocalPlayer = true }

local InstanceMeta = {}
InstanceMeta.__type = "Instance"

function InstanceMeta.__index(self, key)
	local props = rawget(self, "_props")
	local v = props[key]
	if v ~= nil then
		return v
	end
	local m = rawget(self, "_methods")[key] or Methods[key]
	if m then
		return m
	end
	local child = Methods.FindFirstChild(self, key)
	if child then
		return child
	end
	if NILABLE[key] then
		return nil
	end
	error(tostring(key) .. " is not a valid member of " .. self.ClassName .. " \"" .. Methods.GetFullName(self) .. "\"", 2)
end

function InstanceMeta.__newindex(self, key, value)
	local props = rawget(self, "_props")
	if key == "Parent" then
		local old = props.Parent
		if old == value then
			return
		end
		if old then
			local list = rawget(old, "_children")
			local i = table.find(list, self)
			if i then
				table.remove(list, i)
			end
		end
		props.Parent = value
		if value then
			table.insert(rawget(value, "_children"), self)
			rawget(value, "_props").ChildAdded:Fire(self)
			local world = rawget(self, "_world")
			world:replicate(self)
		end
		return
	end
	props[key] = value
	local changed = props.Changed
	if changed then
		changed:Fire(key)
	end
end

function InstanceMeta.__tostring(self)
	return self.Name
end

function Instance.new(world, class, methods)
	local self = setmetatable({
		_world = world,
		_children = {},
		_methods = methods or {},
		_props = { ClassName = class, Name = class, ChildAdded = Signal.new(world), Changed = Signal.new(world) },
	}, InstanceMeta)
	return self
end

Roblox.Instance = Instance
Roblox.Signal = Signal

-- ───────────────────────────── enums ─────────────────────────────

local function enumItem(enum, name, value)
	return setmetatable({ Name = name, Value = value, EnumType = enum }, {
		__type = "EnumItem",
		__tostring = function()
			return "Enum." .. enum .. "." .. name
		end,
	})
end

local Enum = {
	HttpCompression = { None = enumItem("HttpCompression", "None", 0), Gzip = enumItem("HttpCompression", "Gzip", 1) },
	PlayerExitReason = {
		Unknown = enumItem("PlayerExitReason", "Unknown", 0),
		PlatformKick = enumItem("PlayerExitReason", "PlatformKick", 1),
		CreatorKick = enumItem("PlayerExitReason", "CreatorKick", 2),
	},
	SavedQualitySetting = { Automatic = enumItem("SavedQualitySetting", "Automatic", 0) },
}
for i = 1, 10 do
	Enum.SavedQualitySetting["QualityLevel" .. i] = enumItem("SavedQualitySetting", "QualityLevel" .. i, i)
end
Roblox.Enum = Enum

local function typeof(v)
	local mt = getmetatable(v)
	if type(v) == "table" and type(mt) == "table" and rawget(mt, "__type") then
		return mt.__type
	end
	return type(v)
end

-- ───────────────────────────── the world ─────────────────────────────

local World = {}
World.__index = World

function Roblox.world(opts)
	opts = opts or {}
	local self = setmetatable({
		clock = 1000,
		epoch = opts.epoch or 1793000000000, -- ms at clock 1000
		timers = {},
		deferred = {},
		studio = opts.studio == true,
		jobId = opts.jobId or "8f2c91d0-4ab7-4c1e-9a51-1b2c3d4e5f60",
		placeVersion = opts.placeVersion or 42,
		http = opts.http, -- function(req) → response table, for fake HTTP
		realHttp = opts.realHttp == true,
		requests = {},
		httpQueue = {},
		datastore = {},
		warnings = {},
		errors = {},
		clients = {},
		nextUserId = 1000001,
	}, World)
	self.server = self:dataModel(true, nil)
	return self
end

-- Runs fn in a new thread, as task.spawn does. An error in it goes to that DataModel's ScriptContext.Error, as on Roblox.
function World:spawn(fn, ...)
	local co = coroutine.create(fn)
	self:resume(co, ...)
	return co
end

function World:resume(co, ...)
	local results = table.pack(coroutine.resume(co, ...))
	if not results[1] then
		local message = tostring(results[2])
		table.insert(self.errors, message)
		local dm = self.currentDm
		if dm and dm._scriptError then
			dm._scriptError:Fire(message, debug.traceback(co), nil)
		end
		return
	end
	local request = results[2]
	if coroutine.status(co) == "suspended" and type(request) == "table" and request.__http then
		-- The SDK's thread waits on a real request: made between frames from the test's own thread (pumpHttp), since
		-- Lune can only make one from a thread of its own.
		table.insert(self.httpQueue, { co = co, req = request.__http })
	end
end

function World:pumpHttp()
	while #self.httpQueue > 0 do
		local item = table.remove(self.httpQueue, 1)
		self:resume(item.co, self:realRequest(item.req))
	end
end

function World:delay(t, fn, ...)
	local args = table.pack(...)
	table.insert(self.timers, { at = self.clock + t, fn = function()
		fn(table.unpack(args, 1, args.n))
	end })
end

function World:runTimers()
	local guard = 0
	while true do
		guard += 1
		assert(guard < 10000, "timers keep scheduling themselves")
		table.sort(self.timers, function(a, b)
			return a.at < b.at
		end)
		local first = self.timers[1]
		if not first or first.at > self.clock then
			break
		end
		table.remove(self.timers, 1)
		self:spawn(first.fn)
	end
	local deferred = self.deferred
	self.deferred = {}
	for _, d in deferred do
		self:spawn(d)
	end
end

-- One frame of `dt` seconds on every DataModel: each client's PreRender, then every Heartbeat, then due threads.
function World:step(dt)
	self.clock += dt
	for _, c in self.clients do
		if c.connected then
			self.currentDm = c.dm
			c.dm.RunService.PreRender:Fire(dt)
			c.dm.RunService.Heartbeat:Fire(dt)
		end
	end
	self.currentDm = self.server
	self.server.RunService.Heartbeat:Fire(dt)
	self:runTimers()
	self:pumpHttp()
end

-- Frames for `seconds`, each `dt` long (or what `dtFn(i)` says).
function World:run(seconds, dt, each)
	local elapsed = 0
	local i = 0
	while elapsed < seconds - 1e-9 do
		i += 1
		local d = if type(dt) == "function" then dt(i) else (dt or 1 / 60)
		if each then
			each(i, elapsed)
		end
		self:step(d)
		elapsed += d
	end
end

function World:nowMs()
	return self.epoch + (self.clock - 1000) * 1000
end

function World:realRequest(req)
	local net = require("@lune/net")
	local body = req.Body
	local headers = table.clone(req.Headers or {})
	if req.Compress == Enum.HttpCompression.Gzip and body then
		body = serde.compress("gzip", body)
		headers["Content-Encoding"] = "gzip"
	end
	local ok, res = pcall(net.request, { url = req.Url, method = req.Method, headers = headers, body = body })
	if not ok then
		return { __error = "HttpError: ConnectFail " .. tostring(res) }
	end
	return { Success = res.ok, StatusCode = res.statusCode, StatusMessage = res.statusMessage, Headers = res.headers, Body = res.body }
end

-- ───────────────────────────── services ─────────────────────────────

function World:service(dm, name, methods)
	local s = Instance.new(self, name, methods)
	s.Name = name
	s.Parent = dm
	return s
end

function World:dataModel(isServer, localPlayer)
	local world = self
	local dm = Instance.new(self, "DataModel", {
		BindToClose = function(model, fn)
			table.insert(rawget(model, "_closers"), fn)
		end,
		IsLoaded = function()
			return true
		end,
	})
	rawset(dm, "_closers", {})
	rawset(dm, "_cache", {})
	rawset(dm, "_isServer", isServer)
	dm.Name = if isServer then "Game" else "ClientGame"
	dm.JobId = if self.studio then "" else self.jobId
	dm.PlaceVersion = if self.studio then 0 else self.placeVersion
	dm.PlaceId = 1234567
	dm.Loaded = Signal.new(self)

	local rs = self:service(dm, "RunService", {
		IsServer = function()
			return isServer
		end,
		IsClient = function()
			return not isServer
		end,
		IsStudio = function()
			return world.studio
		end,
	})
	rs.Heartbeat = Signal.new(self)
	rs.PreRender = Signal.new(self)
	rs.RenderStepped = rs.PreRender

	local players = self:service(dm, "Players", {
		GetPlayers = function(p)
			local out = {}
			for _, c in rawget(p, "_children") do
				if c.ClassName == "Player" then
					table.insert(out, c)
				end
			end
			return out
		end,
	})
	players.PlayerAdded = Signal.new(self)
	players.PlayerRemoving = Signal.new(self)
	players.MaxPlayers = 12
	if localPlayer then
		players.LocalPlayer = localPlayer
	end

	self:service(dm, "HttpService", {
		GenerateGUID = function(_, braces)
			local hex = {}
			for i = 1, 32 do
				hex[i] = string.format("%x", math.random(0, 15))
			end
			local s = table.concat(hex)
			s = string.upper(string.sub(s, 1, 8) .. "-" .. string.sub(s, 9, 12) .. "-" .. string.sub(s, 13, 16) .. "-" .. string.sub(s, 17, 20) .. "-" .. string.sub(s, 21))
			return if braces == false then s else "{" .. s .. "}"
		end,
		RequestAsync = function(_, req)
			assert(isServer, "HttpService can't be used from a client")
			table.insert(world.requests, req)
			local res
			if world.realHttp then
				res = if coroutine.isyieldable() then coroutine.yield({ __http = req }) else world:realRequest(req)
			elseif world.http then
				res = world.http(req)
			else
				res = { StatusCode = 202, Body = '{"accepted":1}', Headers = {} }
			end
			if res.__error then
				error(res.__error, 0)
			end
			res.Success = res.StatusCode >= 200 and res.StatusCode < 300
			return res
		end,
		JSONEncode = function(_, v)
			return serde.encode("json", v)
		end,
		JSONDecode = function(_, s)
			return serde.decode("json", s)
		end,
	})

	local sc = self:service(dm, "ScriptContext")
	sc.Error = Signal.new(self)
	rawset(dm, "_scriptError", sc.Error)

	local stats = self:service(dm, "Stats", {
		GetTotalMemoryUsageMb = function(s)
			return rawget(s, "_props").MemoryMb
		end,
	})
	stats.MemoryMb = if isServer then 812.5 else 1430.25
	stats.FrameTime = 1 / 60
	stats.RenderCPUFrameTime = 0.004
	stats.RenderGPUFrameTime = 0.006
	stats.PhysicsStepTime = 0.001
	stats.HeartbeatTime = 0.003
	stats.SceneDrawcallCount = 420
	stats.ShadowsDrawcallCount = 60
	stats.UI2DDrawcallCount = 20
	stats.UI3DDrawcallCount = 0
	stats.SceneTriangleCount = 180000
	stats.InstanceCount = 25000
	stats.PrimitivesCount = 900
	stats.DataReceiveKbps = 12.5
	stats.DataSendKbps = 3.25

	local uis = self:service(dm, "UserInputService")
	uis.TouchEnabled = false
	uis.KeyboardEnabled = true
	uis.GamepadEnabled = false
	uis.WindowFocused = Signal.new(self)
	uis.WindowFocusReleased = Signal.new(self)

	local gui = self:service(dm, "GuiService", {
		IsTenFootInterface = function(g)
			return rawget(g, "_props").TenFoot == true
		end,
	})
	gui.TenFoot = false
	local vr = self:service(dm, "VRService")
	vr.VREnabled = false

	local cp = self:service(dm, "ContentProvider")
	cp.RequestQueueSize = 0

	self:service(dm, "ReplicatedStorage")
	local starter = self:service(dm, "StarterPlayer")
	local sps = Instance.new(self, "Folder")
	sps.Name = "StarterPlayerScripts"
	sps.Parent = starter

	self:service(dm, "DataStoreService", {
		GetDataStore = function(_, name)
			local store = world.datastore
			return {
				GetAsync = function(_, key)
					if world.datastoreBroken then
						error("DataStore request was rejected: Studio access to API services is off", 0)
					end
					return store[name .. "/" .. key]
				end,
				SetAsync = function(_, key, value)
					store[name .. "/" .. key] = value
				end,
			}
		end,
	})

	local ws = self:service(dm, "Workspace", {
		GetServerTimeNow = function()
			return world:nowMs() / 1000
		end,
	})
	ws.CurrentCamera = { ViewportSize = { X = 1920, Y = 1080 } }

	-- Glitchless, as Rojo builds it from roblox/src
	local module = self:loadTree(SRC, "Glitchless")
	module.Parent = dm.ReplicatedStorage
	return dm
end

-- The module tree Rojo makes of a folder: init.luau is the folder's ModuleScript, *.luau its children,
-- *.client.luau LocalScripts.
function World:loadTree(dir, name)
	local module = Instance.new(self, "ModuleScript")
	module.Name = name
	rawset(module, "_source", fs.readFile(dir .. "/init.luau"))
	rawset(module, "_path", dir .. "/init.luau")
	for _, file in fs.readDir(dir) do
		local path = dir .. "/" .. file
		if file ~= "init.luau" and fs.isFile(path) then
			local class, base = "ModuleScript", string.match(file, "^(.-)%.luau$")
			if string.match(file, "%.client%.luau$") then
				class, base = "LocalScript", string.match(file, "^(.-)%.client%.luau$")
			end
			local child = Instance.new(self, class)
			child.Name = base
			rawset(child, "_source", fs.readFile(path))
			rawset(child, "_path", path)
			child.Parent = module
		end
	end
	return module
end

-- require(moduleScript) inside a DataModel: each DataModel its own cache, as a Roblox server and client have.
function World:require(dm, module)
	local cache = rawget(dm, "_cache")
	if cache[module] ~= nil then
		return cache[module]
	end
	local world = self
	local env = {
		script = module,
		game = dm,
		workspace = dm.Workspace,
		Enum = Enum,
		typeof = typeof,
		Instance = {
			new = function(class)
				return Instance.new(world, class)
			end,
		},
		task = {
			spawn = function(fn, ...)
				return world:spawn(fn, ...)
			end,
			defer = function(fn)
				table.insert(world.deferred, fn)
			end,
			delay = function(t, fn, ...)
				world:delay(t, fn, ...)
			end,
			wait = function(t)
				local co = coroutine.running()
				world:delay(t or 0, function()
					world:resume(co, t)
				end)
				return coroutine.yield()
			end,
		},
		os = {
			clock = function()
				return world.clock
			end,
			time = function()
				return math.floor(world:nowMs() / 1000)
			end,
			date = os.date,
		},
		version = function()
			return "0.651.0.6510637"
		end,
		UserSettings = function()
			return {
				GetService = function()
					return { SavedQualityLevel = rawget(dm, "_quality") or Enum.SavedQualitySetting.Automatic }
				end,
			}
		end,
		gcinfo = function()
			return 96 * 1024
		end,
		warn = function(...)
			local parts = {}
			for _, v in { ... } do
				table.insert(parts, tostring(v))
			end
			table.insert(world.warnings, table.concat(parts, " "))
		end,
		require = function(m)
			return world:require(dm, m)
		end,
	}
	local fn = luau.load(rawget(module, "_source"), { debugName = rawget(module, "_path"), environment = env })
	local result = fn()
	cache[module] = result
	return result
end

-- The Glitchless module as a script in this DataModel requires it.
function World:glitchless(dm)
	return self:require(dm, dm.ReplicatedStorage.Glitchless)
end

-- ───────────────────────────── replication and players ─────────────────────────────

local function deepCopy(v, seen)
	if type(v) ~= "table" or typeof(v) == "Instance" or typeof(v) == "EnumItem" then
		return v
	end
	seen = seen or {}
	assert(not seen[v], "a table sent through a remote can't refer to itself")
	seen[v] = true
	local out = {}
	for k, x in v do
		assert(type(k) == "string" or type(k) == "number", "a remote can't send a table key of type " .. type(k))
		assert(type(x) ~= "function", "a remote can't send a function")
		out[k] = deepCopy(x, seen)
	end
	seen[v] = nil
	return out
end
Roblox.deepCopy = deepCopy

-- A RemoteEvent the server makes appears in every client's copy of the same place.
function World:replicate(inst)
	if inst.ClassName ~= "RemoteEvent" or not self.server or rawget(inst, "_replica") then
		return
	end
	local ok, dm = pcall(function()
		local p = inst
		while p.Parent do
			p = p.Parent
		end
		return p
	end)
	if not ok or dm ~= self.server then
		return
	end
	if not rawget(inst, "_linked") then
		rawset(inst, "_linked", true)
		inst.OnServerEvent = Signal.new(self)
		rawget(inst, "_methods").FireClient = function(_, player, ...)
			local c = self.clients[player.UserId]
			if c and c.connected then
				local replica = c.remotes[inst]
				if replica then
					self.currentDm = c.dm
					replica.OnClientEvent:Fire(table.unpack(deepCopy({ ... })))
					self.currentDm = self.server
				end
			end
		end
	end
	for _, c in self.clients do
		self:replicateTo(c, inst)
	end
end

function World:replicateTo(c, inst)
	if c.remotes[inst] then
		return
	end
	-- the same path in the client's place
	local path = string.split(inst:GetFullName(), ".")
	local parent = c.dm
	for i = 1, #path - 1 do
		parent = parent:FindFirstChild(path[i])
		if not parent then
			return
		end
	end
	local replica = Instance.new(self, "RemoteEvent")
	rawset(replica, "_replica", true)
	replica.Name = inst.Name
	replica.OnClientEvent = Signal.new(self)
	rawget(replica, "_methods").FireServer = function(_, ...)
		self.currentDm = self.server
		inst.OnServerEvent:Fire(c.serverPlayer, table.unpack(deepCopy({ ... })))
		self.currentDm = c.dm
	end
	c.remotes[inst] = replica
	replica.Parent = parent
end

local function newPlayer(world, name, displayName, userId)
	local p = Instance.new(world, "Player", {
		GetNetworkPing = function(self)
			return rawget(self, "_props").Ping
		end,
		Kick = function() end,
	})
	p.Name = name
	p.DisplayName = displayName
	p.UserId = userId
	p.Ping = 0.045
	p.CharacterAdded = Signal.new(world)
	return p
end

-- A player joins: the server's Player and PlayerAdded, and a client DataModel of their own.
function World:join(name, opts)
	opts = opts or {}
	local userId = opts.userId or self.nextUserId
	self.nextUserId += 1
	local sp = newPlayer(self, name, opts.displayName or name, userId)
	sp.Parent = self.server.Players
	local clientPlayer = newPlayer(self, name, opts.displayName or name, userId)
	local dm = self:dataModel(false, clientPlayer)
	clientPlayer.Parent = dm.Players
	-- the other players are in the client's Players too
	for _, other in self.clients do
		newPlayer(self, other.name, other.serverPlayer.DisplayName, other.serverPlayer.UserId).Parent = dm.Players
	end
	local c = { name = name, dm = dm, serverPlayer = sp, clientPlayer = clientPlayer, remotes = {}, connected = true }
	self.clients[userId] = c
	if opts.touch then
		dm.UserInputService.TouchEnabled = true
		dm.UserInputService.KeyboardEnabled = false
		dm.Workspace.CurrentCamera = { ViewportSize = { X = 844, Y = 390 } }
	end
	-- remotes that already exist
	local function each(inst)
		for _, child in rawget(inst, "_children") do
			if child.ClassName == "RemoteEvent" and rawget(child, "_linked") then
				self:replicateTo(c, child)
			end
			each(child)
		end
	end
	each(self.server)
	self.currentDm = self.server
	self.server.Players.PlayerAdded:Fire(sp)
	return c
end

-- A character for the player, with a Humanoid that can die and a root part at `pos`.
function World:spawnCharacter(c, pos)
	local model = Instance.new(self, "Model")
	model.Name = c.name
	local root = Instance.new(self, "Part")
	root.Name = "HumanoidRootPart"
	root.Position = { X = pos[1], Y = pos[2], Z = pos[3] }
	root.Parent = model
	local humanoid = Instance.new(self, "Humanoid")
	humanoid.Died = Signal.new(self)
	humanoid.Parent = model
	model.PrimaryPart = root
	model.Parent = self.server.Workspace
	c.serverPlayer.Character = model
	c.serverPlayer.CharacterAdded:Fire(model)
	return model, humanoid, root
end

function World:leave(c, reason)
	c.connected = false
	self.currentDm = self.server
	self.server.Players.PlayerRemoving:Fire(c.serverPlayer, reason or Enum.PlayerExitReason.Unknown)
	c.serverPlayer.Parent = nil
end

-- The server shuts down: BindToClose functions run (in their own threads), and the world steps until they finish.
function World:shutdown(maxSeconds)
	local closers = rawget(self.server, "_closers")
	local done = 0
	for _, fn in closers do
		self:spawn(function()
			fn()
			done += 1
		end)
	end
	local waited = 0
	while done < #closers and waited < (maxSeconds or 30) do
		self:pumpHttp()
		self.clock += 0.25
		waited += 0.25
		self:runTimers()
	end
	return done == #closers
end

-- Starts Glitchless on a client as the shipped GlitchlessClient script would.
function World:startClient(c)
	self.currentDm = c.dm
	local g = self:glitchless(c.dm)
	g.init()
	self.currentDm = self.server
	return g
end

-- A script error in a DataModel, as Roblox reports it to ScriptContext.Error.
function World:scriptError(dm, message, stack)
	self.currentDm = dm
	dm.ScriptContext.Error:Fire(message, stack, nil)
	self.currentDm = self.server
end

-- The SDK's modules by name, loaded in a fresh server DataModel: for tests of the pure ones.
function Roblox.modules(opts)
	local world = Roblox.world(opts)
	return setmetatable({ world = world }, {
		__index = function(_, name)
			return world:require(world.server, world.server.ReplicatedStorage.Glitchless[name])
		end,
	})
end

return Roblox
