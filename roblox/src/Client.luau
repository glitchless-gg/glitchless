--!strict
-- Glitchless on a player's Roblox client (SPEC §5e): it measures what only the device can see and hands it to the
-- server, which sends it (a client can't make HTTP requests on Roblox).
--   - frames: each frame's time from one PreRender to the next, with what the Stats service says the frame cost
--     (render CPU and GPU time, physics, draw calls, triangles, instances) and ContentProvider's asset queue, into a
--     frame window every 5 s with its hitches (Frames.luau);
--   - the network: the round trip to the server (Player:GetNetworkPing) and the data in and out, once a second;
--   - errors from the game's LocalScripts (ScriptContext.Error), scrubbed of players' names here and again on the
--     server;
--   - the kind of device, in Roblox's own words (Computer, Phone, Tablet, Console, VR: Roblox doesn't tell a script
--     the OS), on a console which one from its controller (Xbox, PlayStation), its screen and graphics quality;
--   - the game's calls from LocalScripts (track, count, levels, deaths, properties, zones), passed on as they are;
--     calls made before the client started wait in init.luau and are made here when it starts, each at its own time.
-- Everything goes to the server over the module's RemoteEvent, once a window (or within a second of an error). While
-- the window isn't focused (alt-tabbed, a phone in the background) no frames are measured.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ScriptContext = game:GetService("ScriptContext")
local Stats = game:GetService("Stats")
local UserInputService = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")

local Json = require(script.Parent.Json)
local Words = require(script.Parent.Words)
local Errors = require(script.Parent.Errors)
local Frames = require(script.Parent.Frames)
local Session = require(script.Parent.Session)

local Client = {}
Client.__index = Client

local MAX_BUFFER = 256

local function nowMs(): number
	return math.floor(workspace:GetServerTimeNow() * 1000)
end

-- Roblox's own words for the kind of device, from what input it has and its screen (Roblox doesn't tell scripts the
-- OS). A phone and a tablet are touch with no keyboard, told apart by the screen's shorter side.
function Client.platform(): string
	local ok, vr = pcall(function()
		return game:GetService("VRService").VREnabled
	end)
	if ok and vr then
		return "VR"
	end
	local tenFoot = false
	pcall(function()
		tenFoot = GuiService:IsTenFootInterface()
	end)
	if tenFoot then
		return "Console"
	end
	if UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled then
		local camera = workspace.CurrentCamera
		local size = camera and camera.ViewportSize
		if size and math.min(size.X, size.Y) >= 600 then
			return "Tablet"
		end
		return "Phone"
	end
	return "Computer"
end

local function quality(): any
	local ok, level = pcall(function()
		return UserSettings():GetService("UserGameSettings").SavedQualityLevel
	end)
	if not ok or typeof(level) ~= "EnumItem" then
		return nil
	end
	if level.Name == "Automatic" then
		return "auto"
	end
	return level.Value
end

local function screen(): { number }?
	local camera = workspace.CurrentCamera
	if not camera then
		return nil
	end
	local s = camera.ViewportSize
	return { math.floor(s.X + 0.5), math.floor(s.Y + 0.5) }
end

