--!strict
-- Glitchless: a baseline JPEG encoder in plain Luau, for the map a Roblox server draws of its place (Map.luau,
-- SPEC §5e `map`). Roblox gives scripts no way to save an image, so the pixels the server worked out become a JPEG
-- data URL here, the format every Glitchless SDK sends a map in (§2 `map`: at most 60 KB).
--
-- Baseline, 8-bit, YCbCr with no chroma subsampling (a map is flat colours and sharp edges, which subsampling smears),
-- the standard quantization tables scaled by quality as libjpeg does, the standard Huffman tables (JPEG Annex K), and
-- the float AAN DCT. `yield` is called between rows of blocks, so a caller can spread the work over frames.
-- Pure Luau: no Roblox APIs, so Lune drives it in roblox/test.

local Jpeg = {}

-- The order coefficients are written in: the natural (row-major) index of each zigzag position.
local ZIGZAG = {
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
	12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
	35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
	58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
}

-- Annex K.1, in natural order.
local LUMA_Q = {
	16, 11, 10, 16, 24, 40, 51, 61,
	12, 12, 14, 19, 26, 58, 60, 55,
	14, 13, 16, 24, 40, 57, 69, 56,
	14, 17, 22, 29, 51, 87, 80, 62,
	18, 22, 37, 56, 68, 109, 103, 77,
	24, 35, 55, 64, 81, 104, 113, 92,
	49, 64, 78, 87, 103, 121, 120, 101,
	72, 92, 95, 98, 112, 100, 103, 99,
}
local CHROMA_Q = {
	17, 18, 24, 47, 99, 99, 99, 99,
	18, 21, 26, 66, 99, 99, 99, 99,
	24, 26, 56, 99, 99, 99, 99, 99,
	47, 66, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
	99, 99, 99, 99, 99, 99, 99, 99,
}

-- Annex K.3: the code lengths (how many codes of each length 1–16) and the values they stand for.
local DC_LUMA_BITS = { 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0 }
local DC_CHROMA_BITS = { 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0 }
local DC_VALUES = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 }
local AC_LUMA_BITS = { 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d }
local AC_LUMA_VALUES = {
	0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
	0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
	0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
	0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
	0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
	0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
	0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
	0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
	0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
	0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
	0xf9, 0xfa,
}
local AC_CHROMA_BITS = { 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77 }
local AC_CHROMA_VALUES = {
	0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
	0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
	0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
	0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
	0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
	0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
	0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
	0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
	0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
	0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
	0xf9, 0xfa,
}

-- The float AAN DCT leaves each coefficient scaled by these (per row and per column); the quantizer takes them out.
local AAN = { 1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379 }

type Huffman = { codes: { [number]: number }, sizes: { [number]: number } }

-- The canonical codes for a table's lengths and values.
local function huffman(bits: { number }, values: { number }): Huffman
	local codes, sizes = {}, {}
	local code, k = 0, 1
	for len = 1, 16 do
		for _ = 1, bits[len] do
			local v = values[k]
			codes[v] = code
			sizes[v] = len
			code += 1
			k += 1
		end
		code *= 2
	end
	return { codes = codes, sizes = sizes }
end

local DC_LUMA = huffman(DC_LUMA_BITS, DC_VALUES)
local DC_CHROMA = huffman(DC_CHROMA_BITS, DC_VALUES)
local AC_LUMA = huffman(AC_LUMA_BITS, AC_LUMA_VALUES)
local AC_CHROMA = huffman(AC_CHROMA_BITS, AC_CHROMA_VALUES)

-- A base table scaled to `quality` (1–100) as libjpeg scales it: the table, natural order.
local function scaled(base: { number }, quality: number): { number }
	local q = math.clamp(math.floor(quality), 1, 100)
	local scale = if q < 50 then math.floor(5000 / q) else 200 - q * 2
	local out = {}
	for i = 1, 64 do
		out[i] = math.clamp(math.floor((base[i] * scale + 50) / 100), 1, 255)
	end
	return out
end

-- The multipliers that quantize the AAN DCT's output: 1 / (q × the AAN scale of its row and column × 8).
local function divisors(q: { number }): { number }
	local out = {}
	for row = 0, 7 do
		for col = 0, 7 do
			local i = row * 8 + col + 1
			out[i] = 1 / (q[i] * AAN[row + 1] * AAN[col + 1] * 8)
		end
	end
	return out
end

-- ───────────────────────────── writing bits ─────────────────────────────

type Writer = { bytes: { number }, acc: number, n: number }

local function newWriter(): Writer
	return { bytes = {}, acc = 0, n = 0 }
end

local function byte(w: Writer, b: number)
	table.insert(w.bytes, b)
end

local function word(w: Writer, v: number)
	table.insert(w.bytes, bit32.rshift(v, 8))
	table.insert(w.bytes, bit32.band(v, 0xff))
end

