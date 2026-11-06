--!nocheck
-- Whole sessions in the fake Roblox (lib/roblox.luau): a server running Glitchless, players joining with their own
-- clients, playing, erroring and leaving, and what the server sends for it, read back from its HTTP requests.
local serde = require("@lune/serde")
local t = require("./lib/t")
local Roblox = require("./lib/roblox")
local Enum = Roblox.Enum

local TOKEN = "gl_pub_test"

-- A world whose intake answers like Glitchless and keeps every batch, decoded.
local function game(opts)
	opts = opts or {}
	local batches = {}
	local health = 0
	local world = Roblox.world({
		studio = opts.studio,
		http = function(req)
			if string.find(req.Url, "/v1/health", 1, true) then
				health += 1
				return { StatusCode = 200, Body = opts.healthBody or '{"ok":true,"features":["counts","props","groups","zones","net","server_mode"]}', Headers = {} }
			end
			if opts.status then
				local s = opts.status(req)
				if s then
					return { StatusCode = s, Body = '{"error":"x"}', Headers = { ["retry-after"] = "3" } }
				end
			end
			local body = serde.decode("json", req.Body)
			body._gzip = req.Compress == Enum.HttpCompression.Gzip
			body._url = req.Url
			table.insert(batches, body)
			return { StatusCode = 202, Body = '{"accepted":1}', Headers = {} }
		end,
	})
	local G = world:glitchless(world.server)
	local options = { service = "nardo-racing", clientToken = TOKEN, intake = "http://glitchless.test", version = "1.4.0", properties = { mode = "ranked" } }
	for k, v in opts.options or {} do
		options[k] = v
	end
	G.init(options)
	return world, G, batches, function()
		return health
	end
end

-- Every event a session sent, in order.
local function eventsOf(batches, sessionId)
	local out = {}
	for _, b in batches do
		if b.session_id == sessionId then
			for _, e in b.events do
				table.insert(out, e)
			end
		end
	end
	return out
end

local function sessions(batches)
	local ids, list = {}, {}
	for _, b in batches do
		if not ids[b.session_id] then
			ids[b.session_id] = true
			table.insert(list, { id = b.session_id, role = b.role })
		end
	end
	return list
end

local function find(events, pred)
	for _, e in events do
		if pred(e) then
			return e
		end
	end
	return nil
end

local function ofType(events, ty)
	local out = {}
	for _, e in events do
		if e.type == ty then
			table.insert(out, e)
		end
	end
	return out
end

local function playerSession(batches)
	for _, s in sessions(batches) do
		if s.role == nil then
			return s.id
		end
	end
	return nil
end

