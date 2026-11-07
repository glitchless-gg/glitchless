--!nocheck
-- A fake Roblox world (lib/roblox.luau) whose intake answers like Glitchless and keeps every batch, decoded, and ways
-- to read the batches back: for the tests of the calls made before Glitchless starts, the extras and the map.
local serde = require("@lune/serde")
local Roblox = require("./roblox")

local M = {}

M.TOKEN = "gl_pub_test"

-- A world with Glitchless on its server, started with `opts.options` over the defaults (`opts.start == false`: not
-- started yet; call `start()`). Returns world, the server's Glitchless, the batches, and start.
function M.game(opts)
	opts = opts or {}
	local batches = {}
	local world = Roblox.world({
		studio = opts.studio,
		http = function(req)
			if string.find(req.Url, "/v1/health", 1, true) then
				return { StatusCode = 200, Body = '{"ok":true,"features":["counts","props","groups","zones","net","server_mode"]}', Headers = {} }
			end
			local body = serde.decode("json", req.Body)
			table.insert(batches, body)
			return { StatusCode = 202, Body = '{"accepted":1}', Headers = {} }
		end,
	})
	local G = world:glitchless(world.server)
	local options = { service = "starlift", clientToken = M.TOKEN, intake = "http://glitchless.test", version = "1.0.0" }
	for k, v in opts.options or {} do
		options[k] = v
	end
	local function start()
		world.currentDm = world.server
		G.init(options)
	end
	if opts.start ~= false then
		start()
	end
	return world, G, batches, start
end

function M.sessions(batches)
	local ids, list = {}, {}
	for _, b in batches do
		if not ids[b.session_id] then
			ids[b.session_id] = true
			table.insert(list, { id = b.session_id, role = b.role })
		end
	end
	return list
end

-- Every event a session sent, in order.
function M.eventsOf(batches, sessionId)
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

-- The player sessions (no role, a session_start), in the order they first sent.
function M.playerSessions(batches)
	local out = {}
	for _, s in M.sessions(batches) do
		if s.role == nil then
			for _, e in M.eventsOf(batches, s.id) do
				if e.type == "session_start" then
					table.insert(out, s.id)
					break
				end
			end
		end
	end
	return out
end

function M.serverSession(batches)
	for _, s in M.sessions(batches) do
		if s.role == "server" then
			return s.id
		end
	end
	return nil
end

function M.find(events, pred)
	for _, e in events do
		if pred(e) then
			return e
		end
	end
	return nil
end

function M.ofType(events, ty)
	local out = {}
	for _, e in events do
		if e.type == ty then
			table.insert(out, e)
		end
	end
	return out
end

-- Every events' counts entries of `name`, added up by their attributes (as JSON).
function M.counted(events, name)
	local out = {}
	for _, e in events do
		if e.type == "counts" then
			for _, c in e.counts do
				if c.name == name then
					local key = serde.encode("json", c.attrs or {})
					out[key] = (out[key] or 0) + c.n
				end
			end
		end
	end
	return out
end

-- Runs fn as a LocalScript on the client `c` would.
function M.onClient(world, c, fn)
	world.currentDm = c.dm
	local G = world:glitchless(c.dm)
	fn(G)
	world.currentDm = world.server
	return G
end

return M