-- `size` bits of `code`, most significant first. A 0xFF in the scan is followed by 0x00 (byte stuffing).
local function bits(w: Writer, code: number, size: number)
	if size == 0 then
		return
	end
	w.acc = bit32.bor(bit32.lshift(w.acc, size), bit32.band(code, bit32.lshift(1, size) - 1))
	w.n += size
	while w.n >= 8 do
		w.n -= 8
		local b = bit32.band(bit32.rshift(w.acc, w.n), 0xff)
		table.insert(w.bytes, b)
		if b == 0xff then
			table.insert(w.bytes, 0)
		end
	end
	w.acc = bit32.band(w.acc, bit32.lshift(1, w.n) - 1)
end

local function flush(w: Writer)
	if w.n > 0 then
		bits(w, 0x7f, 8 - w.n) -- pad with 1s
	end
end

-- ───────────────────────────── one block ─────────────────────────────

-- The DCT of an 8×8 block in place (`d`, natural order, values level-shifted to −128…127), then quantized.
local function dctQuant(d: { number }, div: { number }, out: { number })
	for row = 0, 56, 8 do
		local d0, d1, d2, d3 = d[row + 1], d[row + 2], d[row + 3], d[row + 4]
		local d4, d5, d6, d7 = d[row + 5], d[row + 6], d[row + 7], d[row + 8]
		local t0, t7 = d0 + d7, d0 - d7
		local t1, t6 = d1 + d6, d1 - d6
		local t2, t5 = d2 + d5, d2 - d5
		local t3, t4 = d3 + d4, d3 - d4
		local t10, t13 = t0 + t3, t0 - t3
		local t11, t12 = t1 + t2, t1 - t2
		d[row + 1] = t10 + t11
		d[row + 5] = t10 - t11
		local z1 = (t12 + t13) * 0.707106781
		d[row + 3] = t13 + z1
		d[row + 7] = t13 - z1
		t10, t11, t12 = t4 + t5, t5 + t6, t6 + t7
		local z5 = (t10 - t12) * 0.382683433
		local z2 = 0.541196100 * t10 + z5
		local z4 = 1.306562965 * t12 + z5
		local z3 = t11 * 0.707106781
		local z11, z13 = t7 + z3, t7 - z3
		d[row + 6] = z13 + z2
		d[row + 4] = z13 - z2
		d[row + 2] = z11 + z4
		d[row + 8] = z11 - z4
	end
	for col = 1, 8 do
		local d0, d1, d2, d3 = d[col], d[col + 8], d[col + 16], d[col + 24]
		local d4, d5, d6, d7 = d[col + 32], d[col + 40], d[col + 48], d[col + 56]
		local t0, t7 = d0 + d7, d0 - d7
		local t1, t6 = d1 + d6, d1 - d6
		local t2, t5 = d2 + d5, d2 - d5
		local t3, t4 = d3 + d4, d3 - d4
		local t10, t13 = t0 + t3, t0 - t3
		local t11, t12 = t1 + t2, t1 - t2
		d[col] = t10 + t11
		d[col + 32] = t10 - t11
		local z1 = (t12 + t13) * 0.707106781
		d[col + 16] = t13 + z1
		d[col + 48] = t13 - z1
		t10, t11, t12 = t4 + t5, t5 + t6, t6 + t7
		local z5 = (t10 - t12) * 0.382683433
		local z2 = 0.541196100 * t10 + z5
		local z4 = 1.306562965 * t12 + z5
		local z3 = t11 * 0.707106781
		local z11, z13 = t7 + z3, t7 - z3
		d[col + 40] = z13 + z2
		d[col + 24] = z13 - z2
		d[col + 8] = z11 + z4
		d[col + 56] = z11 - z4
	end
	for i = 1, 64 do
		local v = d[i] * div[i]
		out[i] = if v >= 0 then math.floor(v + 0.5) else -math.floor(-v + 0.5)
	end
end

-- How many bits a value needs, and those bits as JPEG writes them (negative values one less, in that many bits).
local function category(v: number): (number, number)
	local a = if v < 0 then -v else v
	local n = 0
	while a > 0 do
		a = bit32.rshift(a, 1)
		n += 1
	end
	return n, if v < 0 then v + bit32.lshift(1, n) - 1 else v
end

-- Writes one quantized block; returns its DC value for the next block's difference.
local function block(w: Writer, q: { number }, prevDc: number, dc: Huffman, ac: Huffman): number
	local n, v = category(q[1] - prevDc)
	bits(w, dc.codes[n], dc.sizes[n])
	bits(w, v, n)
	local run = 0
	for k = 2, 64 do
		local c = q[ZIGZAG[k] + 1]
		if c == 0 then
			run += 1
		else
			while run > 15 do
				bits(w, ac.codes[0xf0], ac.sizes[0xf0])
				run -= 16
			end
			local cn, cv = category(c)
			local sym = run * 16 + cn
			bits(w, ac.codes[sym], ac.sizes[sym])
			bits(w, cv, cn)
			run = 0
		end
	end
	if run > 0 then
		bits(w, ac.codes[0], ac.sizes[0])
	end
	return q[1]
end

