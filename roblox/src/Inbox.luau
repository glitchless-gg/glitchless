--!strict
-- Glitchless: what the server takes from a player's client (SPEC §5e).
--
-- A client can't make HTTP requests on Roblox, so it sends what it measured (frame windows, hitches, its errors, the
-- kind of device) and the game's calls from LocalScripts to the server over a RemoteEvent. Anyone can fire a
-- RemoteEvent with anything (an exploiter's client too), so nothing from it is taken as it came: every message is
-- rebuilt here from the fields its type has, each checked for its type and range, and the rest dropped. What a lying
-- client can do is spoil its own session's numbers, within these limits; it can't reach anyone else's session, set a
-- match, or send more than the server lets it (Server.luau rate-limits each player).
-- Pure Luau; roblox/test/inbox.test.luau throws junk at it.

local Json = require(script.Parent.Json)
local Words = require(script.Parent.Words)

local Inbox = {}

Inbox.MAX_EVENTS = 64 -- events a message

local function num(v: any, lo: number, hi: number): number?
	if type(v) ~= "number" or v ~= v or v < lo or v > hi then
		return nil
	end
	return v
end

local function int(v: any, lo: number, hi: number): number?
	local n = num(v, lo, hi)
	if n == nil or n ~= math.floor(n) then
		return nil
	end
	return n
end

local function str(v: any, max: number): string?
	if type(v) ~= "string" or v == "" then
		return nil
	end
	return Words.cut(v, max)
end

local MS = 600000 -- the longest time a frame field may claim (10 minutes)

-- A sketch as the client's Sketch.json wrote it, at the accuracy `a`. Its count is recounted from its buckets.
function Inbox.sketch(v: any, a: number): any
	if type(v) ~= "table" or v.a ~= a or type(v.b) ~= "table" then
		return nil
	end
	local b = {}
	local n = 0
	local buckets = 0
	for k, c in v.b do
		local i = tonumber(k)
		local count = int(c, 1, 1000000)
		if i and i == math.floor(i) and i >= -2000 and i <= 2000 and count then
			buckets += 1
			if buckets > 512 then
				return nil
			end
			local key = if i == 0 then "0" else tostring(i) -- never "-0"
			b[key] = (b[key] or 0) + count
			n += count
		end
	end
	local z = int(v.z, 0, 1000000) or 0
	n += z
	if n == 0 then
		return nil
	end
	return { a = a, b = b, n = n, z = z, s = num(v.s, 0, 1e9) or 0, mn = num(v.mn, 0, MS), mx = num(v.mx, 0, MS) }
end

-- Numeric gauges (setContext, and the instance count): 16 of them, keys as property keys are.
function Inbox.gauges(v: any): { [string]: number }
	local out = {}
	if type(v) ~= "table" then
		return out
	end
	local n = 0
	for k, g in v do
		if n >= 16 then
			break
		end
		if type(k) == "string" and string.find(k, "^[%a_][%w_]*$") and #k <= 32 then
			local x = num(g, -1e9, 1e9)
			if x then
				out[k] = x
				n += 1
			end
		end
	end
	return out
end

local CAUSES = { asset_load = true, object_spawn = true, physics = true, render = true, script = true, frozen = true }

local function net(v: any): any
	if type(v) ~= "table" then
		return nil
	end
	local out: { [string]: any } = {
		samples = int(v.samples, 0, 1000) or 0,
		transport = "roblox",
		host = false,
	}
	if out.samples > 0 then
		out.rtt = Inbox.sketch(v.rtt, 0.05)
	end
	for _, k in { "rtt_p50", "rtt_p95", "rtt_max", "jitter_ms" } do
		out[k] = num(v[k], 0, MS)
	end
	for _, k in { "in_kbps", "out_kbps" } do
		out[k] = num(v[k], 0, 1e6)
	end
	return out
end

local function frameWindow(e: any): any
	local ft = Inbox.sketch(e.ft, 0.02)
	local frames = int(e.frames, 1, 100000)
	if not ft or not frames then
		return nil
	end
	local out: { [string]: any } = { type = "frame_window", frames = frames, ft = ft }
	for k, range in {
		fps = 1000, hz = 1000, budget_ms = 1000, duration_s = 600,
		ft_p50 = MS, ft_p95 = MS, ft_p99 = MS, ft_max = MS,
		render_ms = MS, gpu_ms = MS, physics_ms = MS,
		draw_calls = 1e7, draw_calls_max = 1e7, triangles = 1e10,
		heap_mb = 1e6, memory_mb = 1e6, instances = 1e9, primitives = 1e9,
	} do
		out[k] = num(e[k], 0, range)
	end
	for _, k in { "slow", "jank", "hitches", "frozen" } do
		out[k] = int(e[k], 0, frames)
	end
	if type(e.screen) == "table" then
		local w, h = int(e.screen[1], 0, 20000), int(e.screen[2], 0, 20000)
		if w and h then
			out.screen = { w, h }
		end
	end
	out.quality = if e.quality == "auto" then "auto" else int(e.quality, 0, 21)
	out.ctx = Inbox.gauges(e.ctx)
	out.net = net(e.net)
	return out
end

local function hitch(e: any): any
	local d = num(e.duration_ms, 0, MS)
	if not d then
		return nil
	end
	local causes = Json.array({})
	if type(e.causes) == "table" then
		for _, c in e.causes do
			if type(c) == "string" and CAUSES[c] and not table.find(causes, c) then
				table.insert(causes, c)
			end
		end
	end
	local out: { [string]: any } = {
		type = "hitch",
		duration_ms = d,
		frozen = e.frozen == true,
		causes = causes,
		ctx = Inbox.gauges(e.ctx),
		loaf = Json.array({}),
	}
	for k, range in { render_ms = MS, gpu_ms = MS, physics_ms = MS, draw_calls = 1e7, triangles = 1e10, instances_added = 1e9, assets_queued = 1e7 } do
		out[k] = num(e[k], 0, range)
	end
	return out
end

local function countsEvent(e: any): any
	if type(e.counts) ~= "table" then
		return nil
	end
	local list = Json.array({})
	for _, c in e.counts do
		if #list >= 128 then
			break
		end
		if type(c) == "table" then
			local name = Words.name(c.name)
			local n = int(c.n, 1, 1e9)
			if name and n then
				local attrs = {}
				local ka = 0
				if type(c.attrs) == "table" then
					for k, v in c.attrs do
						if ka < 4 and type(k) == "string" and (type(v) == "string" or type(v) == "boolean") then
							attrs[Words.cut(k, 64)] = if type(v) == "string" then Words.cut(v, 64) else v
							ka += 1
						end
					end
				end
				local entry: { [string]: any } = { name = name, attrs = attrs, n = n, first_ts = num(c.first_ts, 0, 1e14) }
				if type(c.sums) == "table" then
					local sums = {}
					local ks = 0
					for k, v in c.sums do
						local x = num(v, -1e12, 1e12)
						if ks < 4 and type(k) == "string" and x then
							sums[Words.cut(k, 64)] = x
							ks += 1
						end
					end
					if ks > 0 then
						entry.sums = sums
					end
				end
				table.insert(list, entry)
			end
		end
	end
	local dropped = int(e.dropped, 0, 1e9) or 0
	if #list == 0 and dropped == 0 then
		return nil
	end
	return { type = "counts", counts = list, dropped = dropped, duration_s = num(e.duration_s, 0, 600) }
end

-- One event from a client, rebuilt, or nil. The game's calls (track, levels, deaths, properties, zones) come back as
-- they are to be applied to the session; what the client measured comes back as the event to queue.
function Inbox.event(e: any): any
	if type(e) ~= "table" or type(e.type) ~= "string" then
		return nil
	end
	local ts = num(e.ts, 0, 1e14)
	local t = e.type
	local out: any
	if t == "frame_window" then
		out = frameWindow(e)
	elseif t == "hitch" then
		out = hitch(e)
	elseif t == "counts" then
		out = countsEvent(e)
	elseif t == "load" then
		out = { type = "load" }
	elseif t == "error" then
		local message = str(e.message, 2000)
		if message then
			out = {
				type = "error",
				kind = if e.kind == "manual" then "manual" else "script",
				message = message,
				stack = str(e.stack, 4000),
				attrs = Words.attrs(e.attrs),
			}
		end
	elseif t == "custom" then
		local name = Words.name(e.name)
		if name then
			out = { type = "custom", name = name, attrs = Words.attrs(e.attrs) }
		end
	elseif t == "level_start" or t == "level_complete" or t == "level_fail" or t == "level_abandon" then
		local level = Words.name(e.level)
		-- a start names its level; an outcome without one is for the level going
		if level or t ~= "level_start" then
			out = {
				type = t,
				level = level,
				attrs = if t == "level_start" then Words.attrs(e.attrs) else nil,
				duration_s = if t == "level_complete" then num(e.duration_s, 0, 1e7) else nil,
				score = if t == "level_complete" then num(e.score, -1e12, 1e12) else nil,
				cause = if t == "level_fail" then Words.name(e.cause) else nil,
			}
		end
	elseif t == "death" then
		out = { type = "death", cause = Words.name(e.cause) }
	elseif t == "props" then
		if type(e.props) == "table" or type(e.remove) == "table" then
			local props = {}
			local n = 0
			for k, v in (if type(e.props) == "table" then e.props else {}) do
				if n < 24 and type(k) == "string" then
					props[k] = v
					n += 1
				end
			end
			local remove = {}
			for _, k in (if type(e.remove) == "table" then e.remove else {}) do
				if #remove < 24 and type(k) == "string" then
					table.insert(remove, k)
				end
			end
			out = { type = "props", props = props, remove = remove }
		end
	elseif t == "zone" then
		out = { type = "zone", zone = if type(e.zone) == "string" then Words.cut(e.zone, 64) else nil }
	end
	if out then
		out.ts = ts
	end
	return out
end

-- The kind of device the client says it is (the client's hello). Only Roblox's own words for platforms pass.
local OS = { Computer = true, Phone = true, Tablet = true, Console = true, VR = true }
function Inbox.device(d: any): { [string]: any }
	local out: { [string]: any } = { browser = "Roblox" }
	if type(d) ~= "table" then
		return out
	end
	out.os = if OS[d.os] then d.os else nil
	out.mobile = out.os == "Phone" or out.os == "Tablet"
	out.browser_version = if type(d.browser_version) == "string" and string.find(d.browser_version, "^[%d%.]+$") then Words.cut(d.browser_version, 32) else nil
	if type(d.screen) == "table" then
		local w, h = int(d.screen[1], 0, 20000), int(d.screen[2], 0, 20000)
		if w and h then
			out.screen = { w, h }
		end
	end
	out.quality = if d.quality == "auto" then "auto" else int(d.quality, 0, 21)
	out.touch = if type(d.touch) == "boolean" then d.touch else nil
	out.gamepad = if type(d.gamepad) == "boolean" then d.gamepad else nil
	out.keyboard = if type(d.keyboard) == "boolean" then d.keyboard else nil
	out.vr = if type(d.vr) == "boolean" then d.vr else nil
	out.dpr = nil
	return out
end

return Inbox
