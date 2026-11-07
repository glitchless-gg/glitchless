--!strict
-- Glitchless: a top-down picture of a Roblox place, drawn by the server, for the background of a heatmap
-- (SPEC §2 `map`, §5e). The browser SDKs render one with an orthographic camera; a Roblox script can't render or read
-- the screen (CaptureService takes a screenshot only on a player's device, when the player chooses, and reading its
-- pixels needs EditableImage, which a published experience can use only with an ID-verified owner). So the server
-- draws the place instead: one ray straight down for each pixel (workspace:Raycast), coloured by what it hits (a
-- part's Color, or the terrain material's colour), lit by the surface's slope and its height, with a dark line where
-- the height jumps (a wall's edge), so the picture reads like a floor plan. Players' characters and anything the game
-- lists are left out, and fully transparent parts (zone volumes, invisible walls) are seen through.
--   - Map.bounds(area): the place's extent on the x and z axes (or an area's: a part, a model or a folder, such as a
--     zone's volume), with the heights its parts reach;
--   - Map.capture(options): the picture, as the JPEG data URL a `map` event carries (Jpeg.luau), within 60 KB.
-- Both spread their work over frames (3 ms of a frame at most), so a server never stutters for it.

local Players = game:GetService("Players")

local Jpeg = require(script.Parent.Jpeg)

local Map = {}

Map.DEFAULT_SIZE = 256
Map.MAX_SIZE = 512
Map.MAX_CHARS = 60000 -- the data URL, as every SDK keeps it (SPEC §2 map)
local BUDGET_S = 0.003 -- of a frame's time, at most, before it waits for the next frame
local INVISIBLE = 0.95 -- a part at least this transparent is seen through
local BACKGROUND = { 24, 27, 33 } -- where a ray hits nothing

export type Bounds = { min: { number }, max: { number }, top: number, bottom: number }

-- A function to call often during long work: past the frame budget it waits for the next frame.
local function pacer(): () -> ()
	local since = os.clock()
	return function()
		if os.clock() - since >= BUDGET_S then
			task.wait()
			since = os.clock()
		end
	end
end

local function round(v: number, step: number): number
	return math.floor(v / step + 0.5) * step
end

-- A part's box in the world, turned as it is: min x, y, z, max x, y, z.
local function extents(part: BasePart): (number, number, number, number, number, number)
	local cf, size = part.CFrame, part.Size
	local r, u, l = cf.RightVector, cf.UpVector, cf.LookVector
	local hx, hy, hz = size.X / 2, size.Y / 2, size.Z / 2
	local ex = math.abs(r.X) * hx + math.abs(u.X) * hy + math.abs(l.X) * hz
	local ey = math.abs(r.Y) * hx + math.abs(u.Y) * hy + math.abs(l.Y) * hz
	local ez = math.abs(r.Z) * hx + math.abs(u.Z) * hy + math.abs(l.Z) * hz
	local p = cf.Position
	return p.X - ex, p.Y - ey, p.Z - ez, p.X + ex, p.Y + ey, p.Z + ez
end

-- What a map leaves out: players' characters, the camera's own things, and what the game lists.
local function leftOut(exclude: { Instance }?): { Instance }
	local out: { Instance } = {}
	for _, p in Players:GetPlayers() do
		if p.Character then
			table.insert(out, p.Character)
		end
	end
	local camera = workspace.CurrentCamera
	if typeof(camera) == "Instance" then
		table.insert(out, camera :: Instance)
	end
	for _, inst in exclude or {} do
		if typeof(inst) == "Instance" then
			table.insert(out, inst)
		end
	end
	return out
end

local function isTerrain(inst: Instance): boolean
	return inst.ClassName == "Terrain"
end

-- The extent on x and z (and the heights) of an area's parts: every part in it, seen or not (a zone is often an
-- invisible volume), or, for the whole place (no area), every part a player can see. Nil when there is none.
function Map.bounds(area: Instance?, exclude: { Instance }?): Bounds?
	local root: Instance = area or workspace
	local visibleOnly = area == nil
	local skip: { [Instance]: boolean } = {}
	for _, inst in leftOut(exclude) do
		skip[inst] = true
		for _, d in inst:GetDescendants() do
			skip[d] = true
		end
	end
	local parts: { Instance } = root:GetDescendants()
	if root:IsA("BasePart") then
		table.insert(parts, root)
	end
	local x0, y0, z0, x1, y1, z1 = math.huge, math.huge, math.huge, -math.huge, -math.huge, -math.huge
	local pace = pacer()
	for i, inst in parts do
		if i % 256 == 0 then
			pace()
		end
		if inst:IsA("BasePart") and not isTerrain(inst) and not skip[inst] then
			local part = inst :: BasePart
			if not (visibleOnly and part.Transparency >= INVISIBLE) then
				local a, b, c, d, e, f = extents(part)
				x0, y0, z0 = math.min(x0, a), math.min(y0, b), math.min(z0, c)
				x1, y1, z1 = math.max(x1, d), math.max(y1, e), math.max(z1, f)
			end
		end
	end
	if x0 == math.huge then
		return nil
	end
	return {
		min = { round(x0, 0.1), round(z0, 0.1) },
		max = { round(x1, 0.1), round(z1, 0.1) },
		top = round(y1, 0.1),
		bottom = round(y0, 0.1),
	}
