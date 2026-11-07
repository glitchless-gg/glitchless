--!nocheck
-- The extras a game turns on in init, each off by default: ProximityPrompts (`prompts`), seats (`seats`), whether the
-- player followed a friend in (`joinedWithFriend`), and how many of their friends are in the server
-- (`friendsInServer`). Counts and true/false only, never a name or an ID.
local serde = require("@lune/serde")
local t = require("./lib/t")
local I = require("./lib/intake")

local function play(world, clients, seconds)
	world:run(seconds or 12)
	for _, c in clients do
		if c.connected then
			world:leave(c)
		end
	end
	world:run(1)
end

t.test("off by default: no prompt or seat counts, no joined_with_friend, no friends gauge, no friend lookups", function()
	local world, G, batches = I.game()
	local a = world:join("Plain", { followUserId = 1234567890 })
	local b = world:join("Other")
	world:befriend(a, b)
	world:startClient(a)
	world:startClient(b)
	local _, humanoid = world:spawnCharacter(a, { 0, 3, 0 })
	world:run(1)
	world:triggerPrompt(a, "Open", "Chest")
	humanoid.Seated:Fire(true, world:part({ class = "Seat", name = "Bench", pos = { 0, 1, 0 }, size = { 2, 1, 2 } }))
	play(world, { a, b })
	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(next(I.counted(events, "prompt")), nil, "no prompt")
	t.eq(next(I.counted(events, "sit")), nil, "no sit")
	t.eq(events[1].props, nil, "no properties")
	for _, fw in I.ofType(events, "frame_window") do
		t.eq(fw.ctx.friends_in_server, nil, "no friends gauge")
	end
	t.eq(world.friendCalls, 0, "IsFriendsWith never called")
end)

t.test("prompts: each ProximityPrompt triggered is counted by its ActionText and ObjectText, players' names scrubbed", function()
	local world, G, batches = I.game({ options = { prompts = true } })
	local a = world:join("PlotOwner", { userId = 3141592653 })
	world:startClient(a)
	world:run(1)
	world:triggerPrompt(a, "Open", "Starter Pack")
	world:triggerPrompt(a, "Open", "Starter Pack")
	world:triggerPrompt(a, "Visit", "PlotOwner's House")
	world:triggerPrompt(a, "", "")
	play(world, { a })
	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(I.counted(events, "prompt"), {
		['{"action":"Open","object":"Starter Pack"}'] = 2,
		['{"action":"Visit","object":"<player>\'s House"}'] = 1,
		["{}"] = 1,
	}, "counted by their words")
	t.ok(not string.find(serde.encode("json", batches), "PlotOwner", 1, true), "the owner's name isn't sent")
end)