function Client.start(module: Instance, options: any)
	local opts = if type(options) == "table" then options else {}
	local self = setmetatable({
		module = module,
		debug = if opts.debug ~= nil then opts.debug else RunService:IsStudio(),
		windowS = opts.windowSeconds or 5,
		warned = {},
		on = true,
		focused = true,
		skipNext = true,
		remote = nil :: RemoteEvent?,
		buffer = {} :: { any },
		lastFrameAt = nil :: number?,
		lastWindowAt = os.clock(),
		lastNetAt = 0,
		sendSoonAt = nil :: number?,
		loadSent = false,
		at = nil :: number?, -- while a call made before the client started is made again: when it was made
		chosen = nil :: boolean?, -- setEnabled before the RemoteEvent was found: told to the server once it is
		awaitingGamepad = false, -- a console said hello before its controller was connected (Client.hello)
		connections = {} :: { RBXScriptConnection },
	}, Client)
	self.warn = function(key: string, message: string)
		if self.warned[key] then
			return
		end
		self.warned[key] = true
		if self.debug then
			warn("[glitchless] " .. message)
		end
	end
	self.frames = Frames.new(nowMs)
	-- The client's counters add up here, and go as one counts event a window.
	self.counter = Session.new({
		role = "client",
		service = "",
		now = nowMs,
		sessionId = "",
		sessionType = "user",
		hashGroupIds = false,
		positions = false,
		warn = self.warn,
	})
	self:connect()
	task.spawn(function()
		local remote = module:WaitForChild("GlitchlessRemote", 60)
		if not remote then
			self.warn("remote", "Glitchless isn't running on the server: call Glitchless.init({ service = ..., clientToken = ... }) from a server Script")
			remote = module:WaitForChild("GlitchlessRemote")
		end
		self.remote = remote :: RemoteEvent
		table.insert(self.connections, (remote :: RemoteEvent).OnClientEvent:Connect(function(message)
			self:onServer(message)
		end))
		-- The camera has no size for the first frames (1×1 in Studio), and the screen tells a phone from a tablet.
		local deadline = os.clock() + 5
		while os.clock() < deadline do
			local s = screen()
			if s and s[1] > 1 and s[2] > 1 then
				break
			end
			task.wait(0.1)
		end
		self:hello()
		if self.chosen ~= nil then
			-- the player's choice, made before the RemoteEvent was found
			pcall(function()
				(self.remote :: RemoteEvent):FireServer({ op = "enabled", on = self.chosen })
			end)
		end
		self:send()
	end)
	return self
end

export type Client = typeof(Client.start(...))

-- Which console a Console is, read from its controller: Roblox gives scripts no way to tell (on purpose), but its
-- button-prompt API names the buttons of the gamepad last connected (ButtonA is "ButtonCross" on a PlayStation
-- controller), and a console's controller is its own. Only once a gamepad is connected, since before that the API
-- answers with its default names, Xbox's. Nil when it can't tell.
function Client.console(): string?
	local connected = false
	pcall(function()
		connected = #UserInputService:GetConnectedGamepads() > 0
	end)
	if not connected then
		return nil
	end
	local ok, name = pcall(function()
		return UserInputService:GetStringForKeyCode(Enum.KeyCode.ButtonA)
	end)
	if not ok then
		return nil
	end
	if name == "ButtonCross" then
		return "PlayStation"
	elseif name == "ButtonA" then
		return "Xbox"
	end
	return nil
end

function Client.hello(self: Client)
	local os = Client.platform()
	local console = if os == "Console" then Client.console() else nil
	local device = {
		os = os,
		console = console,
		browser_version = version(),
		screen = screen(),
		quality = quality(),
		touch = UserInputService.TouchEnabled,
		keyboard = UserInputService.KeyboardEnabled,
		gamepad = UserInputService.GamepadEnabled,
	}
	pcall(function()
		(self.remote :: RemoteEvent):FireServer({ op = "hello", v = 1, device = device })
	end)
	-- A console whose controller wasn't connected yet says hello again once it is (before the session's first batch,
	-- its session_start says which console; after it, the session stays a Console).
	if os == "Console" and not console and not self.awaitingGamepad then
		self.awaitingGamepad = true
		pcall(function()
			local connection
			connection = UserInputService.GamepadConnected:Connect(function()
				connection:Disconnect()
				self.awaitingGamepad = false
				self:hello()
			end)
			table.insert(self.connections, connection)
		end)
	end
end

function Client.onServer(self: Client, message: any)
	if type(message) ~= "table" then
		return
	end
	if message.op == "state" then
		local on = message.on == true
		if on ~= self.on then
			self.on = on
			self.buffer = {}
			self.frames = Frames.new(nowMs)
			self.skipNext = true
		end
	elseif message.op == "ctx" then
		-- the server changed the level, zone or a group: a window never spans two
		self:closeWindow()
	end
end

-- ───────────────────────────── measuring ─────────────────────────────

function Client.connect(self: Client)
	local c = self.connections
	local frameSignal = (RunService :: any).PreRender or RunService.RenderStepped
	table.insert(c, frameSignal:Connect(function()
		local ok, err = pcall(self.onFrame, self)
		if not ok then
			self.warn("frame", "Glitchless couldn't measure a frame: " .. tostring(err))
		end
	end))
	table.insert(c, UserInputService.WindowFocusReleased:Connect(function()
		self.focused = false
	end))
	table.insert(c, UserInputService.WindowFocused:Connect(function()
		self.focused = true
		self.skipNext = true -- the frame after coming back spans the time away
	end))
	table.insert(c, ScriptContext.Error:Connect(function(message, stack)
		pcall(self.onError, self, "script", tostring(message), tostring(stack), nil)
	end))