end

-- Leaves `inst` out of the rays from now on (a transparent part one hit).
local function addToFilter(params: RaycastParams, inst: Instance)
	local ok = pcall(function()
		(params :: any):AddToFilter(inst)
	end)
	if not ok then
		local list = params.FilterDescendantsInstances
		table.insert(list, inst)
		params.FilterDescendantsInstances = list
	end
end

local LIGHT = (function()
	local x, y, z = -0.35, 0.85, -0.4
	local n = math.sqrt(x * x + y * y + z * z)
	return { x / n, y / n, z / n }
end)()

export type Options = {
	bounds: Bounds?,
	area: Instance?,
	top: number?,
	size: number?,
	exclude: { Instance }?,
}

-- The pixels of the map: a flat list of red, green, blue (0–255), row by row, the first row at the bounds' smallest z
-- and the first column at their smallest x (as a dashboard draws an xz map), with its width and height.
function Map.draw(b: Bounds, options: Options): ({ number }, number, number)
	local spanX, spanZ = b.max[1] - b.min[1], b.max[2] - b.min[2]
	local size = math.clamp(math.floor(options.size or Map.DEFAULT_SIZE), 16, Map.MAX_SIZE)
	local W, H
	if spanX >= spanZ then
		W, H = size, math.max(1, math.floor(size * spanZ / math.max(spanX, 1e-6) + 0.5))
	else
		W, H = math.max(1, math.floor(size * spanX / math.max(spanZ, 1e-6) + 0.5)), size
	end
	local dx, dz = spanX / W, spanZ / H
	local top = (options.top or b.top) + 1
	local bottom = b.bottom - 1
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = leftOut(options.exclude)
	params.IgnoreWater = false
	local terrain = workspace:FindFirstChildOfClass("Terrain")
	local down = Vector3.new(0, bottom - top, 0)
	local n = W * H
	local heights = table.create(n, -math.huge)
	local rgb = table.create(n * 3, 0)
	local pace = pacer()
	local lit = 0
	for row = 0, H - 1 do
		local z = b.min[2] + (row + 0.5) * dz
		for col = 0, W - 1 do
			local x = b.min[1] + (col + 0.5) * dx
			local i = row * W + col
			local hit
			for _ = 1, 8 do -- through at most 8 invisible parts
				hit = workspace:Raycast(Vector3.new(x, top, z), down, params)
				local inst = hit and hit.Instance
				if inst and inst:IsA("BasePart") and not isTerrain(inst) and (inst :: BasePart).Transparency >= INVISIBLE then
					addToFilter(params, inst)
					hit = nil
				else
					break
				end
			end
			if hit then
				lit += 1
				local inst = hit.Instance
				local color: Color3?
				if terrain and inst == terrain then
					if hit.Material == Enum.Material.Water then
						color = terrain.WaterColor
					else
						pcall(function()
							color = terrain:GetMaterialColor(hit.Material)
						end)
					end
				elseif inst:IsA("BasePart") then
					color = (inst :: BasePart).Color
				end
				local c = color or Color3.new(0.6, 0.6, 0.6)
				local nrm = hit.Normal
				local slope = math.max(0, nrm.X * LIGHT[1] + nrm.Y * LIGHT[2] + nrm.Z * LIGHT[3])
				local high = (hit.Position.Y - bottom) / math.max(top - bottom, 1e-6)
				local shade = (0.6 + 0.4 * slope) * (0.85 + 0.15 * math.clamp(high, 0, 1))
				heights[i + 1] = hit.Position.Y
				rgb[i * 3 + 1] = c.R * 255 * shade
				rgb[i * 3 + 2] = c.G * 255 * shade
				rgb[i * 3 + 3] = c.B * 255 * shade
			else
				rgb[i * 3 + 1], rgb[i * 3 + 2], rgb[i * 3 + 3] = BACKGROUND[1], BACKGROUND[2], BACKGROUND[3]
			end
			if col % 32 == 31 then
				pace()
			end
		end
		pace()
	end
	-- A dark rim on whatever stands more than a stud and a half above a neighbour (a wall's top, a ledge, a floor's
	-- edge over a drop), so raised things read as outlined shapes.
	local step = 1.5
	for row = 0, H - 1 do
		for col = 0, W - 1 do
			local i = row * W + col
			local h = heights[i + 1]
			local edge = h ~= -math.huge
				and (
					(col > 0 and heights[i] < h - step)
					or (col < W - 1 and heights[i + 2] < h - step)
					or (row > 0 and heights[i - W + 1] < h - step)
					or (row < H - 1 and heights[i + W + 1] < h - step)
				)
			for k = 1, 3 do
				local v = rgb[i * 3 + k]
				if edge then
					v *= 0.6
				end
				rgb[i * 3 + k] = math.clamp(math.floor(v + 0.5), 0, 255)
			end
		end
	end
	return rgb, W, H
