--!strict
-- Glitchless: sending batches from a Roblox server (SPEC §2 intake, batch_id; §5e).
--
-- Intake takes one session's batch a request, and a Roblox server may make 500 HTTP requests a minute for everything
-- the game does. So Glitchless keeps to a budget of its own (`perMinute`, 100 by default): a token bucket every
-- request takes from, the health check and retries included. The server (Server.luau) cuts each session's batch on
-- its own turn, so with many players each one's batches come less often and hold more, rather than the requests
-- outgrowing the budget. A batch keeps its batch_id through every retry, so intake stores it once:
--   2xx                 sent
--   401, 403            the client token was refused: say so once, and send nothing more
--   400, 413, 422       the batch can't be taken: drop it, say so once
--   429                 wait for Retry-After, then go on
--   anything else       try again later: 2 s, 4 s, 8 s… up to 5 minutes, at most 12 tries
-- HttpService failing with HTTP requests turned off (Game Settings → Security → Allow HTTP Requests) is said once
-- and retried every 30 s, so turning it on in a running server starts the sends.
-- Pure Luau: the request itself is a function the server passes in (HttpService:RequestAsync, or a test's fake).

local Json = require(script.Parent.Json)

local Sender = {}
Sender.__index = Sender

local MAX_PENDING = 300 -- batches waiting, across every session (the oldest are dropped past this)
local MAX_TRIES = 12
local MAX_IN_FLIGHT = 6

export type Request = { url: string, method: string, body: string?, gzip: boolean? }
export type Response = { status: number, body: string?, headers: { [string]: string }? }

export type Config = {
	intake: string,
	token: string,
	perMinute: number?,
	-- Makes a request and yields until its answer: (true, response) or (false, error message).
	request: (Request) -> (boolean, any),
	spawn: (() -> ()) -> (),
	now: () -> number, -- seconds, a monotonic clock
	warn: (key: string, message: string) -> (),
}

function Sender.new(cfg: Config)
	local perMinute = math.max(cfg.perMinute or 100, 6)
	local self = setmetatable({
		cfg = cfg,
		perMinute = perMinute,
		tokens = math.max(perMinute / 4, 2),
		capacity = math.max(perMinute / 4, 2),
		refilledAt = cfg.now(),
		pending = {} :: { any },
		inFlight = 0,
		pausedUntil = 0,
		stopped = nil :: string?, -- why nothing more is sent
		features = nil :: { [string]: boolean }?,
		healthAt = -math.huge,
		healthInFlight = false,
		sent = 0,
		failed = 0,
		requests = 0,
	}, Sender)
	return self
end

export type Sender = typeof(Sender.new(...))

local function url(self: Sender, path: string): string
	local base = string.gsub(self.cfg.intake, "/+$", "")
	return base .. path
end

function Sender.refill(self: Sender)
	local t = self.cfg.now()
	self.tokens = math.min(self.capacity, self.tokens + (t - self.refilledAt) * self.perMinute / 60)
	self.refilledAt = t
end

function Sender.take(self: Sender): boolean
	self:refill()
	if self.tokens < 1 then
		return false
	end
	self.tokens -= 1
	self.requests += 1
	return true
end

-- ───────────────────────────── GET /v1/health ─────────────────────────────

-- What the server takes (SPEC §2 /v1/health `features`): asked at start and every 15 s until it answers.
function Sender.checkHealth(self: Sender)
	if self.features or self.stopped or self.healthInFlight then
		return
	end
	local t = self.cfg.now()
	if t - self.healthAt < 15 or t < self.pausedUntil then
		return
	end
	if not self:take() then
		return
	end
	self.healthAt = t
	self.healthInFlight = true
	self.cfg.spawn(function()
		local ok, res = self.cfg.request({ url = url(self, "/v1/health"), method = "GET" })
		self.healthInFlight = false
		if not ok then
			self:requestFailed(res)
			return
		end
		if res.status < 200 or res.status >= 300 then
			return
		end
		local data = Json.decode(res.body or "")
		if type(data) ~= "table" then
			return
		end
		local features = {}
		if type(data.features) == "table" then
			for k, v in data.features do
				if type(k) == "number" and type(v) == "string" then
					features[v] = true
				elseif type(k) == "string" and v == true then
					features[k] = true
				end
			end
		end
		self.features = features
	end)
end

-- Whether the server takes `feature`: true, false, or nil while it hasn't answered.
function Sender.has(self: Sender, feature: string): boolean?
	if not self.features then
		return nil
	end
	return self.features[feature] == true
end

-- ───────────────────────────── batches ─────────────────────────────

-- Queues a batch (the envelope, with its batch_id). `server`: a server-role batch, which waits until /v1/health
-- lists server_mode and is dropped when it doesn't.
function Sender.add(self: Sender, envelope: any, server: boolean?)
	if self.stopped then
		return
	end
	table.insert(self.pending, { envelope = envelope, server = server == true, tries = 0, nextAt = 0 })
	if #self.pending > MAX_PENDING then
		table.remove(self.pending, 1)
		self.cfg.warn("pending", "more than " .. MAX_PENDING .. " batches are waiting to be sent: the oldest are dropped")
	end
end

function Sender.requestFailed(self: Sender, message: any)
	local m = tostring(message)
	if string.find(m, "not enabled", 1, true) then
		self.cfg.warn("http-off", "HTTP requests are turned off for this experience, so Glitchless can't send: turn on Allow HTTP Requests (Game Settings → Security)")
		self.pausedUntil = self.cfg.now() + 30
	elseif string.find(string.lower(m), "limit", 1, true) then
		-- HttpService's own limit (500 a minute for the whole server): the game's requests come first
		self.pausedUntil = self.cfg.now() + 10
	end
end

-- The body as it goes: counters left out for a server that doesn't take them.
function Sender.body(self: Sender, envelope: any): string
	if self:has("counts") == false then
		local kept = Json.array({})
		for _, e in envelope.events do
			if e.type ~= "counts" then
				table.insert(kept, e)
			end
		end
		envelope.events = kept
	end
	return Json.encode(envelope)
end

function Sender.send(self: Sender, item: any)
	self.inFlight += 1
	item.inFlight = true
	self.cfg.spawn(function()
		local body = self:body(item.envelope)
		local ok, res = self.cfg.request({
			url = url(self, "/v1/intake?token=" .. self.cfg.token),
			method = "POST",
			body = body,
			gzip = #body > 1024,
		})
		self.inFlight -= 1
		item.inFlight = false
		local status = if ok and type(res) == "table" then res.status else 0
		if status >= 200 and status < 300 then
			self.sent += 1
			self:remove(item)
			return
		end
		if not ok then
			self:requestFailed(res)
		end
		if status == 401 or status == 403 then
			self.stopped = "token"
			self.pending = {}
			self.cfg.warn("token", "the Glitchless server refused the client token (HTTP " .. status .. "): check clientToken; nothing more is sent")
			return
		elseif status == 400 or status == 413 or status == 422 then
			self.failed += 1
			self:remove(item)
			self.cfg.warn("rejected", "the Glitchless server couldn't take a batch (HTTP " .. status .. "): " .. string.sub(tostring(res.body), 1, 200))
			return
		elseif status == 429 then
			local after = tonumber(res.headers and (res.headers["retry-after"] or res.headers["Retry-After"])) or 5
			self.pausedUntil = self.cfg.now() + math.clamp(after, 1, 120)
			item.nextAt = self.pausedUntil
			return
		end
		item.tries += 1
		if item.tries >= MAX_TRIES then
			self.failed += 1
			self:remove(item)
			return
		end
		item.nextAt = self.cfg.now() + math.min(300, 2 ^ item.tries)
	end)
end

function Sender.remove(self: Sender, item: any)
	local i = table.find(self.pending, item)
	if i then
		table.remove(self.pending, i)
	end
end

-- Called every second: sends what is due, as the budget allows. `force` (the server closing) sends everything now.
function Sender.pump(self: Sender, force: boolean?)
	if self.stopped then
		return
	end
	self:checkHealth()
	local t = self.cfg.now()
	if t < self.pausedUntil and not force then
		return
	end
	local serverOk = self:has("server_mode")
	-- A snapshot: a send whose answer comes at once (a test's fake) removes its batch while this goes through them.
	for _, item in table.clone(self.pending) do
		if self.stopped then
			return
		end
		if item.inFlight or (item.nextAt > t and not force) or not table.find(self.pending, item) then
			continue
		end
		if item.server and serverOk == false then
			-- an older Glitchless server: it would file the server's sessions among the players'
			self.cfg.warn("server-mode", "this Glitchless server doesn't keep game servers apart from players yet (no server_mode in /v1/health): the server's own session isn't sent")
			self:remove(item)
			continue
		end
		if item.server and serverOk == nil and not force then
			continue
		end
		if self.inFlight >= MAX_IN_FLIGHT and not force then
			break
		end
		if not force and not self:take() then
			break
		end
		if force then
			self.requests += 1
		end
		self:send(item)
	end
end

-- Batches not yet taken by the server (being sent or waiting).
function Sender.waiting(self: Sender): number
	return #self.pending
end

-- The player turned Glitchless off, or the game did: nothing waiting goes.
function Sender.clear(self: Sender, filter: ((envelope: any) -> boolean)?)
	if not filter then
		self.pending = {}
		return
	end
	local kept = {}
	for _, item in self.pending do
		if item.inFlight or not filter(item.envelope) then
			table.insert(kept, item)
		end
	end
	self.pending = kept
end

return Sender
