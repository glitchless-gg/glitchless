--!nocheck
local serde = require("@lune/serde")
local t = require("./lib/t")
local M = require("./lib/roblox").modules()
local Json = M.Json

t.test("objects, lists, empty ones, null and numbers", function()
	t.eq(Json.encode({ b = {}, a = Json.array({}), n = Json.null, x = 1, y = 0.1, z = 1793000000123, w = -2.5 }), '{"a":[],"b":{},"n":null,"w":-2.5,"x":1,"y":0.1,"z":1793000000123}', "encoded")
	t.eq(Json.encode({ 1, 2, 3 }), "[1,2,3]", "a list")
	t.eq(Json.encode({ ["-3"] = 1, ["175"] = 2 }), '{"-3":1,"175":2}', "sketch buckets are an object")
	t.eq(Json.encode({ v = 0 / 0, i = math.huge }), '{"i":null,"v":null}', "NaN and inf are null")
end)

t.test("strings escape quotes, backslashes and control characters, and keep UTF-8", function()
	local s = 'a "q" \\ \n\t\1 é 🐶'
	local text = Json.encode({ s = s })
	t.eq(serde.decode("json", text).s, s, "round trip through a real JSON reader")
end)

t.test("decode reads /v1/health's answer", function()
	local d = Json.decode('{"ok":true,"features":["counts","props","server_mode"],"uptime_s":12.5,"x":null}')
	t.eq(d.ok, true, "ok")
	t.eq(d.features[3], "server_mode", "features")
	t.eq(d.uptime_s, 12.5, "number")
	t.eq(Json.decode("not json"), nil, "junk")
end)
