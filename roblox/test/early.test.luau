--!nocheck
-- Calls made before Glitchless has started: a LocalScript that runs before GlitchlessClient, a server Script that
-- runs before the one that calls init, a PlayerAdded handler that runs before Glitchless's. They wait and are made
-- when it starts.
local t = require("./lib/t")
local I = require("./lib/intake")

t.test("a LocalScript's calls before the client starts are sent when it does, at the time they were made", function()
	local world, G, batches = I.game()
	local c = world:join("Early")
	world:run(0.5)
	local madeAt = world:nowMs()
	local CG = I.onClient(world, c, function(CG)
		t.eq(CG.isEnabled(), true, "before it starts: on (what is said now will be kept)")
		CG.setZone("lobby")
		CG.levelStart("hall", { door = "front" })
		CG.track("menu_opened", { from = "hall" })
		CG.setProperties({ vip = "yes", tier = "gold" })
		CG.count("stars", { what = "daily" }, 3)
		CG.setProperties({ tier = "silver" })
		CG.clearProperty("vip")
		CG.setContext({ npcs = 4 })
		CG.setZone("hall")
	end)
	world:run(2) -- GlitchlessClient starts two seconds later
	world:startClient(c)
	world:run(12)
	world.currentDm = c.dm
	CG.levelComplete("hall")
	world.currentDm = world.server
	world:run(6)
	world:leave(c)
	world:run(1)

	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(events[1].props, { tier = "silver" }, "properties merged: each key's latest, vip cleared")
	local ls = I.find(events, function(e)
		return e.type == "level_start"
	end)
	t.ok(ls, "the level start went")
	t.eq(ls.attrs, { door = "front" }, "with its attributes")
	t.near(ls.ts, madeAt, 50, "at the time it was made, not when the client started")
	local custom = I.find(events, function(e)
		return e.type == "custom"
	end)
	t.eq({ custom.name, custom.level }, { "menu_opened", "hall" }, "the event, in the level")
	t.eq(custom.zone, nil, "made before the zone that waited was set")
	t.eq(I.counted(events, "stars"), { ['{"what":"daily"}'] = 3 }, "the count")
	for _, e in events do
		t.ok(e.zone ~= "lobby", "only the latest zone waited: no event is in the lobby")
	end
	local fw = I.find(events, function(e)
		return e.type == "frame_window"
	end)
	t.eq(fw.ctx.npcs, 4, "the gauge set before the start")
	t.eq(fw.zone, "hall", "frames after it are in the zone")
	local lc = I.find(events, function(e)
		return e.type == "level_complete"
	end)
	t.near(lc.duration_s, 14, 0.2, "the level's time counts from when it began, before the client started")
end)

t.test("a server Script's calls before Glitchless.init are made when it starts", function()
	local world, G, batches, start = I.game({ start = false })
	local c = world:join("Boot")
	G.server.levelStart("hall_map")
	G.server.setProperties({ shard = "eu" })
	G.server.setZone("plaza")
	G.setContext({ npcs = 12 }) -- on the server: the server's own gauges
	G.setProperties(c.serverPlayer, { vip = "yes" })
	G.track(c.serverPlayer, "joined_early", { fresh = true })
	G.setZone(c.serverPlayer, "a")
	G.setZone(c.serverPlayer, "b")
	t.eq(G.isEnabled(c.serverPlayer), true, "before init: on")
	t.eq(G.setGroup(c.serverPlayer, "run"), nil, "a run waits too, so no ID yet")
	world:run(1)
	start()
	world:startClient(c)
	world:run(20)
	world:leave(c)
	world:run(1)
	G.flush()
	world:run(1)

	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(events[1].props, { vip = "yes" }, "the property")
	local custom = I.find(events, function(e)
		return e.type == "custom" and e.name == "joined_early"
	end)
	t.ok(custom, "the event")
	t.eq(custom.zone, nil, "made before the zone that waited was set")
	t.eq(I.find(events, function(e)
		return e.type == "frame_window"
	end).zone, "b", "frames after are in the latest zone")
	t.ok(I.find(events, function(e)
		return e.type == "group" and e.kind == "run" and type(e.id) == "string"
	end), "the run, with an ID made at the start")
	for _, e in events do
		t.ok(e.zone ~= "a", "only the latest zone waited")
	end
	local server = I.eventsOf(batches, I.serverSession(batches))
	t.eq(server[1].props, { shard = "eu" }, "the server's own property")
	local sw = I.find(server, function(e)
		return e.type == "server_window"
	end)
	t.eq({ sw.level, sw.zone, sw.ctx.npcs }, { "hall_map", "plaza", 12 }, "the server's map, zone and gauge")
end)