end

-- A Stats time, in milliseconds. Stats reports them in seconds (Studio 0.746: FrameTime 0.066, RenderCPUFrameTime
-- 0.0011, HeartbeatTime 0.0001).
function Client.statMs(self: Client, key: string): number?
	local ok, v = pcall(function()
		return (Stats :: any)[key]
	end)
	if not ok or type(v) ~= "number" or v ~= v then
		return nil
	end
	return v * 1000
end

local function stat(key: string): number?
	local ok, v = pcall(function()
		return (Stats :: any)[key]
	end)
	return if ok and type(v) == "number" then v else nil
end

function Client.onFrame(self: Client)
	local t = os.clock()
	local last = self.lastFrameAt
	self.lastFrameAt = t
	if not self.on then
		return
	end
	if last and self.focused and not self.skipNext then
		local dt = (t - last) * 1000
		local draw = stat("SceneDrawcallCount")
		local cost = {
			render_ms = self:statMs("RenderCPUFrameTime"),
			gpu_ms = self:statMs("RenderGPUFrameTime"),
			physics_ms = self:statMs("PhysicsStepTime"),
			draw_calls = if draw then draw + (stat("ShadowsDrawcallCount") or 0) + (stat("UI2DDrawcallCount") or 0) + (stat("UI3DDrawcallCount") or 0) else nil,
			triangles = stat("SceneTriangleCount"),
			instances = stat("InstanceCount"),
			assets = nil :: number?,
		}
		pcall(function()
			cost.assets = game:GetService("ContentProvider").RequestQueueSize
		end)
		self.frames:frame(dt, cost)
		if not self.loadSent and game:IsLoaded() then
			self.loadSent = true
			self:queue({ type = "load", ts = nowMs() })
		end
	end
	self.skipNext = false
	if t - self.lastNetAt >= 1 then
		self.lastNetAt = t
		self:sampleNet()
	end
	if t - self.lastWindowAt >= self.windowS then
		self:closeWindow()
	elseif self.sendSoonAt and t >= self.sendSoonAt then
		self:send()
	end
end

function Client.sampleNet(self: Client)
	local player = Players.LocalPlayer
	if not player then
		return
	end
	local ok, ping = pcall(function()
		return player:GetNetworkPing()
	end)
	local kIn, kOut = stat("DataReceiveKbps"), stat("DataSendKbps")
	self.frames:netSample(
		if ok and type(ping) == "number" then ping * 1000 else nil,
		if kIn then kIn * 8 else nil, -- Stats says kilobytes a second; the wire, kilobits
		if kOut then kOut * 8 else nil
	)
end

function Client.closeWindow(self: Client)
	self.lastWindowAt = os.clock()
	if not self.on then
		return
	end
	local heap = gcinfo() / 1024
	local memory
	pcall(function()
		memory = Stats:GetTotalMemoryUsageMb()
	end)
	local fw, hitches = self.frames:close({
		heap_mb = math.floor(heap * 10 + 0.5) / 10,
		memory_mb = if memory then math.floor(memory * 10 + 0.5) / 10 else nil,
		instances = stat("InstanceCount"),
		primitives = stat("PrimitivesCount"),
		screen = screen(),
		quality = quality(),
	})
	if fw then
		self:queue(fw)
	end
	for _, h in hitches do
		self:queue(h)
	end
	self.counter:closeWindow()
	for _, e in self.counter.queue do
		if e.type == "counts" then
			self:queue(e)
		end
	end
	self.counter.queue = {}
	self:send()
end

function Client.queue(self: Client, e: any)
	if not self.on then
		return
	end
	e.ts = e.ts or self.at or nowMs()
	if #self.buffer >= MAX_BUFFER then
		table.remove(self.buffer, 1)
	end
	table.insert(self.buffer, e)
end

