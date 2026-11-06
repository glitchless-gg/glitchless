--!strict
-- Glitchless: the game's words, checked before they leave (SPEC §1 setProperties, §2 custom, props, group). A port of
-- packages/sdk/src/props.js and groups.js, with the same rules as every other Glitchless SDK:
--   - session properties: what holds for the session in the game's words (a mode, a rank tier, a car class), never who
--     the player is. Keys that name a person or a device are dropped by name, values that look like an email address,
--     a link, a phone number or an ID by shape;
--   - attributes of custom events and level starts: 12 of them, strings cut to 64 characters, lists of up to 16;
--   - group IDs: 8 to 64 of [A-Za-z0-9_.:-], match and party IDs hashed as "h_" + 24 hex characters of SHA-1.
-- And one rule only Roblox needs: names. A Roblox error names the script it came from by its path, and a player's
-- scripts and character are named after the player (Players.<name>.PlayerGui…, Workspace.<name>.Animate), so every
-- text the SDK sends is scrubbed of the names and user IDs of the players in the server (Words.scrub).

local sha1 = require(script.Parent.Sha1)
local Json = require(script.Parent.Json)

local Words = {}

Words.MAX_PROPS = 12
local PROP_NUMBER = 1000000

local RESERVED = {}
for _, k in
	{
		"version", "level", "env", "platform", "browser", "device_tier", "session_type", "privacy", "role", "link", "type",
		"players", "sessions", "hours", "zone", "match", "party", "run",
		"steam_build", "steam_branch", "steam_hardware", "steam_deck", "steam_controller", "steam_language", "proton",
		"big_picture", "family_shared", "timed_trial",
	}
do
	RESERVED[k] = true
end

local IDENTIFYING = {}
for _, k in
	{
		"name", "username", "user", "email", "phone", "user_id", "account", "account_id", "player_id", "steam_id", "epic_id",
		"psn_id", "xbox_id", "ip", "address", "device_id", "idfa", "gaid", "ad_id", "location", "lat", "lon", "city",
		"birthday", "age", "gender",
		-- Roblox's own words for who a player is.
		"userid", "display_name", "displayname", "roblox_id",
	}
do
	IDENTIFYING[k] = true
end

-- A string cut to `n` characters (UTF-8 code points, so a character is never split in half).
function Words.cut(s: string, n: number): string
	if #s <= n then
		return s
	end
	local ok, at = pcall(utf8.offset, s, n + 1)
	if ok and at then
		return string.sub(s, 1, at - 1)
	end
	return string.sub(s, 1, n)
end

function Words.trim(s: string): string
	return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

-- What a value looks like when it would say who someone is: an email address, a link, a run of 7 digits, a phone
-- number, a UUID, 16 hex characters, or 16 characters of random-looking base64.
local SHAPES = {
	"[^%s@]+@[^%s@]+%.[^%s@]+", -- an email address
	"%a[%w+%.%-]*://", -- a link
	"%f[%w_]www%.", -- www.
	"%d%d%d%d%d%d%d", -- a run of 7 or more digits
	"%+%d[%d%s%(%)%.%-][%d%s%(%)%.%-][%d%s%(%)%.%-][%d%s%(%)%.%-][%d%s%(%)%.%-][%d%s%(%)%.%-][%d%s%(%)%.%-]*%d", -- +44 20 7946 0958
	"%(%d%d%d%)%s?%d%d%d[%s%.%-]?%d%d%d%d", -- (555) 123-4567
	"%f[%w_]%d%d%d[%s%.%-]%d%d%d[%s%.%-]%d%d%d%d%f[^%w_]", -- 555-123-4567
	"%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x", -- a UUID
	"%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x", -- 16 hex characters
}

function Words.looksIdentifying(text: string): boolean
	local lower = string.lower(text)
	for _, p in SHAPES do
		if string.find(lower, p) then
			return true
		end
	end
	for run in string.gmatch(text, "[%w+/=_%-]+") do
		if #run >= 16 and string.find(run, "%u") and string.find(run, "%l") and string.find(run, "%d") then
			return true
		end
	end
	return false
end

-- Why a property key can't be used, or nil when it can.
function Words.propKeyProblem(key: any): string?
	if type(key) ~= "string" or not string.find(key, "^%l[%l%d_]*$") or #key > 32 then
		return "keys are lower-case words of up to 32 characters (a-z, 0-9, _)"
	end
	if RESERVED[key] then
		return "it is a built-in split"
	end
	if IDENTIFYING[key] then
		return "it would say who the player is"
	end
	return nil
end

-- A property value as it is sent, or nil when it is dropped: a string (trimmed, cut to 64 characters, not shaped like
-- an ID), a boolean, or a whole number from -1,000,000 to 1,000,000. An EnumItem goes as its name.
function Words.propValue(value: any): any
	local t = typeof(value)
	if t == "boolean" then
		return value
	elseif t == "number" then
		if value == math.floor(value) and math.abs(value) <= PROP_NUMBER then
			return value
		end
		return nil
	elseif t == "EnumItem" then
		value = value.Name
	elseif t ~= "string" then
		return nil
	end
	local text = Words.cut(Words.trim(value), 64)
	if text == "" or Words.looksIdentifying(text) then
		return nil
	end
	return text