t.test("a player's session: start with device and properties, frame windows, a level, and the end when they leave", function()
	local world, G, batches = game()
	local c = world:join("xX_Racer_Xx", { userId = 2840198822, displayName = "Speedy Kid" })
	local CG = world:startClient(c)
	world:run(3, 1 / 60)
	G.levelStart(c.serverPlayer, "desert_loop", { mode = "time_trial", laps = 3 })
	world:run(8, 1 / 60, function(i)
		if i == 200 then
			world.currentDm = c.dm
			CG.track("boost_used", { kind = "nitro" })
			CG.count("coin", { source = "track" }, 2)
			CG.count("coin", { source = "track" })
			world.currentDm = world.server
		end
	end)
	G.levelComplete(c.serverPlayer, "desert_loop", { score = 1200 })
	world:run(2, 1 / 60)
	world:leave(c)
	world:run(2, 1 / 60)

	local id = playerSession(batches)
	t.ok(id and string.match(id, "^s_%x+$"), "a random session ID: " .. tostring(id))
	local events = eventsOf(batches, id)
	local start = events[1]
	t.eq(start.type, "session_start", "session_start first")
	t.eq(start.privacy, "anonymous", "anonymous")
	t.eq(start.session_type, "user", "a player")
	t.eq(start.device.browser, "Roblox", "browser")
	t.eq(start.device.os, "Computer", "the kind of device in Roblox's words")
	t.eq(start.device.mobile, false, "not mobile")
	t.eq(start.device.screen, { 1920, 1080 }, "screen")
	t.eq(start.device.browser_version, "0.651.0.6510637", "Roblox's version")
	t.eq(start.props, { mode = "ranked" }, "properties from init")
	t.eq(start.level, nil, "session_start carries no level")
	t.eq(start.match, nil, "nor a match")

	local fws = ofType(events, "frame_window")
	t.ok(#fws >= 2, "frame windows: " .. #fws)
	local inLevel = find(fws, function(e)
		return e.level == "desert_loop"
	end)
	t.ok(inLevel, "a window in the level carries it")
	t.eq(inLevel.ft.a, 0.02, "sketch")
	t.ok(inLevel.frames > 100, "frames")
	t.near(inLevel.ft_p50, 16.67, 0.5, "p50")
	t.eq(inLevel.hz, 60, "60 Hz")
	t.near(inLevel.render_ms, 4, 0.01, "render_ms from Stats (seconds read as such)")
	t.near(inLevel.gpu_ms, 6, 0.01, "gpu_ms")
	t.eq(inLevel.draw_calls, 500, "draw calls: scene, shadows and UI")
	t.eq(inLevel.ctx.instances, 25000, "instances as a gauge")
	t.eq(inLevel.net.transport, "roblox", "net")
	t.near(inLevel.net.rtt_p50, 45, 2, "round trip from GetNetworkPing")
	t.eq(inLevel.net.in_kbps, 100, "kilobits in")
	t.ok(inLevel.match and string.match(inLevel.match, "^h_%x+$"), "the server is the match: " .. tostring(inLevel.match))
	local before = find(fws, function(e)
		return e.level == nil
	end)
	t.ok(before, "a window before the level has none")

	local ls = find(events, function(e)
		return e.type == "level_start"
	end)
	t.eq(ls.attrs, { laps = 3, mode = "time_trial" }, "level attributes")
	local custom = find(events, function(e)
		return e.type == "custom"
	end)
	t.eq({ custom.name, custom.attrs.kind, custom.level }, { "boost_used", "nitro", "desert_loop" }, "a LocalScript's track, with the level the server set")
	local counts = find(events, function(e)
		return e.type == "counts"
	end)
	t.eq(counts.counts[1].n, 3, "counted on the client and added up")
	t.eq(counts.counts[1].attrs, { source = "track" }, "grouped by its words")
	local lc = find(events, function(e)
		return e.type == "level_complete"
	end)
	t.eq(lc.score, 1200, "score")
	t.near(lc.duration_s, 8, 0.1, "duration")
	local load = find(events, function(e)
		return e.type == "load"
	end)
	t.ok(load and load.ttff_ms >= 0, "load")
	local fin = events[#events]
	t.eq(fin.type, "session_end", "session_end last")
	t.eq(fin.reason, "quit", "they left")

	for _, b in batches do
		t.eq(b.sdk, "glitchless-roblox/0.1.0", "sdk")
		t.eq(b.service, "nardo-racing", "service")
		t.eq(b.version, "1.4.0", "version")
		t.eq(b.env, "prod", "env")
		t.eq(b.player_id, nil, "no player ID")
		t.ok(string.match(b.batch_id, "^b_%x+$") and #b.batch_id == 18, "batch_id")
		t.ok(string.find(b._url, "token=" .. TOKEN, 1, true), "the token")
	end
	-- Nothing anywhere names the player.
	local all = table.concat((function()
		local out = {}
		for _, b in batches do
			table.insert(out, serde.encode("json", b))
		end
		return out
	end)())
	t.ok(not string.find(all, "Racer", 1, true), "no name")
	t.ok(not string.find(all, "Speedy", 1, true), "no display name")
	t.ok(not string.find(all, "2840198822", 1, true), "no user ID")
end)

t.test("the server's own session: server windows under role server, its match, and BindToClose sends everything", function()
	local world, G, batches = game()
	local a = world:join("Alpha")
	local b = world:join("Bravo")
	world:startClient(a)
	world:startClient(b)
	G.server.levelStart("desert_loop")
	G.server.track("race_started", { racers = 2 })
	world:run(11, function(i)
		return if i % 120 == 0 then 0.09 else 1 / 60
	end)
	t.ok(world:shutdown(30), "BindToClose finished")
	local server
	for _, s in sessions(batches) do
		if s.role == "server" then
			server = s.id
		end
	end
	t.ok(server, "a server session")
	local events = eventsOf(batches, server)
	local start = events[1]
	t.eq(start.type, "session_start", "start")
	t.eq(start.server.tick_hz, 60, "tick_hz")
	t.eq(start.server.max_players, 12, "max players")
	t.eq(start.server.build, "dedicated", "build")
	t.eq(start.device.browser, "Roblox", "device")
	local sw = ofType(events, "server_window")
	t.ok(#sw >= 2, "server windows: " .. #sw)
	local w = sw[1]
	t.eq(w.tick.a, 0.02, "tick sketch")
	t.near(w.tick_hz, 59, 2, "tick rate reached")
	t.eq(w.players, 2, "players")
	t.eq(w.late, 2, "the two long frames were late")
	t.near(w.budget_ms, 25, 0.01, "budget")
	t.eq(w.mem_mb, 812.5, "memory")
	t.eq(w.in_kbps, 100, "kilobits in")
	t.near(w.rtt_p95, 45, 3, "players' round trips")
	t.near(w.heartbeat_ms, 3, 0.01, "Stats.HeartbeatTime")
	t.eq(w.level, "desert_loop", "the server's map")
	local group = find(events, function(e)
		return e.type == "group"
	end)
	local players = {}
	for _, s in sessions(batches) do
		if s.role == nil then
			table.insert(players, s.id)
		end
	end
	t.eq(#players, 2, "two player sessions")
	for _, id in players do
		local pg = find(eventsOf(batches, id), function(e)
			return e.type == "group"
		end)
		t.eq(pg.id, group.id, "a player's match is the server's")
		local fin = eventsOf(batches, id)
		t.eq(fin[#fin].reason, "close", "the server closed")
	end
	t.eq(events[#events].type, "session_end", "the server's session ends")
	t.eq(events[#events].reason, "close", "with the server")
	local custom = find(events, function(e)
		return e.type == "custom"
	end)
	t.eq(custom.name, "race_started", "Glitchless.server.track")
end)

t.test("errors: a LocalScript's and a server Script's, scrubbed of names, read into fields", function()
	local world, G, batches = game()
	local c = world:join("xX_Racer_Xx", { userId = 2840198822, displayName = "Speedy Kid" })
	world:startClient(c)
	world:run(1)
	world:scriptError(c.dm, "Players.xX_Racer_Xx.PlayerScripts.Hud:31: attempt to index nil with 'Text'", "Players.xX_Racer_Xx.PlayerScripts.Hud, line 31 - function refresh\n")
	world:scriptError(world.server, "Workspace.xX_Racer_Xx.Kart:12: Speedy Kid has no kart 2840198822", "Workspace.xX_Racer_Xx.Kart, line 12 - function spawn\n")
	world:scriptError(world.server, "ReplicatedStorage.Glitchless.Session:1: the SDK's own", "ReplicatedStorage.Glitchless.Session, line 1\n")
	world:run(2)
	world:leave(c)
	world:run(1)
	G.flush()
	world:run(1)
	local player = playerSession(batches)
	local ce = find(eventsOf(batches, player), function(e)
		return e.type == "error"
	end)
	t.ok(ce, "the client's error")
	t.eq(ce.kind, "script", "kind")
	t.eq(ce.message, "attempt to index nil with 'Text'", "message")
	t.eq(ce.source, "Players.<player>.PlayerScripts.Hud", "source, scrubbed")
	t.eq(ce.line, 31, "line")
	t.eq(ce.fn, "Hud.refresh", "fn")
	t.ok(string.match(ce.fingerprint, "^%x%x%x%x%x%x%x%x$"), "fingerprint")
	local server
	for _, s in sessions(batches) do
		if s.role == "server" then
			server = s.id
		end
	end
	local errs = ofType(eventsOf(batches, server), "error")
	t.eq(#errs, 1, "one server error: the SDK's own isn't sent")
	t.eq(errs[1].kind, "server_script", "a server Script's error, never read as a crash")
	t.eq(errs[1].message, "<player> has no kart <user>", "names and user IDs scrubbed from the message")
	t.eq(errs[1].source, "Workspace.<player>.Kart", "and from the path")
	t.eq(errs[1].fn, "Kart.spawn", "fn")
end)

t.test("a phone, a kick, and an automatic death with its place when positions are on", function()
	local world, G, batches = game({ options = { positions = true } })
	local c = world:join("Pocket", { touch = true })
	world:startClient(c)
	local _, humanoid = world:spawnCharacter(c, { 10, 4, -20 })
	world:run(2)
	humanoid.Died:Fire()
	world:run(2)
	world:leave(c, Enum.PlayerExitReason.CreatorKick)
	world:run(1)
	local events = eventsOf(batches, playerSession(batches))
	t.eq(events[1].device.os, "Phone", "touch, no keyboard, a small screen")
	t.eq(events[1].device.mobile, true, "mobile")
	local death = find(events, function(e)
		return e.type == "death"
	end)
	t.ok(death, "the Humanoid's death")
	t.eq({ death.x, death.y, death.z }, { 10, 4, -20 }, "where")
	local pos = find(events, function(e)
		return e.type == "pos"
	end)
	t.ok(pos and #pos.pts >= 4, "positions sampled by the server")
	t.eq(events[#events].reason, "kicked", "CreatorKick")
end)

t.test("a death the game reports itself replaces the automatic one", function()
	local world, G, batches = game()
	local c = world:join("Faller")
	world:startClient(c)
	local _, humanoid = world:spawnCharacter(c, { 0, 0, 0 })
	world:run(1)
	humanoid.Died:Fire()
	G.death(c.serverPlayer, { cause = "lava" })
	world:run(2)
	humanoid.Died:Fire()
	world:run(2)
	world:leave(c)
	world:run(1)
	local deaths = ofType(eventsOf(batches, playerSession(batches)), "death")
	t.eq(#deaths, 1, "one death: the game's")
	t.eq(deaths[1].cause, "lava", "with its cause")
	t.eq(deaths[1].x, nil, "no place: positions are off")
end)

t.test("the off switch: off drops everything and is saved; the next join sends nothing; on starts a new session", function()
	local world, G, batches = game()
	local c = world:join("Quiet", { userId = 777000111 })
	local CG = world:startClient(c)
	world:run(3)
	world.currentDm = c.dm
	CG.setEnabled(false)
	world.currentDm = world.server
	world:run(20)
	world:leave(c)
	world:run(2)
	t.eq(#batches, 0 + #(function()
		local out = {}
		for _, b in batches do
			if b.role == "server" then
				table.insert(out, b)
			end
		end
		return out
	end)(), "only the server's own batches went")
	t.eq(world.datastore["Glitchless/u777000111"], "off", "saved in the game's DataStore")
	t.eq(CG.isEnabled(), false, "isEnabled")

	-- They come back: nothing is sent for them.
	local c2 = world:join("Quiet", { userId = 777000111 })
	world:startClient(c2)
	world:run(20)
	t.eq(playerSession(batches), nil, "still nothing for the player")
	-- They turn it back on from the server's settings handler.
	G.setEnabled(c2.serverPlayer, true)
	world:run(20)
	t.ok(playerSession(batches), "a new session")
	t.eq(world.datastore["Glitchless/u777000111"], "on", "saved")
	t.eq(G.isEnabled(c2.serverPlayer), true, "isEnabled on the server")
end)

t.test("optIn: nothing until the player says yes; a DataStore that can't be read leaves it at the default", function()
	local world, G, batches = game({ options = { optIn = true } })
	local c = world:join("Asker")
	world:startClient(c)
	world:run(20)
	t.eq(playerSession(batches), nil, "nothing before yes")
	G.setEnabled(c.serverPlayer, true)
	world:run(20)
	t.ok(playerSession(batches), "after yes")

	local w2, G2, b2 = game()
	w2.datastoreBroken = true
	local d = w2:join("Studio")
	w2:startClient(d)
	w2:run(20)
	t.ok(playerSession(b2), "on by default")
	local warned = false
	for _, m in w2.warnings do
		warned = warned or string.find(m, "DataStore", 1, true) ~= nil
	end
	t.eq(warned, false, "no warning outside Studio")
end)

t.test("a client that floods or lies is held to its limits and can't touch other sessions", function()
	local world, G, batches = game()
	local good = world:join("Good")
	world:startClient(good)
	local bad = world:join("Bad")
	world:run(1)
	local remote = bad.dm.ReplicatedStorage.Glitchless.GlitchlessRemote
	world.currentDm = bad.dm
	for i = 1, 50 do
		remote:FireServer({ op = "events", events = {
			{ type = "custom", name = "spam" .. i },
			{ type = "group", kind = "match", id = "stolen-match-id" },
			{ type = "frame_window", frames = 10, ft = { a = 0.02, b = { ["9999"] = 5 } } },
			{ type = "frame_window", frames = "lots", ft = "x" },
			{ type = "error", message = string.rep("x", 10000) },
			{ type = "session_end", reason = "fake" },
			{ type = "props", props = { email = "a@b.co", rank = "gold", n = 1.5 } },
			"junk",
		} })
	end
	remote:FireServer("not a table")
	remote:FireServer({ op = "enabled", on = "yes" })
	world.currentDm = world.server
	world:run(20)
	world:leave(bad)
	world:run(2)
	local badId
	for _, s in sessions(batches) do
		if s.role == nil then
			local ev = eventsOf(batches, s.id)
			if find(ev, function(e)
				return e.type == "custom" and string.sub(e.name, 1, 4) == "spam"
			end) then
				badId = s.id
			end
		end
	end
	t.ok(badId, "the flooding client's session")
	local events = eventsOf(batches, badId)
	t.eq(#ofType(events, "custom"), 10, "10 messages at once, then 1 a second: the rest dropped")
	t.eq(#ofType(events, "group"), 1, "only the server's match: a client can't set one")
	t.eq(#ofType(events, "frame_window"), 0, "a sketch with an impossible bucket and a window of junk are dropped")
	t.eq(#ofType(events, "session_end"), 1, "a client can't end its session")
	local err = ofType(events, "error")[1]
	t.ok(#err.message <= 1000, "a long message is cut")
	local start = events[1]
	t.eq(start.props, { mode = "ranked", rank = "gold" }, "an identifying key and a fraction dropped from properties")
end)

t.test("Studio: the session is a tester's, env dev, version the place's (0), and no JobId still makes a match", function()
	local world, G, batches = game({ studio = true, options = { version = false } })
	local c = world:join("Dev")
	world:startClient(c)
	world:run(20)
	local b = batches[1]
	t.eq(b.env, "dev", "env")
	t.eq(b.version, "0", "game.PlaceVersion")
	local events = eventsOf(batches, playerSession(batches))
	t.eq(events[1].session_type, "tester", "a tester")
	t.ok(find(events, function(e)
		return e.type == "group"
	end), "a match all the same")
end)

t.test("the request budget: a full server's players send less often, within requests a minute", function()
	local world, G, batches = game({ options = { requestsPerMinute = 30 } })
	for i = 1, 20 do
		world:startClient(world:join("P" .. i))
	end
	world:run(120, 1 / 30)
	local perMinute = #world.requests / 2
	t.ok(perMinute <= 32, "requests a minute within the budget: " .. perMinute)
	t.ok(#sessions(batches) >= 15, "sessions still reported: " .. #sessions(batches))
end)

t.test("the intake refuses the token: one warning in Studio, and nothing more is tried", function()
	local world, G, batches = game({ studio = true, status = function(req)
		return if string.find(req.Url, "/v1/intake", 1, true) then 401 else nil
	end })
	local c = world:join("A")
	world:startClient(c)
	world:run(60)
	local intake = 0
	for _, r in world.requests do
		if string.find(r.Url, "/v1/intake", 1, true) then
			intake += 1
		end
	end
	t.eq(intake, 1, "one try")
	local said = false
	for _, m in world.warnings do
		said = said or string.find(m, "client token", 1, true) ~= nil
	end
	t.ok(said, "a warning names the token")
end)

t.test("a server without server_mode gets no server session; one without counts gets no counters", function()
	local world, G, batches = game({ healthBody = '{"ok":true,"features":["props"]}' })
	local c = world:join("Old")
	local CG = world:startClient(c)
	world:run(2)
	G.count(c.serverPlayer, "kill", nil, 5)
	world.currentDm = c.dm
	CG.count("coin")
	world.currentDm = world.server
	world:run(20)
	for _, b in batches do
		t.eq(b.role, nil, "no server batch")
		for _, e in b.events do
			t.ok(e.type ~= "counts", "no counts")
		end
	end
	t.ok(#batches > 0, "the player's batches went")
end)

t.test("big batches go gzipped", function()
	local world, G, batches = game()
	local c = world:join("Zip")
	world:startClient(c)
	world:run(20)
	local any = false
	for _, b in batches do
		any = any or b._gzip
	end
	t.ok(any, "Compress = Gzip on a batch over 1 KB")
end)

t.test("init puts the client script in StarterPlayerScripts, pointing at the module", function()
	local world = game()
	local sps = world.server.StarterPlayer.StarterPlayerScripts
	local boot = sps:FindFirstChild("GlitchlessClient")
	t.ok(boot, "GlitchlessClient copied")
	t.eq(boot.ClassName, "LocalScript", "a LocalScript")
	t.eq(boot.Module.Value, world.server.ReplicatedStorage.Glitchless, "its Module points at Glitchless")
end)

t.test("a name or user ID the game puts in its own events is scrubbed too", function()
	local world, G, batches = game()
	local a = world:join("GiftGiver", { userId = 3141592653 })
	local b = world:join("LuckyFriend", { userId = 2718281828, displayName = "Lucky Friend" })
	world:startClient(a)
	world:startClient(b)
	world:run(1)
	G.track(a.serverPlayer, "gift_sent", { to = b.serverPlayer.Name, to_id = b.serverPlayer.UserId, note = "for Lucky Friend", amount = 50 })
	G.levelStart(a.serverPlayer, "LuckyFriend_house")
	G.count(a.serverPlayer, "trade", { with = "GiftGiver" }, 1)
	world:run(20)
	world:leave(a)
	world:run(1)
	local text = serde.encode("json", batches)
	for _, bad in { "GiftGiver", "LuckyFriend", "Lucky Friend", "3141592653", "2718281828" } do
		t.ok(not string.find(text, bad, 1, true), bad .. " is not sent")
	end
	local events = {}
	for _, bt in batches do
		for _, e in bt.events do
			table.insert(events, e)
		end
	end
	local gift = find(events, function(e)
		return e.name == "gift_sent"
	end)
	t.eq(gift.attrs, { to = "<player>", note = "for <player>", amount = 50 }, "the name replaced, the user ID dropped, the rest kept")
	t.ok(find(events, function(e)
		return e.type == "level_start" and e.level == "<player>_house"
	end), "a name inside an identifier")
end)
