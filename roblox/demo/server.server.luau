-- The test place's server: starts Glitchless against a local Glitchless server (npm run server, port 7777) and plays
-- a short race for each player who joins: a level, coins, a boost, a lap error, and the level's end. It builds a small
-- track first (a floor, a garage kiosk with a ProximityPrompt, a bench), turns on the extras (prompts, seats,
-- joinedWithFriend, friendsInServer), sits each player on the bench, and sends a map of the track.
-- Build and open it: rojo build roblox/place.project.json -o roblox/.build/GlitchlessTest.rbxl, then Play in Studio.
-- roblox/test/studio.mjs plays it through Studio's MCP server, pointing it at a server of its own with the Intake
-- attribute on this script, then has glitchless-playtest play it twice (the autoplay attribute) and compare.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Glitchless = require(ReplicatedStorage:WaitForChild("Glitchless"))

-- Said before init (another Script could run first): it waits, and goes when Glitchless starts.
Glitchless.server.track("before_init")

-- The track: built once, when the place has none.
local track = workspace:FindFirstChild("DemoTrack")
if not track then
	track = Instance.new("Folder")
	track.Name = "DemoTrack"
	local function part(name: string, size: Vector3, pos: Vector3, color: Color3, parent: Instance?): Part
		local p = Instance.new("Part")
		p.Name = name
		p.Anchored = true
		p.Size = size
		p.Position = pos
		p.Color = color
		p.Parent = parent or track
		return p
	end
	part("Floor", Vector3.new(120, 2, 80), Vector3.new(0, -1, 0), Color3.fromRGB(110, 116, 128))
	part("Asphalt", Vector3.new(90, 0.2, 14), Vector3.new(0, 0.1, -22), Color3.fromRGB(52, 54, 60))
	part("WallNorth", Vector3.new(120, 6, 2), Vector3.new(0, 3, -41), Color3.fromRGB(190, 70, 60))
	part("WallSouth", Vector3.new(120, 6, 2), Vector3.new(0, 3, 41), Color3.fromRGB(190, 70, 60))
	part("Ramp", Vector3.new(14, 3, 10), Vector3.new(36, 1.5, 18), Color3.fromRGB(230, 180, 60))
	local spawn = Instance.new("SpawnLocation")
	spawn.Anchored = true
	spawn.Size = Vector3.new(8, 1, 8)
	spawn.Position = Vector3.new(0, 0.5, 0)
	spawn.Parent = track
	local kiosk = part("Kiosk", Vector3.new(4, 5, 2), Vector3.new(6, 2.5, 0), Color3.fromRGB(60, 140, 220))
	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = "Open"
	prompt.ObjectText = "Garage"
	prompt.HoldDuration = 0
	prompt.MaxActivationDistance = 40
	prompt.RequiresLineOfSight = false
	prompt.Triggered:Connect(function()
		print("[demo] the garage prompt was triggered")
	end)
	prompt.Parent = kiosk
	local bench = Instance.new("Model")
	bench.Name = "Bench"
	local seat = Instance.new("Seat")
	seat.Name = "Seat"
	seat.Anchored = true
	seat.Size = Vector3.new(4, 1, 2)
	seat.Position = Vector3.new(-8, 0.5, 0)
	seat.Color = Color3.fromRGB(120, 80, 50)
	seat.Parent = bench
	bench.Parent = track
	track.Parent = workspace
end

Glitchless.init({
	service = "roblox-studio-test",
	clientToken = "gl_pub_dev",
	intake = script:GetAttribute("Intake") or "http://localhost:7777",
	version = "0.2.0-studio",
	positions = true,
	region = "studio",
	properties = { mode = "time_trial" },
	prompts = true,
	seats = true,
	joinedWithFriend = true,
	friendsInServer = true,
	-- A playtest (glitchless-playtest) sets the autoplay attribute: its sessions are a bot's, out of player numbers.
	sessionType = if workspace:GetAttribute("autoplay") then "synthetic" else nil,
})

-- The track's map, under the race's level: a heatmap of where players drove draws on it.
task.spawn(Glitchless.captureMap, { level = "desert_loop", area = track, size = 192 })

Glitchless.server.levelStart("desert_loop")
Glitchless.server.track("server_started", { place = "test" })

-- A moment on the bench (a sit), then over to the garage kiosk, whose prompt the client presses once it shows (Roblox
-- hides prompts from a seated character). The bench is turned off after, or it seats whoever lands on it again.
local function sitDown(player: Player)
	local character = player.Character or player.CharacterAdded:Wait()
	local humanoid = character:WaitForChild("Humanoid", 10) :: Humanoid?
	local seat = track:FindFirstChild("Bench") and track.Bench:FindFirstChild("Seat") :: Seat?
	if humanoid and seat then
		task.wait(2)
		seat:Sit(humanoid)
		task.wait(2)
		seat.Disabled = true
		humanoid.Sit = false
		task.wait(0.5)
		character:PivotTo(CFrame.new(6, 4, 5))
	end
end

local function race(player: Player)
	task.spawn(sitDown, player)
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
	-- The race plays itself, so it is this place's autoplay: tell a playtest the run is over.
	if workspace:GetAttribute("autoplay") then
		workspace:SetAttribute("GlitchlessPlaytestDone", true)
	end
end

Players.PlayerAdded:Connect(function(player)
	task.spawn(race, player)
end)
for _, player in Players:GetPlayers() do
	task.spawn(race, player)
end