end

local function attrValue(v: any): any
	local t = typeof(v)
	if t == "string" then
		return Words.cut(v, 64)
	elseif t == "boolean" then
		return v
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			return nil
		end
		return v
	elseif t == "EnumItem" then
		return v.Name
	end
	return nil
end

local function listValue(list: { any }): { any }
	local out = Json.array({})
	local seen = {}
	for _, item in list do
		local v = attrValue(item)
		if v ~= nil and not seen[v] then
			seen[v] = true
			table.insert(out, v)
			if #out == 16 then
				break
			end
		end
	end
	return out
end

-- Attributes as a custom event keeps them (SPEC §2 custom): 12 of them by key, strings cut to 64 characters, finite
-- numbers, booleans, and lists of up to 16 distinct strings, numbers or booleans. Anything else (an Instance, a
-- Vector3, a table of tables) is left out. Nil when none is left.
function Words.attrs(attrs: any): { [string]: any }?
	if type(attrs) ~= "table" then
		return nil
	end
	local keys = {}
	for k in attrs do
		if type(k) == "string" then
			table.insert(keys, k)
		end
	end
	table.sort(keys)
	local out = {}
	local n = 0
	for _, k in keys do
		if n >= 12 then
			break
		end
		local v = attrs[k]
		local value
		if type(v) == "table" then
			if #v > 0 then
				value = listValue(v)
			end
		else
			value = attrValue(v)
		end
		if value ~= nil then
			out[Words.cut(k, 64)] = value
			n += 1
		end
	end
	return if n > 0 then out else nil
end

-- An event or counter name: a string of up to 64 characters, or nil.
function Words.name(name: any): string?
	if typeof(name) == "EnumItem" then
		name = name.Name
	end
	if type(name) ~= "string" then
		return nil
	end
	local s = Words.cut(Words.trim(name), 64)
	return if s ~= "" then s else nil
end

-- ───────────────────────────── groups ─────────────────────────────

Words.GROUP_KINDS = { match = true, party = true, run = true }

function Words.validGroupId(id: any): boolean
	return type(id) == "string" and #id >= 8 and #id <= 64 and string.find(id, "^[%w_%.:%-]+$") ~= nil
end

-- The salt is the game's own service even on its server (filed under "<service>.server"), so both sides agree.
function Words.hashGroupId(service: string, id: string): string
	return "h_" .. string.sub(sha1(string.lower(service) .. ":" .. id), 1, 24)
end

-- ───────────────────────────── names ─────────────────────────────

local function escape(s: string): string
	return (string.gsub(s, "[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0"))
end

-- Replaces each name in `names` (a player's name, display name and user ID) where it stands as a whole word (letters
-- and digits; "_" and punctuation around it are word breaks), with
-- "<player>" (a user ID with "<user>"). Names shorter than 3 characters are left alone: they would wreck the message
-- and say nothing on their own.
function Words.scrub(text: string, names: { string }): string
	for _, name in names do
		if #name >= 3 then
			local word = if string.find(name, "^%d+$") then "<user>" else "<player>"
			-- "_" separates words here, so a name inside an identifier goes too (Player_<user>, <player>_house)
			local before = if string.find(name, "^%w") then "%f[%w]" else ""
			local after = if string.find(name, "%w$") then "%f[^%w]" else ""
			text = string.gsub(text, before .. escape(name) .. after, word)
		end
	end
	return text
end

-- The names to scrub as a set for a quick look (each word of a name too, for a display name with spaces), and the
-- list Words.scrub replaces from, longest first.
export type Names = { set: { [string]: boolean }, list: { string } }

function Words.names(list: { string }): Names
	local set = {}
	local kept = {}
	for _, name in list do
		if #name >= 3 then
			set[name] = true
			for word in string.gmatch(name, "%w+") do
				if #word >= 3 then
					set[word] = true
				end
			end
			table.insert(kept, name)
		end
	end
	table.sort(kept, function(a, b)
		return #a > #b
	end)
	return { set = set, list = kept }
end

-- Every string in an event scrubbed of the names, and every number that is one of the user IDs (7 digits or more)
-- dropped, wherever the game put it: an attribute, a level, a zone, a count's words or sums. In place; returns the
-- value, or nil for a dropped number.
function Words.scrubTree(v: any, names: Names): any
	local t = type(v)
	if t == "string" then
		for word in string.gmatch(v, "%w+") do
			if names.set[word] then
				return Words.scrub(v, names.list)
			end
		end
		return v
	elseif t == "number" then
		if v >= 1000000 and v == math.floor(v) and names.set[string.format("%d", v)] then
			return nil
		end
		return v
	elseif t == "table" and v ~= Json.null then
		for k, x in v do
			v[k] = Words.scrubTree(x, names)
		end
		return v
	end
	return v
end

return Words
