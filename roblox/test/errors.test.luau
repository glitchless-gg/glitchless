--!nocheck
-- Error fingerprints against packages/sdk/src/fingerprint.js, and Roblox's error text read into fields.
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local t = require("./lib/t")
local M = require("./lib/roblox").modules()
local Errors = M.Errors

local fx = serde.decode("json", fs.readFile("roblox/test/fixtures/js-fixture.json"))

t.test("fingerprints match the JavaScript SDK's, emoji and cuts at 200 UTF-16 units included", function()
	for _, f in fx.fingerprints do
		t.eq(Errors.fingerprint(f.kind, f.message, f.fn), f.fingerprint, f.message)
		if f.normalized then
			t.eq(Errors.normalize(f.message), f.normalized, "normalized " .. f.message)
		end
	end
end)

t.test("a ScriptContext.Error message and stack read into source, line and fn", function()
	local r = Errors.read(
		"ServerScriptService.Race:42: attempt to index nil with 'Humanoid'",
		"ServerScriptService.Race, line 42 - function onTouched\nServerScriptService.Race, line 88\n"
	)
	t.eq(r.message, "attempt to index nil with 'Humanoid'", "message without its path and line")
	t.eq(r.source, "ServerScriptService.Race", "source")
	t.eq(r.line, 42, "line")
	t.eq(r.fn, "Race.onTouched", "fn is the script and the function")
	t.eq(r.own, false, "not the SDK's")
end)

t.test("the other two stack forms read the same", function()
	local a = Errors.read("boom", "Script 'Workspace.Kart.Engine', Line 7 - function rev\nScript 'Workspace.Kart.Engine', Line 12")
	t.eq({ a.source, a.line, a.fn }, { "Workspace.Kart.Engine", 7, "Engine.rev" }, "Script '…', Line n")
	local b = Errors.read("boom", "ReplicatedStorage.Shared.Util:19 function lerp\nReplicatedStorage.Shared.Util:30\n")
	t.eq({ b.source, b.line, b.fn }, { "ReplicatedStorage.Shared.Util", 19, "Util.lerp" }, "debug.traceback's")
	local c = Errors.read("ServerScriptService.Main:3: bad", "ServerScriptService.Main, line 3\n")
	t.eq(c.fn, "Main", "a script's top level is the script's name")
end)

t.test("frames inside Glitchless are passed over, and an error raised in it is the SDK's own", function()
	local r = Errors.read(
		"ReplicatedStorage.Glitchless.Session:120: oops",
		"ReplicatedStorage.Glitchless.Session, line 120 - function push\nServerScriptService.Race, line 9 - function lap\n"
	)
	t.eq(r.own, true, "own")
	t.eq(r.fn, "Race.lap", "the game's frame names the issue")
	local g = Errors.read("ServerScriptService.GlitchlessStats:5: mine", "ServerScriptService.GlitchlessStats, line 5\n")
	t.eq(g.own, false, "a game script whose name starts with Glitchless is the game's")
end)

t.test("an error's message moves line without becoming a new issue", function()
	local a = Errors.read("ServerScriptService.Race:42: attempt to call a nil value", "ServerScriptService.Race, line 42 - function lap\n")
	local b = Errors.read("ServerScriptService.Race:57: attempt to call a nil value", "ServerScriptService.Race, line 57 - function lap\n")
	t.eq(Errors.fingerprint("script", a.message, a.fn), Errors.fingerprint("script", b.message, b.fn), "same fingerprint")
end)
