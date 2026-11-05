// QR codes for jam rooms (rooms.js): the arcade's and each game's link as an SVG for pages, and as text for a terminal,
// so a maker scans their game straight off the screen. No dependencies: byte mode only, error correction level M
// (15% of the code can be lost), versions 1 to 20 (up to 666 bytes, far more than any room link).
//
// It follows the QR Code standard (ISO/IEC 18004) the way Project Nayuki's MIT-licensed "QR Code generator library"
// lays it out: the function patterns, the data in byte mode, Reed–Solomon error correction over GF(256), the
// zig-zag placement, and the mask with the lowest penalty. test/qr.test.js checks it against codes made elsewhere.
// It runs in Node and in the browser alike: the dashboard draws the arcade's codes with it, without asking the server.

const MAX_VERSION = 20;
// Error correction codewords per block and the number of blocks, for level M, by version (index 0 unused).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
const FORMAT_M = 0; // level M's two format bits

// → { size, dark(x, y) } for `text` (UTF-8 bytes); `mask` (0–7) forces a mask, else the best one is picked.
export function qrMatrix(text, { mask = null } = {}) {
  const data = [...new TextEncoder().encode(String(text))];
  let version = 1;
  for (; version <= MAX_VERSION; version++) if (data.length * 8 + 4 + (version < 10 ? 8 : 16) <= dataCodewords(version) * 8) break;
  if (version > MAX_VERSION) throw new Error(`too long for a QR code here: ${data.length} bytes`);

  // The data: mode 0100 (bytes), its length, the bytes, a terminator, then padding to fill the version.
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(data.length, version < 10 ? 8 : 16);
  for (const b of data) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  const q = new Grid(version);
  q.drawFunctionPatterns();
  q.drawCodewords(withEcc(codewords, version));
  let best = mask;
  if (best == null) {
    let lowest = Infinity;
    for (let m = 0; m < 8; m++) {
      q.applyMask(m);
      q.drawFormatBits(m);
      const score = q.penalty();
      if (score < lowest) [best, lowest] = [m, score];
      q.applyMask(m); // a mask undoes itself
    }
  }
  q.applyMask(best);
  q.drawFormatBits(best);
  return { size: q.size, version, mask: best, dark: (x, y) => x >= 0 && y >= 0 && x < q.size && y < q.size && q.modules[y][x] };
}

// An SVG of the code: dark modules as one path, a light quiet zone of `margin` modules around it. It scales to any size.
export function qrSvg(text, { margin = 4, dark = '#000', light = '#fff' } = {}) {
  const q = qrMatrix(text);
  const n = q.size + margin * 2;
  let d = '';
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.dark(x, y)) continue;
      let run = 1;
      while (q.dark(x + run, y)) run++;
      d += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

// The code as text, two rows to a line with half blocks. Light modules are drawn (█ ▀ ▄) and dark ones left blank,
// so it reads on the dark background most terminals have; `ansi` paints black on white instead, right on any
// background (for a terminal, never for text an agent passes on).
export function qrText(text, { margin = 2, ansi = false } = {}) {
  const q = qrMatrix(text);
  const lit = (x, y) => (ansi ? q.dark(x, y) : !q.dark(x, y));
  const lines = [];
  for (let y = -margin; y < q.size + margin; y += 2) {
    let line = '';
    for (let x = -margin; x < q.size + margin; x++) {
      const [top, bottom] = [lit(x, y), y + 1 < q.size + margin && lit(x, y + 1)];
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(ansi ? `\x1b[30;47m${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}

// Data codewords a version holds at level M: its raw modules (everything but the function patterns), less the ECC.
function dataCodewords(version) {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

function rawModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

// The data split into blocks, each with its Reed–Solomon codewords, then interleaved: the first codeword of every
// block, then the second, and so on (short blocks skip the one they lack).
function withEcc(data, version) {
  const blocks = BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const out = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    out.push([...dat, ...ecc]);
  }
  const result = [];
  for (let i = 0; i < out[0].length; i++) out.forEach((block, j) => (i !== shortLen - eccLen || j >= shortBlocks) && result.push(block[i]));
  return result;
}

function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= rsMultiply(coef, factor)));
  }
  return result;
}

const bit = (value, i) => ((value >>> i) & 1) !== 0;
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.modules[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [x, y] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size) this.set(x + dx, y + dy, dist !== 2 && dist !== 4);
        }
      }
    }
    const pos = this.alignmentPositions();
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormatBits(0); // reserves the format areas; the real bits go in once the mask is chosen
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const [a, b] = [size - 11 + (i % 3), Math.floor(i / 3)];
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }

  alignmentPositions() {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let p = this.size - 7; result.length < count; p -= step) result.splice(1, 0, p);
    return result;
  }

  drawFormatBits(mask) {
    const { size } = this;
    const data = (FORMAT_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(bits, i));
    this.set(8, size - 8, true); // the dark module
  }

  drawCodewords(data) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!this.fixed[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const flip = MASKS[mask];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fixed[y][x] && flip(x, y)) this.modules[y][x] = !this.modules[y][x];
  }

  // The standard's penalty: long runs, 2×2 blocks, finder-like patterns, and a dark share far from half.
  penalty() {
    const { size, modules: m } = this;
    let score = 0;
    const line = (get) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // 1:1:3:1:1 dark-light pattern with four light modules (or the edge) on one side.
      const at = (i) => i >= 0 && i < size && get(i);
      for (let i = -4; i < size; i++) {
        const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
        if (!core) continue;
        if (![-4, -3, -2, -1].some((d) => at(i + d)) || ![7, 8, 9, 10].some((d) => at(i + d))) score += 40;
      }
    };
    for (let y = 0; y < size; y++) line((x) => m[y][x]);
    for (let x = 0; x < size; x++) line((y) => m[y][x]);
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}