-- What waits goes to the server, 64 events a message (the server takes no more).
function Client.send(self: Client)
	self.sendSoonAt = nil
	local remote = self.remote
	if not remote or not self.on or #self.buffer == 0 then
		return
	end
	local events = self.buffer
	self.buffer = {}
	for i = 1, #events, 64 do
		local part = table.move(events, i, math.min(i + 63, #events), 1, {})
		pcall(function()
			remote:FireServer({ op = "events", events = part })
		end)
	end
end

function Client.soon(self: Client)
	if not self.sendSoonAt then
		self.sendSoonAt = os.clock() + 1
	end
end

-- ───────────────────────────── errors ─────────────────────────────

function Client.names(): { string }
	local out = {}
	for _, p in Players:GetPlayers() do
		table.insert(out, p.Name)
		table.insert(out, p.DisplayName)
		table.insert(out, tostring(p.UserId))
	end
	table.sort(out, function(a, b)
		return #a > #b
	end)
	return out
end

function Client.onError(self: Client, kind: string, message: string, stack: string?, attrs: any)
	if not self.on then
		return
	end
	local names = Client.names()
	local m = Words.scrub(message, names)
	local s = if stack then Words.scrub(stack, names) else nil
	if Errors.read(m, s).own then
		return
	end
	self:queue({ type = "error", kind = kind, message = Words.cut(m, 2000), stack = if s then Words.cut(s, 4000) else nil, attrs = attrs })
	self:soon()
end

-- ───────────────────────────── the game's calls ─────────────────────────────

function Client.call(self: Client, e: any)
	self:queue(e)
end

function Client.track(self: Client, name: any, attrs: any)
	local n = Words.name(name)
	if n then
		self:call({ type = "custom", name = n, attrs = Words.attrs(attrs) })
	end
end

function Client.count(self: Client, name: any, what: any, n: any)
	if self.on then
		self.counter:count(name, what, n, self.at)
	end
end

function Client.levelStart(self: Client, level: any, attrs: any)
	local l = Words.name(level)
	if not l then
		return
	end
	self:closeWindow() -- the window before the level is the level before's
	self:call({ type = "level_start", level = l, attrs = Words.attrs(attrs) })
end

function Client.levelComplete(self: Client, level: any, info: any)
	info = if type(info) == "table" then info else {}
	self:call({ type = "level_complete", level = Words.name(level), duration_s = tonumber(info.durationS), score = tonumber(info.score) })
end

function Client.levelFail(self: Client, level: any, info: any)
	info = if type(info) == "table" then info else {}
	self:call({ type = "level_fail", level = Words.name(level), cause = Words.name(info.cause) })
end

function Client.levelAbandon(self: Client, level: any)
	self:call({ type = "level_abandon", level = Words.name(level) })
end

function Client.death(self: Client, info: any)
	info = if type(info) == "table" then info else {}
	self:call({ type = "death", cause = Words.name(info.cause) })
end

function Client.setProperties(self: Client, props: any)
	if type(props) ~= "table" then
		return
	end
	local keep, remove = {}, {}
	for k, v in props do
		if type(k) == "string" then
			if v == Json.null then
				table.insert(remove, k)
			else
				keep[k] = v
			end
		end
	end
	self:call({ type = "props", props = keep, remove = remove })
end

function Client.clearProperty(self: Client, key: string)
	self:call({ type = "props", props = {}, remove = { key } })
end

function Client.setZone(self: Client, zone: any)
	self:closeWindow()
	self:call({ type = "zone", zone = if type(zone) == "string" then zone else nil })
end

function Client.setContext(self: Client, gauges: any)
	if type(gauges) ~= "table" then
		return
	end
	for k, v in gauges do
		if type(k) == "string" and type(v) == "number" and v == v then
			self.frames:gauge(k, v)
		end
	end
end

function Client.error(self: Client, err: any, attrs: any, stack: string?)
	self:onError("manual", tostring(err), stack or debug.traceback("", 2), Words.attrs(attrs))
end

function Client.setEnabled(self: Client, on: boolean)
	if self.remote then
		pcall(function()
			(self.remote :: RemoteEvent):FireServer({ op = "enabled", on = on == true })
		end)
	else
		self.chosen = on == true
	end
	if not on then
		self.on = false
		self.buffer = {}
	end
end

function Client.isEnabled(self: Client): boolean
	return self.on
end

return Client
