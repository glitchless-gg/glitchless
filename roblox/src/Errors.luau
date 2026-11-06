--!strict
-- Glitchless: what an error report is made of (SPEC §2 error): the message and stack Roblox gives, read into the
-- fields every Glitchless SDK sends (`source`, `line`, `fn`), and the fingerprint that groups occurrences into one
-- issue, the same as packages/sdk/src/fingerprint.js computes it (roblox/test/errors.test.luau checks the two agree).
--
-- Roblox writes an error as "<script path>:<line>: <message>" (ScriptContext.Error's message, and error() at level 1),
-- and a stack in one of three ways, depending on where it came from:
--   ServerScriptService.Race, line 12 - function onTouched       (ScriptContext.Error)
--   Script 'ServerScriptService.Race', Line 12 - function onTouched
--   ServerScriptService.Race:12 function onTouched                (debug.traceback)
-- The message keeps no path or line, so an error grouped by fingerprint stays one issue when its line moves, and `fn`
-- is the script's name and the function (`Race.onTouched`, `Race` for the script's top level), as Unity's is the class
-- and the method. Paths name players' scripts and characters by the player's name, so callers scrub them first
-- (Words.scrub) and pass the scrubbed text in.

local Words = require(script.Parent.Words)

local Errors = {}

-- ───────────────────────────── the fingerprint ─────────────────────────────

-- A string's UTF-16 code units, as JavaScript sees the string (its length, slice and charCodeAt work in them).
local function utf16(s: string): { number }
	local units = {}
	local ok = pcall(function()
		for _, cp in utf8.codes(s) do
			if cp >= 0x10000 then
				local v = cp - 0x10000
				table.insert(units, 0xD800 + bit32.rshift(v, 10))
				table.insert(units, 0xDC00 + bit32.band(v, 0x3FF))
			else
				table.insert(units, cp)
			end
		end
	end)
	if not ok then
		-- Not UTF-8: bytes, as a browser would read them as Latin-1.
		units = {}
		for i = 1, #s do
			table.insert(units, string.byte(s, i))
		end
	end
	return units
end

local function fromUtf16(units: { number }): string
	local out = {}
	local i = 1
	while i <= #units do
		local u = units[i]
		local nxt = units[i + 1]
		if u >= 0xD800 and u <= 0xDBFF and nxt and nxt >= 0xDC00 and nxt <= 0xDFFF then
			table.insert(out, utf8.char(0x10000 + (u - 0xD800) * 0x400 + (nxt - 0xDC00)))
			i += 2
		else
			-- A lone surrogate (a cut emoji): written as U+FFFD, as a UTF-8 encoder would.
			table.insert(out, utf8.char(if u >= 0xD800 and u <= 0xDFFF then 0xFFFD else u))
			i += 1
		end
	end
	return table.concat(out)
end

-- The message as the fingerprint reads it, as UTF-16 units: no "Uncaught ", runs of 3+ digits as N, hex as X, cut to
-- 200 units.
local function normalizedUnits(message: string): { number }
	local s = string.gsub(message, "^Uncaught%s+", "")
	s = string.gsub(s, "%d%d%d+", "N")
	s = string.gsub(s, "0[xX]%x+", "X")
	local units = utf16(s)
	if #units > 200 then
		units = table.move(units, 1, 200, 1, table.create(200))
	end
	return units
end

function Errors.normalize(message: string): string
	return fromUtf16(normalizedUnits(message))
end

-- 32-bit FNV-1a over UTF-16 units: Math.imul(h, 0x01000193), written so no product needs more than 53 bits.
local function fnv(units: { number }): string
	local h = 0x811C9DC5
	for _, u in units do
		h = bit32.bxor(h, u)
		h = (h * 0x193 + (h % 256) * 0x1000000) % 4294967296
	end
	return string.format("%08x", h)
end

local function concatUnits(...: { number }): { number }
	local out = {}
	for _, part in { ... } do
		table.move(part, 1, #part, #out + 1, out)
	end
	return out
end

function Errors.fingerprint(kind: string, message: string, fn: string?): string
	local bar = { 124 }
	return fnv(concatUnits(utf16(kind), bar, normalizedUnits(message), bar, utf16(fn or "")))
end

-- ───────────────────────────── reading Roblox's text ─────────────────────────────

export type Frame = { source: string, line: number?, fn: string? }

-- One line of a stack, or nil when it isn't a frame.
function Errors.frame(line: string): Frame?
	line = Words.trim(line)
	local source, n, rest = string.match(line, "^Script '(.-)', Line (%d+)(.*)$")
	if not source then
		source, n, rest = string.match(line, "^(.-), line (%d+)(.*)$")
	end
	if not source then
		source, n, rest = string.match(line, "^(.-):(%d+)(.*)$")
	end
	if not source or source == "" then
		return nil
	end
	local fn = string.match(rest or "", "function%s+([^%s]+)")
	return { source = source, line = tonumber(n), fn = fn }
end

-- Whether a script path is inside the Glitchless module (a segment named Glitchless).
function Errors.isOwn(source: string): boolean
	return string.find("." .. source .. ".", "%.Glitchless%.") ~= nil
end

-- The last segment of a script path: its name.
local function scriptName(source: string): string
	return string.match(source, "([^%.]+)$") or source
end

export type Report = {
	message: string,
	stack: string,
	source: string?,
	line: number?,
	fn: string,
	own: boolean,
}

-- An error's message and stack (already scrubbed) read into the fields an error event sends. `own` is true for an
-- error raised inside the SDK itself, which is never sent.
function Errors.read(message: string, stack: string?): Report
	local text = message
	local source, line
	local s, n, rest = string.match(message, "^([^\n]-):(%d+): (.*)$")
	if s and not string.find(s, " ") then
		source, line, text = s, tonumber(n), rest
	end
	local top: Frame? = nil
	for raw in string.gmatch((stack or "") .. "\n", "([^\n]*)\n") do
		local f = Errors.frame(raw)
		if f and not Errors.isOwn(f.source) then
			top = f
			break
		end
	end
	if top and not source then
		source, line = top.source, top.line
	end
	local fn = ""
	if top then
		fn = scriptName(top.source) .. (if top.fn then "." .. top.fn else "")
	elseif source then
		fn = scriptName(source)
	end
	return {
		message = Words.cut(text, 1000),
		stack = Words.cut(stack or "", 4000),
		source = source,
		line = line,
		fn = fn,
		own = source ~= nil and Errors.isOwn(source),
	}
end

return Errors
