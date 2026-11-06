--!nocheck
-- Property, attribute and group rules against packages/sdk/src/props.js and groups.js, and the name scrub.
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local t = require("./lib/t")
local Roblox = require("./lib/roblox")
local M = Roblox.modules()
local Words, Json = M.Words, M.Json

local fx = serde.decode("json", fs.readFile("roblox/test/fixtures/js-fixture.json"))

t.test("property values pass and drop as in the JavaScript SDK", function()
	for _, p in fx.props do
		t.eq(Words.propValue(p.value), p.sent, "value " .. p.value)
	end
end)

t.test("property keys pass and drop as in the JavaScript SDK", function()
	for _, k in fx.keys do
		t.eq(Words.propKeyProblem(k.key) == nil, k.ok, "key " .. k.key)
	end
	t.ok(Words.propKeyProblem("userid"), "Roblox's own words for a player's ID are refused too")
	t.ok(Words.propKeyProblem("display_name"), "display_name")
end)

t.test("match IDs hash as every Glitchless SDK hashes them", function()
	for _, g in fx.groups do
		t.eq(Words.hashGroupId(g.service, g.id), g.hashed, g.service .. ":" .. g.id)
	end
	t.eq(Words.validGroupId("short"), false, "too short")
	t.eq(Words.validGroupId("race 42 here"), false, "spaces")
	t.eq(Words.validGroupId("8f2c91d0-4ab7-4c1e-9a51-1b2c3d4e5f60"), true, "a JobId")
end)

t.test("numbers: whole within a million pass, fractions and big ones don't", function()
	t.eq(Words.propValue(3), 3, "3")
	t.eq(Words.propValue(-1000000), -1000000, "-1e6")
	t.eq(Words.propValue(1.5), nil, "1.5")
	t.eq(Words.propValue(1000001), nil, "1e6+1")
	t.eq(Words.propValue(true), true, "true")
	t.eq(Words.propValue(Roblox.Enum.HttpCompression.Gzip), "Gzip", "an EnumItem goes as its name")
	t.eq(Words.propValue({}), nil, "a table")
end)

t.test("attributes keep 12 by key, cut strings, keep lists of 16 and drop the rest", function()
	local attrs = { list = { "a", "b", "a", 3, true, {} }, long = string.rep("x", 80), n = 2.5, ok = true, inst = newproxy() }
	for i = 1, 14 do
		attrs["k" .. string.format("%02d", i)] = i
	end
	local out = Words.attrs(attrs)
	local count = 0
	for _ in out do
		count += 1
	end
	t.eq(count, 12, "12 attributes")
	t.eq(out.k01, 1, "first by key")
	t.eq(out.list, nil, "past the 12th by key")
	local small = Words.attrs({ list = { "a", "b", "a", 3, true, {} }, long = string.rep("x", 80) })
	t.eq(small.list, { "a", "b", 3, true }, "distinct, values only")
	t.eq(#small.long, 64, "cut to 64")
	t.eq(Json.encode(Words.attrs({ deck = {} }) or {}), "{}", "an empty list is no attribute")
end)

t.test("strings are cut by characters, never in the middle of one", function()
	local s = string.rep("é", 70)
	local cut = Words.cut(s, 64)
	t.eq(utf8.len(cut), 64, "64 characters")
	t.ok(utf8.len(cut) ~= nil, "valid UTF-8")
end)

t.test("names and user IDs are scrubbed where they stand as words", function()
	local names = { "xX_Racer_Xx", "Speedy Kid", "2840198822", "Bob" }
	local text = "Players.xX_Racer_Xx.PlayerGui.Hud:12: attempt to index nil; Workspace.Bob.Animate; key Player_2840198822; Bobby stays; Speedy Kid said hi"
	local out = Words.scrub(text, names)
	t.eq(out, "Players.<player>.PlayerGui.Hud:12: attempt to index nil; Workspace.<player>.Animate; key Player_<user>; Bobby stays; <player> said hi", "scrubbed")
	t.eq(Words.scrub("key 2840198822 lost", names), "key <user> lost", "a user ID on its own")
	t.eq(Words.scrub("Al went", { "Al" }), "Al went", "names under 3 characters are left alone")
	t.eq(Words.scrub("50% (a.b) done", { "(a.b)" }), "50% <player> done", "pattern characters in a name")
end)
