--!nocheck
-- Runs the Roblox SDK's tests under Lune, from the repository root:
--   lune run roblox/test/run            every *.test.luau
--   lune run roblox/test/run session    the files whose name has "session"
local fs = require("@lune/fs")
local process = require("@lune/process")
local t = require("./lib/t")

local filter = process.args[1]
local files = {}
for _, f in fs.readDir("roblox/test") do
	if string.match(f, "%.test%.luau$") and (not filter or string.find(f, filter, 1, true)) then
		table.insert(files, f)
	end
end
table.sort(files)
local failed, total = 0, 0
for _, f in files do
	print(f)
	local register = require("./" .. string.gsub(f, "%.luau$", ""))
	total += #t.tests
	failed += t.run(f)
end
print(string.format("\n%d test files, %d tests, %d failed", #files, total, failed))
process.exit(if failed > 0 then 1 else 0)
