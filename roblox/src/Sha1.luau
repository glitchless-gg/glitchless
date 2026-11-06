--!strict
-- Glitchless: SHA-1 of a string, for match and party IDs (SPEC §1 groups). Every Glitchless SDK sends a match's ID as
-- "h_" and the first 24 hex characters of SHA-1("<service, lower case>:<id>"), so a Roblox server, its players and a
-- game's other clients in one match send one ID. Roblox has no hash function scripts can call, so it is written out
-- here with bit32. Luau strings are bytes, so this hashes the UTF-8 the other SDKs hash.

local function sha1(text: string): string
	local len = #text
	local bytes = table.create(len + 72, 0)
	for i = 1, len do
		bytes[i] = string.byte(text, i)
	end
	bytes[len + 1] = 0x80
	local total = len + 1
	while total % 64 ~= 56 do
		total += 1
		bytes[total] = 0
	end
	local bits = len * 8
	for i = 7, 0, -1 do
		total += 1
		bytes[total] = math.floor(bits / 2 ^ (i * 8)) % 256
	end

	local h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
	local w = table.create(80, 0)
	for chunk = 0, total - 1, 64 do
		for t = 0, 15 do
			local o = chunk + t * 4
			w[t + 1] = bit32.bor(bit32.lshift(bytes[o + 1], 24), bit32.lshift(bytes[o + 2], 16), bit32.lshift(bytes[o + 3], 8), bytes[o + 4])
		end
		for t = 17, 80 do
			w[t] = bit32.lrotate(bit32.bxor(w[t - 3], w[t - 8], w[t - 14], w[t - 16]), 1)
		end
		local a, b, c, d, e = h0, h1, h2, h3, h4
		for t = 1, 80 do
			local f, k
			if t <= 20 then
				f, k = bit32.bor(bit32.band(b, c), bit32.band(bit32.bnot(b), d)), 0x5A827999
			elseif t <= 40 then
				f, k = bit32.bxor(b, c, d), 0x6ED9EBA1
			elseif t <= 60 then
				f, k = bit32.bor(bit32.band(b, c), bit32.band(b, d), bit32.band(c, d)), 0x8F1BBCDC
			else
				f, k = bit32.bxor(b, c, d), 0xCA62C1D6
			end
			local tmp = (bit32.lrotate(a, 5) + f + e + k + w[t]) % 4294967296
			e, d, c, b, a = d, c, bit32.lrotate(b, 30), a, tmp
		end
		h0 = (h0 + a) % 4294967296
		h1 = (h1 + b) % 4294967296
		h2 = (h2 + c) % 4294967296
		h3 = (h3 + d) % 4294967296
		h4 = (h4 + e) % 4294967296
	end
	return string.format("%08x%08x%08x%08x%08x", h0, h1, h2, h3, h4)
end

return sha1
