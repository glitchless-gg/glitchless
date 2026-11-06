-- The test place's server: starts Glitchless against a local Glitchless server (npm run server, port 7777) and plays
-- a short race for each player who joins: a level, coins, a boost, a lap error, and the level's end.
-- Build and open it: rojo build roblox/place.project.json -o roblox/.build/GlitchlessTest.rbxl, then Play in Studio.
-- roblox/test/studio.mjs plays it through Studio's MCP server, pointing it at a server of its own with the Intake
-- attribute on this script.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Glitchless = require(ReplicatedStorage:WaitForChild("Glitchless"))
Glitchless.init({
	service = "roblox-studio-test",
	clientToken = "gl_pub_dev",
	intake = script:GetAttribute("Intake") or "http://localhost:7777",
	version = "0.1.0-studio",
	positions = true,
	region = "studio",
	properties = { mode = "time_trial" },
})

Glitchless.server.levelStart("desert_loop")
Glitchless.server.track("server_started", { place = "test" })

local function race(player: Player)
	Glitchless.setProperties(player, { car_class = "s" })
	Glitchless.levelStart(player, "desert_loop", { laps = 3 })
	for lap = 1, 3 do
		for _ = 1, 5 do
			task.wait(1)
			if player.Parent == nil then
				return
			end
			Glitchless.count(player, "coin", { source = "track", value = 5 })
		end
		Glitchless.track(player, "lap_done", { lap = lap })
		if lap == 2 then
			-- a stutter: a burst of parts in one frame
			local folder = Instance.new("Folder")
			folder.Name = "Burst"
			for i = 1, 3000 do
				local p = Instance.new("Part")
				p.Anchored = true
				p.Position = Vector3.new(i % 50, 20 + math.floor(i / 50), 0)
				p.Parent = folder
			end
			folder.Parent = workspace
			task.delay(3, function()
				folder:Destroy()
			end)
		end
	end
	Glitchless.levelComplete(player, "desert_loop", { score = 1 })
	-- an error in a server script, after a player's name (it must arrive scrubbed)
	task.spawn(function()
		error(player.Name .. "'s trophy is missing")
	end)
end

Players.PlayerAdded:Connect(function(player)
	task.spawn(race, player)
end)
for _, player in Players:GetPlayers() do
	task.spawn(race, player)
end
