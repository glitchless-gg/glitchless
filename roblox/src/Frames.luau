--!strict
-- Glitchless: a player's frames, measured on their device (SPEC §2 frame_window, hitch; §5e).
--
-- The client calls `frame` once a frame with the frame's time and what Roblox's Stats service said about it, and
-- `close` every window (5 s, or when the level, zone or a group changes). A window is a frame_window event: the
-- frame times as a sketch the server merges, percentiles, slow and janky frames, and averages of what Stats reports
-- (render and GPU time, physics, draw calls, triangles). A hitch is one frame over 50 ms and twice what this device
-- usually takes, with the likely causes from what that frame measured:
--   asset_load    ContentProvider still had assets to load (a mesh, texture or sound streaming in)
--   object_spawn  500+ instances appeared in the frame (a model cloned or a map loaded at once)
--   physics       the physics step took 40% of the frame
--   render        the render CPU or GPU time took 40% of the frame
--   script        none of those, and render, GPU and physics together are under max(16 ms, 40% of the frame): the
--                 time went to Luau (the game's scripts) or the engine's other main-thread work
--   frozen        over 700 ms
-- Pure Luau; roblox/test/frames.test.luau drives it.

local Json = require(script.Parent.Json)
local Sketch = require(script.Parent.Sketch)

local Frames = {}
Frames.__index = Frames

local HITCH_MS = 50 -- one frame over 50 ms is a stutter a player sees
local JANK_MS = 33.4 -- two missed 60 Hz frames
local FROZEN_MS = 700 -- Android vitals' "frozen frame"
local GAP_MS = 5000 -- a frame this long is a pause (a breakpoint, a laptop lid), not a frame
local MAX_HITCHES_PER_WINDOW = 3 -- frame_window.hitches still counts every one
local SPAWN_BURST = 500
local RING = 240
local RATES = { 30, 60, 75, 90, 100, 120, 144, 165, 240 }
local NET_MIN_GAP_MS = 900

export type Cost = {
	render_ms: number?,
	gpu_ms: number?,
	physics_ms: number?,
	draw_calls: number?,
	triangles: number?,
	instances: number?,
	assets: number?,
}

local function round(v: number?, d: number): number?
	if v == nil or v ~= v then
		return nil
	end
	return Sketch.round(v, d)
end

function Frames.new(now: () -> number)
	local self = setmetatable({
		now = now,
		hz = 60,
		budgetMs = 1000 / 60,
		rateFrames = {} :: { number },
		ring = table.create(RING, 0),
		ringIdx = 0,
		ringCount = 0,
		recentMedian = 16.7,
		frameId = 0,
		pendingLong = nil :: any,
		throttled = false,
		lastInstances = nil :: number?,
		ctx = {} :: { [string]: number },
		win = nil :: any,
		net = nil :: any,
		connected = false,
		lastRtt = nil :: number?,
		lastNetAt = -math.huge,
		pending = {} :: { any }, -- hitches waiting for the window to close
		firstFrameAt = nil :: number?,
	}, Frames)
	self.win = self:newWindow()
	return self
end

export type Frames = typeof(Frames.new(...))

function Frames.newWindow(self: Frames)
	return {
		startedAt = self.now(),
		frames = 0,
		sketch = Sketch.new(),
		max = 0,
		slow = 0,
		jank = 0,
		hitches = 0,
		frozen = 0,
		sums = {} :: { [string]: number },
		counts = {} :: { [string]: number },
		drawMax = nil :: number?,
		ctx = {} :: { [string]: number },
	}
end

local function median(xs: { number }): number
	local s = table.clone(xs)
	table.sort(s)
	return s[math.floor(#s / 2) + 1] or 16.7
end

local function quantile(xs: { number }, q: number): number
	local s = table.clone(xs)
	table.sort(s)
	return s[math.clamp(math.floor(q * #s) + 1, 1, #s)]
end

-- The screen's rate (60 Hz, or the 120/144/240 a player's frame-rate cap allows) sets the frame budget. A frame can
-- take longer than the screen's interval but never less, so the fast frames tell the rate: a first guess after 30
-- frames, the answer at 120, then a look every 480 frames that only ever goes faster.
function Frames.setBudget(self: Frames, typicalDt: number, onlyFaster: boolean)
	local rate = 1000 / typicalDt
	local best = 60
	for _, r in RATES do
		if math.abs(r - rate) < math.abs(best - rate) then
			best = r
		end
	end
	if onlyFaster and best <= self.hz then
		return
	end
	self.hz = best
	self.budgetMs = 1000 / best
end

-- A frame took `dt` ms; `cost` is what Stats said about it (each field in ms or a count, nil when unread).
function Frames.frame(self: Frames, dt: number, cost: Cost?)
	local c: Cost = cost or {}
	if dt >= GAP_MS then
		self.pendingLong = nil
	elseif dt > FROZEN_MS then
		-- One long frame is a freeze; a run of them is a throttled game (in the background, a phone saving power),
		-- which no player sees.
		if self.pendingLong or self.throttled then
			self.pendingLong = nil
			self.throttled = true
		else
			self.pendingLong = { dt = dt, cost = c }
		end
	else
		if self.pendingLong then
			self:onFrame(self.pendingLong.dt, self.pendingLong.cost)
		end
		self.pendingLong = nil
		self.throttled = false
		self:onFrame(dt, c)
	end
	if dt > 3.5 and dt < 100 then
		table.insert(self.rateFrames, dt)
		local n = #self.rateFrames
		if n == 30 or n == 120 or n == 600 then
			self:setBudget(quantile(self.rateFrames, 0.2), n == 600)
		end
		if n >= 600 then
			self.rateFrames = table.move(self.rateFrames, 481, n, 1, {})
		end
	end
end

local AVERAGED = { "render_ms", "gpu_ms", "physics_ms", "draw_calls", "triangles" }

function Frames.onFrame(self: Frames, dt: number, c: Cost)
	local w = self.win
	self.frameId += 1
	w.frames += 1
	w.sketch:add(dt)
	w.max = math.max(w.max, dt)
	if dt > self.budgetMs * 1.5 then
		w.slow += 1
	end
	if dt > JANK_MS then
		w.jank += 1
	end
	if dt > FROZEN_MS then
		w.frozen += 1
	end
	for _, k in AVERAGED do
		local v = (c :: any)[k]
		if type(v) == "number" and v == v then
			w.sums[k] = (w.sums[k] or 0) + v
			w.counts[k] = (w.counts[k] or 0) + 1
		end
	end
	if c.draw_calls then
		w.drawMax = math.max(w.drawMax or 0, c.draw_calls)
	end
	local added = 0
	if c.instances then
		if self.lastInstances then
			added = c.instances - self.lastInstances
		end
		self.lastInstances = c.instances
		w.ctx.instances = math.max(w.ctx.instances or 0, c.instances)
	end
	self.ringIdx = self.ringIdx % RING + 1
	self.ring[self.ringIdx] = dt
	self.ringCount = math.min(self.ringCount + 1, RING)
	if not self.firstFrameAt then
		self.firstFrameAt = self.now()
	end
	if self.frameId % 16 == 0 and self.ringCount >= 30 then
		local last = {}
		for i = 0, math.min(60, self.ringCount) - 1 do
			table.insert(last, self.ring[(self.ringIdx - i - 1) % RING + 1])
		end
		self.recentMedian = median(last)
	end
	-- A hitch is a stutter: over 50 ms and well above what this device usually does. A device that is slow all the
	-- time shows in the percentiles instead.
	if dt > HITCH_MS and dt > 2 * self.recentMedian then
		w.hitches += 1
		local causes = Frames.causes(dt, c, added)
		local ctx = table.clone(self.ctx)
		if c.instances then
			ctx.instances = c.instances
		end
		table.insert(self.pending, {
			type = "hitch",
			ts = self.now(),
			duration_ms = round(dt, 1),
			frozen = dt > FROZEN_MS,
			causes = causes,
			render_ms = round(c.render_ms, 1),
			gpu_ms = round(c.gpu_ms, 1),
			physics_ms = round(c.physics_ms, 1),
			draw_calls = c.draw_calls,
			triangles = c.triangles,
			instances_added = if added > 0 then added else 0,
			assets_queued = c.assets,
			ctx = ctx,
			loaf = Json.array({}),
		})
	end
end

-- Likely causes of one long frame, from what that frame measured.
function Frames.causes(dt: number, c: Cost, added: number): { string }
	local out = Json.array({})
	local share = math.max(16, dt * 0.4)
	if (c.assets or 0) > 0 then
		table.insert(out, "asset_load")
	end
	if added >= SPAWN_BURST then
		table.insert(out, "object_spawn")
	end
	if (c.physics_ms or 0) >= share then
		table.insert(out, "physics")
	end
	if (c.render_ms or 0) >= share or (c.gpu_ms or 0) >= share then
		table.insert(out, "render")
	end
	if #out == 0 and c.render_ms ~= nil and (c.render_ms or 0) + (c.gpu_ms or 0) + (c.physics_ms or 0) < share then
		table.insert(out, "script")
	end
	if dt > FROZEN_MS then
		table.insert(out, "frozen")
	end
	return out
end

-- A game gauge (setContext): the highest value in the window goes in its ctx, the last in hitches'.
function Frames.gauge(self: Frames, key: string, v: number)
	self.ctx[key] = v
	self.win.ctx[key] = math.max(self.win.ctx[key] or v, v)
end

-- ───────────────────────────── the network ─────────────────────────────

-- The player's round trip to the server (Player:GetNetworkPing), and what Stats says goes in and out, once a second.
function Frames.netSample(self: Frames, rttMs: number?, inKbps: number?, outKbps: number?)
	local t = self.now()
	if t - self.lastNetAt < NET_MIN_GAP_MS then
		return
	end
	self.lastNetAt = t
	self.connected = true
	local n = self.net
	if not n then
		n = { rtt = Sketch.new(0.05), samples = 0, max = 0, jitter = 0, jitterN = 0, inSum = 0, outSum = 0, kbpsN = 0 }
		self.net = n
	end
	if rttMs and rttMs == rttMs and rttMs >= 0 then
		n.rtt:add(rttMs)
		n.samples += 1
		n.max = math.max(n.max, rttMs)
		if self.lastRtt then
			n.jitter += math.abs(rttMs - self.lastRtt)
			n.jitterN += 1
		end
		self.lastRtt = rttMs
	end
	if inKbps and outKbps then
		n.inSum += inKbps
		n.outSum += outKbps
		n.kbpsN += 1
	end
end

function Frames.netJson(self: Frames): any
	if not self.connected then
		return nil
	end
	local n = self.net
	self.net = nil
	if not n then
		-- connected through a window with no sample (a level start closed it within the second)
		return { samples = 0, transport = "roblox", host = false }
	end
	return {
		rtt = n.rtt:json(),
		rtt_p50 = round(n.rtt:quantile(0.5), 1),
		rtt_p95 = round(n.rtt:quantile(0.95), 1),
		rtt_max = round(if n.samples > 0 then n.max else nil, 1),
		jitter_ms = if n.jitterN > 0 then round(n.jitter / n.jitterN, 1) else nil,
		in_kbps = if n.kbpsN > 0 then round(n.inSum / n.kbpsN, 1) else nil,
		out_kbps = if n.kbpsN > 0 then round(n.outSum / n.kbpsN, 1) else nil,
		samples = n.samples,
		transport = "roblox",
		host = false,
	}
end

-- ───────────────────────────── the window ─────────────────────────────

-- Closes the window. Returns the frame_window (nil when it had no frames) and its hitches, the longest 3. `extra`
-- adds fields read when the window closes (memory, instances, the screen).
function Frames.close(self: Frames, extra: { [string]: any }?): (any, { any })
	local w = self.win
	local t = self.now()
	self.win = self:newWindow()
	local net = self:netJson()
	local hitches = self.pending
	self.pending = {}
	table.sort(hitches, function(a, b)
		return a.duration_ms > b.duration_ms
	end)
	while #hitches > MAX_HITCHES_PER_WINDOW do
		table.remove(hitches)
	end
	if w.frames == 0 then
		-- no frames (a window closed as it began): its gauges carry into the next one
		for k, v in w.ctx do
			self.win.ctx[k] = math.max(self.win.ctx[k] or v, v)
		end
		return nil, hitches
	end
	local secs = math.max((t - w.startedAt) / 1000, 0.001)
	local s = w.sketch
	local function avg(k: string, d: number): number?
		local n = w.counts[k]
		return if n and n > 0 then round(w.sums[k] / n, d) else nil
	end
	local fw: { [string]: any } = {
		type = "frame_window",
		ts = w.startedAt,
		duration_s = round(secs, 2),
		frames = w.frames,
		fps = round(w.frames / secs, 1),
		hz = self.hz,
		budget_ms = round(self.budgetMs, 2),
		ft = s:json(),
		ft_p50 = round(s:quantile(0.5), 2),
		ft_p95 = round(s:quantile(0.95), 2),
		ft_p99 = round(s:quantile(0.99), 2),
		ft_max = round(w.max, 1),
		slow = w.slow,
		jank = w.jank,
		hitches = w.hitches,
		frozen = w.frozen,
		render_ms = avg("render_ms", 2),
		gpu_ms = avg("gpu_ms", 2),
		physics_ms = avg("physics_ms", 2),
		draw_calls = avg("draw_calls", 0),
		draw_calls_max = w.drawMax,
		triangles = avg("triangles", 0),
		ctx = w.ctx,
		net = net,
	}
	for k, v in extra or {} do
		fw[k] = v
	end
	return fw, hitches
end

return Frames
