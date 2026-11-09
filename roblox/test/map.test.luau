--!nocheck
-- The top-down map a server draws of its place for heatmaps (Map.luau, Jpeg.luau, Glitchless.captureMap and
-- mapBounds): its bounds, what it draws and leaves out, the JPEG it makes, and the `map` event it sends.
local t = require("./lib/t")
local I = require("./lib/intake")
local Roblox = require("./lib/roblox")

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function unbase64(s)
	local bytes = {}
	local acc, n = 0, 0
	for i = 1, #s do
		local ch = string.sub(s, i, i)
		if ch == "=" then
			break
		end
		acc = acc * 64 + (string.find(B64, ch, 1, true) - 1)
		n += 6
		if n >= 8 then
			n -= 8
			table.insert(bytes, math.floor(acc / 2 ^ n) % 256)
			acc %= 2 ^ n
		end
	end
	return bytes
end

-- The width and height a JPEG's SOF0 says, and whether it starts and ends as one.
local function jpegInfo(bytes)
	local w, h
	for i = 3, #bytes - 8 do
		if bytes[i] == 0xff and bytes[i + 1] == 0xc0 then
			h = bytes[i + 5] * 256 + bytes[i + 6]
			w = bytes[i + 7] * 256 + bytes[i + 8]
			break
		end
	end
	return {
		soi = bytes[1] == 0xff and bytes[2] == 0xd8,
		eoi = bytes[#bytes - 1] == 0xff and bytes[#bytes] == 0xd9,
		w = w,
		h = h,
	}
end

-- A hall: a grey floor, a red wall on its east side, an invisible zone volume in its west half, a blue pool of water.
local function hall(world)
	world:part({ name = "Floor", pos = { 0, -1, 0 }, size = { 100, 2, 60 }, color = { 0.4, 0.4, 0.45 } })
	world:part({ name = "Wall", pos = { 20, 5, 0 }, size = { 4, 10, 40 }, color = { 0.8, 0.2, 0.2 } })
	local zones = world:folder("Zones")
	world:part({ name = "Caves", pos = { -30, 5, 0 }, size = { 30, 10, 30 }, transparency = 1, parent = zones })
	world:part({ name = "Barrier", pos = { 0, 20, 0 }, size = { 400, 1, 400 }, transparency = 1 }) -- an invisible ceiling
	return zones
end

t.test("Jpeg: base64 as everyone writes it, and a JPEG that starts, ends and says its size", function()
	local M = Roblox.modules()
	local Jpeg = M.Jpeg
	t.eq({ Jpeg.base64("Man"), Jpeg.base64("Ma"), Jpeg.base64("M"), Jpeg.base64("") }, { "TWFu", "TWE=", "TQ==", "" }, "base64")
	local rgb = {}
	for i = 1, 20 * 12 do
		table.insert(rgb, (i * 7) % 256)
		table.insert(rgb, (i * 13) % 256)
		table.insert(rgb, 200)
	end
	local info = jpegInfo(unbase64(string.sub(Jpeg.dataUrl(Jpeg.encode(rgb, 20, 12, 80)), #"data:image/jpeg;base64," + 1)))
	t.eq(info, { soi = true, eoi = true, w = 20, h = 12 }, "a 20×12 JPEG")
	local low = #Jpeg.encode(rgb, 20, 12, 20)
	local high = #Jpeg.encode(rgb, 20, 12, 95)
	t.ok(low < high, "lower quality, fewer bytes: " .. low .. " < " .. high)
end)

t.test("Map.bounds: the place's visible parts, an area's every part, characters and the listed left out", function()
	local M = Roblox.modules()
	local world = M.world
	local zones = hall(world)
	local c = world:join("Walker")
	world:spawnCharacter(c, { 400, 3, 400 }) -- far off: it would stretch the bounds
	local place = M.Map.bounds(nil, nil)
	t.eq(place, { min = { -50, -30 }, max = { 50, 30 }, top = 10, bottom = -2 }, "the place, without the invisible ceiling or the player")
	local caves = M.Map.bounds(zones.Caves, nil)
	t.eq(caves, { min = { -45, -15 }, max = { -15, 15 }, top = 10, bottom = 0 }, "an invisible zone volume bounds its own map")
	local noWall = M.Map.bounds(nil, { world.server.Workspace.Wall })
	t.eq(noWall.top, 0, "the wall left out: the floor is the top")
end)

t.test("Map.draw: what each ray hits, seen through invisible parts, with players left out and the walls outlined", function()
	local M = Roblox.modules()
	local world = M.world
	hall(world)
	world.water = -0.5 -- below the floor: only seen where there is no floor
	local c = world:join("Walker")
	world:spawnCharacter(c, { 0, 3, 0 })
	local b = { min = { -60, -30 }, max = { 60, 30 }, top = 10, bottom = -2 }
	local rgb, W, H = M.Map.draw(b, { size = 120 })
	t.eq({ W, H }, { 120, 60 }, "120 px across, and the bounds' shape: a stud a pixel")
	local function px(x, z)
		local col = math.floor((x - b.min[1]) / (120 / W))
		local row = math.floor((z - b.min[2]) / (60 / H))
		local i = (row * W + col) * 3
		return { rgb[i + 1], rgb[i + 2], rgb[i + 3] }
	end
	local floor = px(-5, 5)
	t.ok(floor[1] > 80 and floor[1] < 110 and floor[3] > floor[1], "the floor is grey-blue: " .. t.show(floor))
	t.eq(px(0, 0), px(-5, 0), "the player standing at 0, 0 isn't drawn: floor")
	local wall = px(20, 5)
	t.ok(wall[1] > 150 and wall[2] < 60, "the wall is red, and lighter for being higher: " .. t.show(wall))
	t.eq(px(-30, 5), floor, "the invisible zone volume is seen through")
	local water = px(55, 0)
	t.ok(water[3] > water[1] and water[2] > water[1], "past the floor: the terrain's water colour: " .. t.show(water))
	local rim = px(18.2, 5) -- the wall's westmost column, above the floor
	t.ok(rim[1] < wall[1] * 0.7, "a dark rim on the wall's edge: " .. t.show(rim))
	t.eq(px(17.2, 5), floor, "the floor at its foot isn't darkened")
end)

t.test("captureMap: draws the place and sends a map event in a batch of its own, under the game, starting no session", function()
	local world, G, batches = I.game()
	local zones = hall(world)
	local c = world:join("Walker")
	world:startClient(c)
	world:spawnCharacter(c, { 0, 3, 0 })
	local whole, caves
	world:spawn(function()
		whole = G.captureMap({ size = 64 })
		caves = G.captureMap({ zone = "caves", area = zones.Caves, size = 64 })
		G.captureMap({ level = "hall", bounds = { min = { -50, -30 }, max = { 50, 30 } }, size = 64 })
	end)
	world:run(2)
	t.ok(whole and caves, "both drawn")
	t.eq(whole.bounds, { min = { -50, -30 }, max = { 50, 30 } }, "the whole place's bounds")
	t.eq(whole.size, { 64, 38 }, "64 px on the longer side")
	t.eq(string.sub(whole.image, 1, 27), "data:image/jpeg;base64,/9j/", "a JPEG data URL")
	t.ok(#whole.image <= 60000, "within 60 KB: " .. #whole.image)
	local info = jpegInfo(unbase64(string.sub(whole.image, 24)))
	t.eq(info, { soi = true, eoi = true, w = 64, h = 38 }, "a whole JPEG of that size")
	local maps = {}
	for _, b in batches do
		if b.events[1].type == "map" then
			t.eq(#b.events, 1, "a batch of its own")
			t.eq({ b.service, b.role, b.sdk }, { "starlift", nil, "glitchless-roblox/0.3.0" }, "under the game's service")
			t.ok(string.match(b.session_id, "^s_%x+$"), "a session ID of its own")
			table.insert(maps, b.events[1])
			for _, other in batches do
				if other ~= b and other.session_id == b.session_id then
					error("the map's session sent something else")
				end
			end
		end
	end
	t.eq(#maps, 3, "three maps")
	local byKey = {}
	for _, m in maps do
		byKey[(m.level or "-") .. "/" .. (m.zone or "-")] = m
		t.eq(m.axis, "xz", "top-down")
		t.ok(type(m.ts) == "number", "a time")
	end
	t.eq(byKey["-/-"].bounds, whole.bounds, "the whole place: no level, no zone")
	t.eq(byKey["-/caves"].bounds, { min = { -45, -15 }, max = { -15, 15 } }, "the zone's, by its volume")
	t.eq(byKey["hall/-"].size, { 64, 38 }, "the level's, from the bounds given")
	t.eq(byKey["hall/-"].image, whole.image, "the same bounds, the same picture")
end)

t.test("captureMap before init waits for it; on a client it says it's the server's; bad bounds are said", function()
	local world, G, batches, start = I.game({ start = false, studio = true })
	hall(world)
	local map
	world:spawn(function()
		map = G.captureMap({ size = 32 })
	end)
	world:run(2)
	t.eq(map, nil, "waiting")
	start()
	world:run(2)
	t.ok(map, "drawn once Glitchless started")
	local sent = 0
	for _, b in batches do
		if b.events[1].type == "map" then
			sent += 1
		end
	end
	t.eq(sent, 1, "and sent")
	local said = false
	for _, m in world.printed do
		said = said or string.find(m, "[glitchless] map of the place sent: 32×19 px", 1, true) ~= nil
	end
	t.ok(said, "said in Studio's Output: " .. table.concat(world.printed, " | "))
	local c = world:join("Client")
	I.onClient(world, c, function(CG)
		t.eq(CG.captureMap(), nil, "nothing on a client")
	end)
	world:spawn(function()
		t.eq(G.captureMap({ bounds = { min = { 0, 0 }, max = { 0, 10 } } }), nil, "empty bounds")
		t.eq(G.captureMap({ bounds = { min = { "a" } } }), nil, "bounds that aren't")
	end)
	world:run(1)
	local warnings = table.concat(world.warnings, " | ")
	t.ok(string.find(warnings, "server's call", 1, true), "the client was told: " .. warnings)
	t.ok(string.find(warnings, "bounds are empty", 1, true), "empty bounds: " .. warnings)
	t.ok(string.find(warnings, "bounds are { min", 1, true), "bad bounds: " .. warnings)
end)

t.test("in Studio's Edit mode (an agent over Studio's MCP): mapBounds prints JSON and captureMap only draws", function()
	local world = Roblox.world({ studio = true })
	world.editMode = true
	local zones = hall(world)
	local G = world:glitchless(world.server)
	local b = G.mapBounds()
	t.eq(b.min, { -50, -30 }, "returned")
	local z = G.mapBounds(zones.Caves)
	t.eq(z.max, { -15, 15 }, "an area's")
	t.ok(string.find(world.printed[1], '[glitchless] map bounds: {', 1, true), "printed: " .. world.printed[1])
	t.ok(string.find(world.printed[1], '"min":[-50,-30]', 1, true), "as JSON: " .. world.printed[1])
	t.ok(string.find(world.printed[2], "Zones.Caves", 1, true), "naming the area: " .. world.printed[2])
	local map
	world:spawn(function()
		map = G.captureMap({ size = 32 })
	end)
	world:run(1)
	t.ok(map and string.sub(map.image, 1, 23) == "data:image/jpeg;base64,", "drawn")
	t.eq(#world.requests, 0, "nothing sent")
	t.ok(string.find(world.printed[3], "not sent", 1, true), "said: " .. tostring(world.printed[3]))
end)
