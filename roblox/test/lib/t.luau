--!nocheck
-- A tiny test framework for the Roblox SDK's Lune tests: t.test(name, fn), t.eq, t.ok, t.near, and t.run() to report.
local serde = require("@lune/serde")

local t = { tests = {}, only = nil }

function t.test(name, fn)
	table.insert(t.tests, { name = name, fn = fn })
end

local function show(v)
	if type(v) == "table" then
		local ok, s = pcall(serde.encode, "json", v)
		return if ok then s else tostring(v)
	end
	return tostring(v)
end
t.show = show

local function deepEq(a, b)
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" then
		return false
	end
	for k, v in a do
		if not deepEq(v, b[k]) then
			return false
		end
	end
	for k in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end
t.deepEq = deepEq

function t.eq(actual, expected, what)
	if not deepEq(actual, expected) then
		error(string.format("%s: expected %s, got %s", what or "value", show(expected), show(actual)), 2)
	end
end

function t.ok(v, what)
	if not v then
		error((what or "expected a true value") .. " (got " .. show(v) .. ")", 2)
	end
	return v
end

function t.near(actual, expected, tolerance, what)
	if type(actual) ~= "number" or math.abs(actual - expected) > tolerance then
		error(string.format("%s: expected %s ± %s, got %s", what or "value", tostring(expected), tostring(tolerance), show(actual)), 2)
	end
end

-- Runs the tests registered so far; returns how many failed.
function t.run(file)
	local failed = 0
	for _, case in t.tests do
		local ok, err = xpcall(case.fn, debug.traceback)
		if ok then
			print("  ok   " .. case.name)
		else
			failed += 1
			print("  FAIL " .. case.name .. "\n" .. tostring(err))
		end
	end
	t.tests = {}
	return failed
end

return t
