--!nocheck
-- The Luau sketch against the JavaScript one (fixtures/js-fixture.json, from make-fixtures.mjs): the same buckets for
-- the same frame times, so the server merges a Roblox player's windows with everyone else's.
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local t = require("./lib/t")
local M = require("./lib/roblox").modules()
local Sketch = M.Sketch

local fx = serde.decode("json", fs.readFile("roblox/test/fixtures/js-fixture.json"))

t.test("bucket indexes match the JavaScript sketch's", function()
	local sk = Sketch.new()
	for _, pair in fx.indexes do
		t.eq(sk:index(pair[1]), pair[2], "index of " .. pair[1])
	end
end)

t.test("the same frame times make the same sketch, byte for byte", function()
	local sk = Sketch.new()
	for _, v in fx.values do
		sk:add(v)
	end
	local j = sk:json()
	t.eq(j.b, fx.sketch.b, "buckets")
	t.eq(j.n, fx.sketch.n, "n")
	t.eq(j.z, fx.sketch.z, "zeros")
	t.eq(j.s, fx.sketch.s, "sum")
	t.eq(j.mn, fx.sketch.mn, "min")
	t.eq(j.mx, fx.sketch.mx, "max")
	t.eq(j.a, 0.02, "accuracy")
end)

t.test("quantiles and the share over a budget match", function()
	local sk = Sketch.new()
	for _, v in fx.values do
		sk:add(v)
	end
	for q, want in fx.quantiles do
		t.near(sk:quantile(tonumber(q)), want, 1e-9, "q" .. q)
	end
	t.near(sk:fractionAbove(19.17), fx.fraction_above_19_17, 1e-12, "fraction above 19.17")
end)

t.test("a round-trip sketch at 5% matches too", function()
	local sk = Sketch.new(0.05)
	for _, v in { 38, 41, 40, 39, 120, 44, 43, 0.5, 0.99, 1000 } do
		sk:add(v)
	end
	t.eq(sk:json(), fx.rtt, "rtt sketch")
end)

t.test("an empty sketch has no quantile and writes no min or max", function()
	local sk = Sketch.new()
	t.eq(sk:quantile(0.5), nil, "quantile")
	local j = sk:json()
	t.eq(j.mn, nil, "mn")
	t.eq(j.n, 0, "n")
end)