t.test("a game's PlayerAdded handler that runs before Glitchless's: its calls wait for Glitchless to see the player", function()
	local world, G, batches, start = I.game({ start = false })
	-- The game connected first, so its handler runs first.
	world.server.Players.PlayerAdded:Connect(function(player)
		t.eq(G.isEnabled(player), true, "not seen yet: on")
		G.setProperties(player, { vip = "yes" })
		G.levelStart(player, "hall")
	end)
	start()
	local left = 0
	world.server.Players.PlayerRemoving:Connect(function(player)
		-- connected after init, so it runs after Glitchless's: the player is gone, and nothing waits for them
		for _ = 1, 200 do
			G.track(player, "after_leaving")
		end
		left += 1
		t.eq(G.isEnabled(player), false, "gone: off")
	end)
	local c = world:join("First")
	world:startClient(c)
	world:run(20)
	world:leave(c)
	world:run(1)
	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(events[1].props, { vip = "yes" }, "the property set in the game's PlayerAdded")
	t.ok(I.find(events, function(e)
		return e.type == "level_start" and e.level == "hall"
	end), "and the level")
	t.eq(left, 1, "the PlayerRemoving handler ran")
	t.ok(not I.find(events, function(e)
		return e.name == "after_leaving"
	end), "calls after the player left are dropped")
	-- None of them waits: a new player's early calls still have room.
	local d = world:join("Second")
	world:startClient(d)
	world:run(20)
	world:leave(d)
	world:run(1)
	local second = I.eventsOf(batches, I.playerSessions(batches)[2])
	t.eq(second[1].props, { vip = "yes" }, "the next player's early call went too")
	t.eq(#world.warnings, 0, "no warning: " .. table.concat(world.warnings, " | "))
end)

t.test("setEnabled(false) before the client starts: isEnabled says so, and nothing is sent for the player", function()
	local world, G, batches = I.game()
	local c = world:join("NoThanks", { userId = 4440001 })
	local CG = I.onClient(world, c, function(CG)
		CG.setEnabled(false)
		t.eq(CG.isEnabled(), false, "off before it starts")
		CG.track("never_sent")
	end)
	world:startClient(c)
	world:run(20)
	world:leave(c)
	world:run(1)
	t.eq(#I.playerSessions(batches), 0, "no player session")
	t.eq(world.datastore["Glitchless/u4440001"], "off", "the choice was saved")
	world.currentDm = c.dm
	t.eq(CG.isEnabled(), false, "still off")
	world.currentDm = world.server
end)

t.test("at most 128 calls wait, with one warning in Studio; a client never started is said after 30 s", function()
	local world, G, batches = I.game({ studio = true })
	local c = world:join("Chatty")
	I.onClient(world, c, function(CG)
		for i = 1, 200 do
			CG.track("tap", { n = i })
		end
	end)
	local full = 0
	for _, m in world.warnings do
		if string.find(m, "more than 128 calls", 1, true) then
			full += 1
		end
	end
	t.eq(full, 1, "one warning")
	world:run(31)
	local waiting = false
	for _, m in world.warnings do
		waiting = waiting or string.find(m, "128 calls are waiting", 1, true) ~= nil
	end
	t.ok(waiting, "the calls waiting are said: " .. table.concat(world.warnings, " | "))
	world:startClient(c)
	world:run(20)
	world:leave(c)
	world:run(1)
	local events = I.eventsOf(batches, I.playerSessions(batches)[1])
	t.eq(#I.ofType(events, "custom"), 128, "the first 128 went")
end)

t.test("the server's own calls and setGroup from a LocalScript still say they are the server's", function()
	local world = I.game()
	local c = world:join("Wrong")
	I.onClient(world, c, function(CG)
		CG.server.track("x")
		CG.setGroup(nil, "match", "abcdefgh")
	end)
	local said = 0
	for _, m in world.warnings do
		if string.find(m, "server", 1, true) then
			said += 1
		end
	end
	t.eq(said, 2, "two warnings: " .. table.concat(world.warnings, " | "))
end)
