--!strict
-- Glitchless: the JSON every batch is written in.
--
-- HttpService:JSONEncode writes an empty table as [] and lets NaN and inf through, and a batch needs {} for an empty
-- object (a sketch with no buckets, attributes with none), [] for an empty list (a hitch with no causes) and an
-- explicit null in two places (a group that ended, a property removed). So the SDK writes its own: a table is a list
-- when Json.array marked it or its keys are 1..n, an object otherwise; Json.null is null; NaN and inf are null;
-- numbers keep up to 14 significant digits (whole numbers, timestamps among them, are written whole).

local Json = {}

local ARRAY = table.freeze({})
Json.null = table.freeze(setmetatable({}, {
	__tostring = function()
		return "null"
	end,
}))

-- Marks a table as a list, so it is written [] when empty.
function Json.array<T>(t: T): T
	return setmetatable(t :: any, ARRAY) :: any
end

function Json.isArray(t: any): boolean
	return type(t) == "table" and getmetatable(t) == ARRAY
end

local ESCAPES = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\b"] = "\\b",
	["\f"] = "\\f",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local function quote(s: string): string
	return '"'
		.. string.gsub(s, '[%c"\\]', function(c)
			return ESCAPES[c] or string.format("\\u%04x", string.byte(c))
		end)
		.. '"'
end

local function number(n: number): string
	if n ~= n or n == math.huge or n == -math.huge then
		return "null"
	end
	if n == math.floor(n) and math.abs(n) < 2 ^ 53 then
		return string.format("%d", n)
	end
	return string.format("%.14g", n)
end

local function isList(t: { [any]: any }): boolean
	if getmetatable(t) == ARRAY then
		return true
	end
	local n = #t
	if n == 0 then
		return false
	end
	local count = 0
	for _ in t do
		count += 1
	end
	return count == n
end

local function encode(v: any, out: { string }, depth: number)
	local t = type(v)
	if v == nil or v == Json.null then
		table.insert(out, "null")
	elseif t == "boolean" then
		table.insert(out, if v then "true" else "false")
	elseif t == "number" then
		table.insert(out, number(v))
	elseif t == "string" then
		table.insert(out, quote(v))
	elseif t == "table" then
		if depth > 32 then
			table.insert(out, "null")
			return
		end
		if isList(v) then
			table.insert(out, "[")
			for i = 1, #v do
				if i > 1 then
					table.insert(out, ",")
				end
				encode(v[i], out, depth + 1)
			end
			table.insert(out, "]")
		else
			-- Keys in order, so the same event is written the same way every time (and tests can compare text).
			local keys = {}
			for k in v do
				if type(k) == "string" then
					table.insert(keys, k)
				elseif type(k) == "number" then
					table.insert(keys, number(k))
				end
			end
			table.sort(keys)
			table.insert(out, "{")
			for i, k in keys do
				if i > 1 then
					table.insert(out, ",")
				end
				table.insert(out, quote(k))
				table.insert(out, ":")
				local value = v[k]
				if value == nil then
					value = v[tonumber(k) :: any]
				end
				encode(value, out, depth + 1)
			end
			table.insert(out, "}")
		end
	else
		table.insert(out, "null")
	end
end

function Json.encode(v: any): string
	local out = {}
	encode(v, out, 0)
	return table.concat(out)
end

-- Reading JSON: only GET /v1/health's answer, so a small reader is enough. Objects and lists become tables (null
-- becomes nil). Returns nil for text that isn't JSON.
function Json.decode(text: string): any
	local pos = 1
	local function skip()
		pos = (string.find(text, "[^ \t\r\n]", pos) or #text + 1) :: number
	end
	local value: () -> any
	local function str(): string
		local out = {}
		pos += 1
		while true do
			local c = string.sub(text, pos, pos)
			if c == "" then
				error("unterminated string")
			elseif c == '"' then
				pos += 1
				return table.concat(out)
			elseif c == "\\" then
				local e = string.sub(text, pos + 1, pos + 1)
				if e == "u" then
					local code = tonumber(string.sub(text, pos + 2, pos + 5), 16) or 63
					table.insert(out, utf8.char(code))
					pos += 6
				else
					local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
					table.insert(out, map[e] or e)
					pos += 2
				end
			else
				table.insert(out, c)
				pos += 1
			end
		end
	end
	function value(): any
		skip()
		local c = string.sub(text, pos, pos)
		if c == "{" then
			local obj = {}
			pos += 1
			skip()
			if string.sub(text, pos, pos) == "}" then
				pos += 1
				return obj
			end
			while true do
				skip()
				local k = str()
				skip()
				if string.sub(text, pos, pos) ~= ":" then
					error("expected :")
				end
				pos += 1
				obj[k] = value()
				skip()
				local d = string.sub(text, pos, pos)
				pos += 1
				if d == "}" then
					return obj
				elseif d ~= "," then
					error("expected ,")
				end
			end
		elseif c == "[" then
			local arr = Json.array({})
			pos += 1
			skip()
			if string.sub(text, pos, pos) == "]" then
				pos += 1
				return arr
			end
			while true do
				table.insert(arr, value())
				skip()
				local d = string.sub(text, pos, pos)
				pos += 1
				if d == "]" then
					return arr
				elseif d ~= "," then
					error("expected ,")
				end
			end
		elseif c == '"' then
			return str()
		elseif string.sub(text, pos, pos + 3) == "true" then
			pos += 4
			return true
		elseif string.sub(text, pos, pos + 4) == "false" then
			pos += 5
			return false
		elseif string.sub(text, pos, pos + 3) == "null" then
			pos += 4
			return nil
		else
			local s, e = string.find(text, "^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
			if not s then
				error("unexpected " .. c)
			end
			pos = (e :: number) + 1
			return tonumber(string.sub(text, s, e))
		end
	end
	local ok, result = pcall(value)
	return if ok then result else nil
end

return Json