t.test("seats: each seat sat in is counted, by its name (its model's for a plain Seat) and whether it drives", function()
	local world, G, batches = I.game({ options = { seats = true } })
	local c = world:join("Sitter")
	world:startClient(c)
	local _, humanoid = world:spawnCharacter(c, { 0, 3, 0 })
	local sofa = world:folder("Sofa", "Model")
	local seat = world:part({ class = "Seat", name = "Seat", pos = { 0, 1, 0 }, size = { 2, 1, 2 }, parent = sofa })
	local kart = world:part({ class = "VehicleSeat", name = "KartSeat", pos = { 5, 1, 0 }, size = { 2, 1, 2 } })
	local floor = world:part({ name = "Floor", pos = { 0, 0, 0 }, size = { 10, 1, 10 } })
	world:run(1)
	humanoid.Seated:Fire(true, seat)
	humanoid.Seated:Fire(false, nil)
	humanoid.Seated:Fire(true, seat)
	humanoid.Seated:Fire(true, kart)
	humanoid.Seated:Fire(true, floor) -- not a seat
	-- after a respawn too
	local _, again = world:spawnCharacter(c, { 0, 3, 0 })
	world:run(1)
	again.Seated:Fire(true, kart)
	play(world, { c })
	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(I.counted(events, "sit"), {
		['{"seat":"Sofa","vehicle":false}'] = 2,
		['{"seat":"KartSeat","vehicle":true}'] = 2,
	}, "sits")
	t.ok(#I.ofType(events, "death") == 0, "deaths are still the Humanoid's own")
end)

t.test("joinedWithFriend: a session property, true when the player followed someone in; the ID is never sent", function()
	local world, G, batches = I.game({ options = { joinedWithFriend = true } })
	local a = world:join("Follower", { followUserId = 1234567890 })
	local b = world:join("Alone")
	world:startClient(a)
	world:startClient(b)
	play(world, { a, b }, 20)
	local props = {}
	for _, id in I.playerSessions(batches) do
		table.insert(props, I.eventsOf(batches, id)[1].props.joined_with_friend)
	end
	table.sort(props, function(x, y)
		return tostring(x) < tostring(y)
	end)
	t.eq(props, { false, true }, "one followed a friend in, one didn't")
	t.ok(not string.find(serde.encode("json", batches), "1234567890", 1, true), "the followed player's ID isn't sent")
end)

t.test("joinedWithFriend survives the player turning Glitchless off and on again", function()
	local world, G, batches = I.game({ options = { joinedWithFriend = true } })
	local a = world:join("Toggler", { followUserId = 1234567890 })
	world:startClient(a)
	world:run(2)
	G.setEnabled(a.serverPlayer, false)
	world:run(1)
	G.setEnabled(a.serverPlayer, true)
	play(world, { a }, 20)
	local ids = I.playerSessions(batches)
	t.eq(#ids, 1, "one session: the one after it was turned on again")
	t.eq(I.eventsOf(batches, ids[1])[1].props, { joined_with_friend = true }, "with the property")
end)

t.test("friendsInServer: a gauge of the player's friends here, looked up once a pair, kept up as players come and go", function()
	local world, G, batches = I.game({ options = { friendsInServer = true } })
	local a = world:join("Ann")
	local b = world:join("Ben")
	local c = world:join("Cat")
	world:befriend(a, b)
	world:befriend(a, c)
	local CA = world:startClient(a)
	world:startClient(b)
	world:startClient(c)
	world:run(11)
	t.eq(world.friendCalls, 3, "one lookup a pair: Ann–Ben, Ann–Cat, Ben–Cat")
	-- Cat turns Glitchless off: no longer counted in Ann's.
	G.setEnabled(c.serverPlayer, false)
	world:run(6)
	world:leave(b)
	world:run(11)
	world:leave(a)
	world:leave(c)
	world:run(1)

	-- Ann's session is the one with the most windows (Ben left early, Cat turned it off).
	local ann
	for _, id in I.playerSessions(batches) do
		local fws = I.ofType(I.eventsOf(batches, id), "frame_window")
		if not ann or #fws > #ann then
			ann = fws
		end
	end
	local seen = {}
	for _, fw in ann do
		table.insert(seen, fw.ctx.friends_in_server)
	end
	t.eq(seen[2], 2, "Ben and Cat while both are here: " .. t.show(seen))
	t.eq(seen[3], 1, "Ben alone as the window after Cat turned it off ends: " .. t.show(seen))
	t.eq(seen[#seen], 0, "none after Ben left: " .. t.show(seen))
	t.eq(CA.isEnabled(), true, "Ann still on")
	t.eq(#world.warnings, 0, "no warning")
end)

t.test("friendsInServer: a lookup that fails is tried twice more, then left out; nothing breaks", function()
	local world, G, batches = I.game({ options = { friendsInServer = true } })
	world.friendsBroken = true
	local a = world:join("Ann")
	local b = world:join("Ben")
	world:befriend(a, b)
	world:startClient(a)
	world:startClient(b)
	play(world, { a, b })
	t.eq(world.friendCalls, 3, "three tries")
	for _, id in I.playerSessions(batches) do
		for _, fw in I.ofType(I.eventsOf(batches, id), "frame_window") do
			t.eq(fw.ctx.friends_in_server, 0, "counted as none")
		end
	end
end)
