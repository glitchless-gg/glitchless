--!strict
-- Glitchless: a small DDSketch-style quantile sketch, a port of packages/sdk/src/sketch.js.
--
-- Frame times have long tails, so an average of each session's p95 means nothing. Each frame window sends this
-- log-bucketed histogram instead; the Glitchless server merges them and reads percentiles to within 2% of the true
-- value. The bucket numbers must match the JavaScript sketch exactly, or the server would merge buckets that mean
-- different things: roblox/test/sketch.test.luau checks this file against the JavaScript sketch's own output
-- (roblox/test/fixtures/js-fixture.json, written by roblox/test/make-fixtures.mjs).

local Sketch = {}
Sketch.__index = Sketch

export type Sketch = typeof(setmetatable(
	{} :: {
		a: number,
		gamma: number,
		lnGamma: number,
		bins: { [number]: number },
		n: number,
		zeros: number,
		sum: number,
		min: number,
		max: number,
	},
	Sketch
))

function Sketch.new(alpha: number?): Sketch
	local a = alpha or 0.02
	local gamma = (1 + a) / (1 - a)
	return setmetatable({
		a = a,
		gamma = gamma,
		lnGamma = math.log(gamma),
		bins = {},
		n = 0,
		zeros = 0,
		sum = 0,
		min = math.huge,
		max = -math.huge,
	}, Sketch)
end

function Sketch.index(self: Sketch, v: number): number
	return math.ceil(math.log(v) / self.lnGamma)
end

function Sketch.value(self: Sketch, i: number): number
	return 2 * self.gamma ^ i / (self.gamma + 1)
end

function Sketch.add(self: Sketch, v: number, count: number?)
	local c = count or 1
	if not (v >= 0) then
		return -- NaN and negatives, as the JavaScript sketch
	end
	if v < 1e-3 then
		self.zeros += c
	else
		local i = self:index(v)
		self.bins[i] = (self.bins[i] or 0) + c
	end
	self.n += c
	self.sum += v * c
	if v < self.min then
		self.min = v
	end
	if v > self.max then
		self.max = v
	end
end

local function sortedKeys(bins: { [number]: number }): { number }
	local keys = {}
	for k in bins do
		table.insert(keys, k)
	end
	table.sort(keys)
	return keys
end

-- The value at quantile q (0.5 is the median), or nil with no samples.
function Sketch.quantile(self: Sketch, q: number): number?
	if self.n == 0 then
		return nil
	end
	local rank = q * (self.n - 1)
	local acc = self.zeros
	if acc > rank then
		return 0
	end
	for _, k in sortedKeys(self.bins) do
		acc += self.bins[k]
		if acc > rank then
			return math.clamp(self:value(k), self.min, self.max)
		end
	end
	return self.max
end

-- The share of samples above a threshold, such as frames over budget.
function Sketch.fractionAbove(self: Sketch, threshold: number): number
	if self.n == 0 then
		return 0
	end
	local cut = self:index(threshold)
	local above = 0
	for k, c in self.bins do
		if k > cut then
			above += c
		end
	end
	return above / self.n
end

-- JavaScript's Math.round: halves go up, also for negative numbers.
local function round(v: number, digits: number): number
	local m = 10 ^ digits
	return math.floor(v * m + 0.5) / m
end
Sketch.round = round

-- What goes on the wire as frame_window.ft: {a, b, n, z, s, mn, mx}. Bucket keys are strings, as in JSON.
function Sketch.json(self: Sketch): { [string]: any }
	local b = {}
	for k, c in self.bins do
		-- math.ceil gives -0 for a value just under 1, and JavaScript writes that key "0"
		b[if k == 0 then "0" else tostring(k)] = c
	end
	return {
		a = self.a,
		b = b,
		n = self.n,
		z = self.zeros,
		s = round(self.sum, 1),
		mn = if self.n > 0 then round(self.min, 2) else nil,
		mx = if self.n > 0 then round(self.max, 2) else nil,
	}
end

return Sketch