end

-- Half the size, each pixel the average of four.
local function halve(rgb: { number }, W: number, H: number): ({ number }, number, number)
	local w2, h2 = math.max(1, W // 2), math.max(1, H // 2)
	local out = table.create(w2 * h2 * 3, 0)
	for y = 0, h2 - 1 do
		for x = 0, w2 - 1 do
			for k = 1, 3 do
				local sum, count = 0, 0
				for oy = 0, 1 do
					for ox = 0, 1 do
						local sx, sy = math.min(x * 2 + ox, W - 1), math.min(y * 2 + oy, H - 1)
						sum += rgb[(sy * W + sx) * 3 + k]
						count += 1
					end
				end
				out[(y * w2 + x) * 3 + k] = math.floor(sum / count + 0.5)
			end
		end
	end
	return out, w2, h2
end

-- The map as a `map` event wants it: { bounds = { min, max }, size = { w, h }, image = data URL } and the heights it
-- covers (top, bottom). Nil and why when there is nothing to draw.
function Map.capture(options: Options): (any, string?)
	local b = options.bounds
	if b ~= nil then
		local given: any = b
		local ok = type(given) == "table" and type(given.min) == "table" and type(given.max) == "table"
		for _, v in if ok then { given.min[1], given.min[2], given.max[1], given.max[2] } else {} do
			ok = ok and type(v) == "number" and v == v and math.abs(v) < 1e6
		end
		if not ok then
			return nil, "bounds are { min = { x, z }, max = { x, z } } in studs"
		end
		if type(given.top) ~= "number" or type(given.bottom) ~= "number" then
			-- the heights the rays cover: the place's
			local place = Map.bounds(nil, options.exclude)
			b = {
				min = { given.min[1], given.min[2] },
				max = { given.max[1], given.max[2] },
				top = if type(given.top) == "number" then given.top elseif place then place.top else 100,
				bottom = if type(given.bottom) == "number" then given.bottom elseif place then place.bottom else -100,
			}
		end
	else
		b = Map.bounds(options.area, options.exclude)
	end
	if not b then
		return nil, if options.area then "the area has no parts" else "the place has no parts to draw"
	end
	if not (b.max[1] > b.min[1] and b.max[2] > b.min[2]) then
		return nil, "the bounds are empty: max must be past min on both axes"
	end
	local rgb, W, H = Map.draw(b, options)
	local pace = pacer()
	local image: string? = nil
	for _ = 1, 4 do
		local quality = 80
		while true do
			image = Jpeg.dataUrl(Jpeg.encode(rgb, W, H, quality, pace))
			if #(image :: string) <= Map.MAX_CHARS or quality <= 35 then
				break
			end
			quality -= 15
		end
		if #(image :: string) <= Map.MAX_CHARS or W <= 32 or H <= 32 then
			break
		end
		rgb, W, H = halve(rgb, W, H)
	end
	if not image or #image > Map.MAX_CHARS then
		return nil, "the picture doesn't fit in 60 KB"
	end
	return {
		axis = "xz",
		bounds = { min = b.min, max = b.max },
		size = { W, H },
		image = image,
		top = options.top or b.top,
		bottom = b.bottom,
	}, nil
end

return Map
