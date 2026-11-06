--!nocheck
-- A race in the fake Roblox, sent over real HTTP to a Glitchless server: `lune run roblox/test/e2e <intake> [capture.json]`.
-- roblox/test/e2e.mjs starts that server, runs this, and reads the results back through the query API. With a second
-- argument, every batch is also written there as it went (for server/test/fixtures/sdk-payloads/roblox.json).
local fs = require("@lune/fs")
local process = require("@lune/process")
local serde = require("@lune/serde")
local Roblox = require("./lib/roblox")

local intake = assert(process.args[1], "usage: lune run roblox/test/e2e <intake> [capture.json]")
local capture = process.args[2]

-- Virtual time that starts two minutes ago, so the race's events are recent and none is in the future.
local world = Roblox.world({ realHttp = true, epoch = math.floor(os.time() * 1000) - 120000 })
local sent = {}
local real = world.realRequest
world.realRequest = function(self, req)
	if req.Body and string.find(req.Url, "/v1/intake", 1, true) then
		table.insert(sent, req.Body) -- as sent: decoding and writing it again would turn an empty [] into {}
	end
	return real(self, req)
end

local G = world:glitchless(world.server)
G.init({
	service = "roblox-e2e",
	clientToken = "gl_pub_dev",
	intake = intake,
	version = "1.0.0",
	env = "dev",
	positions = true,
	region = "us-east",
	properties = { mode = "ranked" },
})

local racers = {}
for i, name in { "xX_Racer_Xx", "Pocket", "Third" } do
	local c = world:join(name, { touch = name == "Pocket", userId = 2840198820 + i })
	world:startClient(c)
	world:spawnCharacter(c, { i * 10, 4, 0 })
	table.insert(racers, c)
end
world:run(3)
local raceId = "race-2026-11-06-0042"
G.server.setGroup("match", raceId, { mode = "ranked", racers = 3 })
G.server.levelStart("desert_loop")
for _, c in racers do
	G.setGroup(c.serverPlayer, "match", raceId)
	G.setProperties(c.serverPlayer, { car_class = "s" })
	G.levelStart(c.serverPlayer, "desert_loop", { laps = 3, mode = "ranked" })
end
-- The race: a stutter now and then, coins, boosts, a zone, an error on one client and one on the server.
world:run(20, function(i)
	return if i % 300 == 0 then 0.12 else 1 / 60
end, function(i)
	if i % 60 == 0 then
		for _, c in racers do
			G.count(c.serverPlayer, "coin", { source = "track", value = 5 })
		end
	end
	if i == 400 then
		world.currentDm = racers[1].dm
		world:glitchless(racers[1].dm).track("boost_used", { kind = "nitro" })
		world:glitchless(racers[1].dm).setZone("canyon")
		world.currentDm = world.server
	end
	if i == 600 then
		world:scriptError(racers[2].dm, "Players.Pocket.PlayerGui.Hud:31: attempt to index nil with 'Text'", "Players.Pocket.PlayerGui.Hud, line 31 - function refresh\n")
		world:scriptError(world.server, "ServerScriptService.Race:88: Third's kart is missing", "ServerScriptService.Race, line 88 - function respawn\n")
	end
end)
G.levelComplete(racers[1].serverPlayer, "desert_loop", { score = 1, durationS = 19.5 })
G.levelFail(racers[3].serverPlayer, "desert_loop", { cause = "out_of_time" })
-- Pocket is kicked mid-race; the others finish and the server closes.
world:leave(racers[2], Roblox.Enum.PlayerExitReason.CreatorKick)
world:run(5)
G.server.levelComplete("desert_loop")
G.server.endGroup("match")
assert(world:shutdown(30), "BindToClose didn't finish")

local intakeSent = 0
for _, r in world.requests do
	if string.find(r.Url, "/v1/intake", 1, true) then
		intakeSent += 1
	end
end
if capture then
	fs.writeFile(capture, "[" .. table.concat(sent, ",") .. "]")
end
print(serde.encode("json", { batches = #sent, requests = #world.requests, intake = intakeSent, errors = world.errors }))