-- ───────────────────────────── the file ─────────────────────────────

local function dht(w: Writer, class: number, bitsList: { number }, values: { number })
	byte(w, class)
	for _, b in bitsList do
		byte(w, b)
	end
	for _, v in values do
		byte(w, v)
	end
end

-- The JPEG of a `width`×`height` image whose pixels are `rgb` (a flat list of red, green, blue, 0–255, row by row
-- from the top), at `quality` (1–100), as a string. `yield`, when given, is called after each row of blocks.
function Jpeg.encode(rgb: { number }, width: number, height: number, quality: number, yield: (() -> ())?): string
	assert(width >= 1 and height >= 1 and width <= 65535 and height <= 65535, "Jpeg.encode: a size of 1 to 65535")
	local qLuma, qChroma = scaled(LUMA_Q, quality), scaled(CHROMA_Q, quality)
	local divLuma, divChroma = divisors(qLuma), divisors(qChroma)
	local w = newWriter()
	word(w, 0xffd8) -- SOI
	word(w, 0xffe0) -- APP0, JFIF 1.1, no density
	word(w, 16)
	for _, b in { 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0 } do
		byte(w, b)
	end
	word(w, 0xffdb) -- the two quantization tables, in zigzag order
	word(w, 132)
	for t, q in { qLuma, qChroma } do
		byte(w, t - 1)
		for k = 1, 64 do
			byte(w, q[ZIGZAG[k] + 1])
		end
	end
	word(w, 0xffc0) -- SOF0: 8-bit, three components, none subsampled
	word(w, 17)
	byte(w, 8)
	word(w, height)
	word(w, width)
	byte(w, 3)
	for id = 1, 3 do
		byte(w, id)
		byte(w, 0x11)
		byte(w, if id == 1 then 0 else 1)
	end
	word(w, 0xffc4) -- the four Huffman tables
	word(w, 2 + (17 + #DC_VALUES) * 2 + (17 + #AC_LUMA_VALUES) + (17 + #AC_CHROMA_VALUES))
	dht(w, 0x00, DC_LUMA_BITS, DC_VALUES)
	dht(w, 0x10, AC_LUMA_BITS, AC_LUMA_VALUES)
	dht(w, 0x01, DC_CHROMA_BITS, DC_VALUES)
	dht(w, 0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES)
	word(w, 0xffda) -- SOS
	word(w, 12)
	byte(w, 3)
	for id = 1, 3 do
		byte(w, id)
		byte(w, if id == 1 then 0x00 else 0x11)
	end
	byte(w, 0)
	byte(w, 63)
	byte(w, 0)

	local Y, Cb, Cr, q = table.create(64, 0), table.create(64, 0), table.create(64, 0), table.create(64, 0)
	local dcY, dcCb, dcCr = 0, 0, 0
	for by = 0, height - 1, 8 do
		for bx = 0, width - 1, 8 do
			for row = 0, 7 do
				local py = math.min(by + row, height - 1) -- past the edge: the edge pixel again
				for col = 0, 7 do
					local px = math.min(bx + col, width - 1)
					local p = (py * width + px) * 3
					local r, g, b = rgb[p + 1], rgb[p + 2], rgb[p + 3]
					local i = row * 8 + col + 1
					Y[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128
					Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b
					Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b
				end
			end
			dctQuant(Y, divLuma, q)
			dcY = block(w, q, dcY, DC_LUMA, AC_LUMA)
			dctQuant(Cb, divChroma, q)
			dcCb = block(w, q, dcCb, DC_CHROMA, AC_CHROMA)
			dctQuant(Cr, divChroma, q)
			dcCr = block(w, q, dcCr, DC_CHROMA, AC_CHROMA)
		end
		if yield then
			yield()
		end
	end
	flush(w)
	word(w, 0xffd9) -- EOI

	local parts = {}
	local bytes = w.bytes
	for i = 1, #bytes, 4096 do
		table.insert(parts, string.char(table.unpack(bytes, i, math.min(i + 4095, #bytes))))
	end
	return table.concat(parts)
end

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function Jpeg.base64(s: string): string
	local out = table.create(math.ceil(#s / 3))
	for i = 1, #s, 3 do
		local a, b, c = string.byte(s, i, i + 2)
		local n = a * 65536 + (b or 0) * 256 + (c or 0)
		local c1 = bit32.extract(n, 18, 6) + 1
		local c2 = bit32.extract(n, 12, 6) + 1
		local c3 = bit32.extract(n, 6, 6) + 1
		local c4 = bit32.extract(n, 0, 6) + 1
		table.insert(
			out,
			string.sub(B64, c1, c1)
				.. string.sub(B64, c2, c2)
				.. (if b then string.sub(B64, c3, c3) else "=")
				.. (if c then string.sub(B64, c4, c4) else "=")
		)
	end
	return table.concat(out)
end

-- The image as the data URL a `map` event carries.
function Jpeg.dataUrl(jpeg: string): string
	return "data:image/jpeg;base64," .. Jpeg.base64(jpeg)
end

return Jpeg
