--!strict
-- Glitchless: the Roblox server's own frames, as server_window events (SPEC §2 server_window, §5e).
--
-- A Roblox game server runs its world at 60 frames a second and gives scripts no tick time of their own to read, so
-- a tick here is one of the server's frames, timed from one Heartbeat to the next: when the server has more to do
-- than fits in 1/60 s, its frames stretch and everything it simulates and sends lags for every player at once. A
-- tick is late when it took over 1.5 slots (25 ms, `budget_ms`), as a frame window's slow frames are. Every 5 s a
-- window: ticks as a sketch at 2%, the rate reached, the players connected, the server's memory, the data it sent
-- and received, and the players' round trips as the server sees them.
-- Pure Luau; roblox/test/ticks.test.luau drives it.

local Sketch = require(script.Parent.Sketch)

local Ticks = {}
Ticks.__index = Ticks

Ticks.TARGET_HZ = 60
Ticks.BUDGET_MS = 1000 / 60 * 1.5

local function round(v: number?, d: number): number?
	if v == nil or v ~= v then
		return nil
	end
	return Sketch.round(v, d)
end

function Ticks.new(now: () -> number)
	local self = setmetatable({ now = now, win = nil :: any }, Ticks)
	self.win = self:newWindow()
	return self
end

export type Ticks = typeof(Ticks.new(...))

function Ticks.newWindow(self: Ticks)
	return {
		startedAt = self.now(),
		ticks = 0,
		sketch = Sketch.new(0.02),
		max = 0,
		late = 0,
		playersMax = 0,
		rtt = Sketch.new(0.05),
		sums = {} :: { [string]: number },
		counts = {} :: { [string]: number },
		ctx = {} :: { [string]: number },
	}
end

-- One server frame took `ms`. `heartbeatMs` and `physicsMs` are what Stats said the frame's work took.
function Ticks.tick(self: Ticks, ms: number, heartbeatMs: number?, physicsMs: number?)
	if not (ms >= 0) or ms >= 5000 then
		return -- a pause (the Studio debugger), not a tick
	end
	local w = self.win
	w.ticks += 1
	w.sketch:add(ms)
	w.max = math.max(w.max, ms)
	if ms > Ticks.BUDGET_MS then
		w.late += 1
	end
	for k, v in { heartbeat_ms = heartbeatMs, physics_ms = physicsMs } do
		if type(v) == "number" and v == v then
			w.sums[k] = (w.sums[k] or 0) + v
			w.counts[k] = (w.counts[k] or 0) + 1
		end
	end
end

-- The players connected now (each second).
function Ticks.players(self: Ticks, n: number)
	self.win.playersMax = math.max(self.win.playersMax, n)
end

-- A player's round trip as the server sees it.
function Ticks.playerPing(self: Ticks, ms: number)
	if ms == ms and ms >= 0 then
		self.win.rtt:add(ms)
	end
end

function Ticks.gauge(self: Ticks, key: string, v: number)
	self.win.ctx[key] = math.max(self.win.ctx[key] or v, v)
end

-- Closes the window: a server_window event. `now` holds what is read as it closes (players, memory, kbps).
function Ticks.close(self: Ticks, now: { players: number?, mem_mb: number?, in_kbps: number?, out_kbps: number? }): any
	local w = self.win
	local t = self.now()
	self.win = self:newWindow()
	local secs = math.max((t - w.startedAt) / 1000, 0.001)
	local s = w.sketch
	local function avg(k: string): number?
		local n = w.counts[k]
		return if n and n > 0 then round(w.sums[k] / n, 2) else nil
	end
	return {
		type = "server_window",
		ts = w.startedAt,
		duration_s = round(secs, 2),
		ticks = w.ticks,
		tick_hz = round(w.ticks / secs, 1),
		tick = s:json(),
		tick_p50 = round(s:quantile(0.5), 2),
		tick_p95 = round(s:quantile(0.95), 2),
		tick_max = round(w.max, 1),
		late = w.late,
		budget_ms = round(Ticks.BUDGET_MS, 2),
		tick_source = "heartbeat",
		heartbeat_ms = avg("heartbeat_ms"),
		physics_ms = avg("physics_ms"),
		players = now.players,
		players_max = math.max(w.playersMax, now.players or 0),
		net_objects = nil,
		in_kbps = round(now.in_kbps, 1),
		out_kbps = round(now.out_kbps, 1),
		cpu_pct = nil, -- Roblox doesn't tell a server's scripts its CPU time
		mem_mb = round(now.mem_mb, 1),
		rtt_p95 = round(w.rtt:quantile(0.95), 1),
		ctx = w.ctx,
	}
end

return Ticks
