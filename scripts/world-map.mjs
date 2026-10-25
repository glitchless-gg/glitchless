// Makes the two country tables Glitchless bundles, so nothing is fetched at runtime: the dashboard's world map
// (apps/dashboard/src/world-map.js: each country's outline as an SVG path, in the Equal Earth projection, simplified to
// about half a pixel at 1000 wide, and a dot for each country too small for the 110m outlines) and the core's country
// names (server/src/countries.js: ISO 3166-1 alpha-2 codes, an English name for each, and the other names and codes a
// source may give, to find the code). Run again only to change the drawing or the names:
//   node scripts/world-map.mjs <world-atlas@2.0.2 package dir> <i18n-iso-countries@7.14.0 package dir>
// Outlines: Natural Earth (public domain) through world-atlas (ISC, © Michael Bostock). Codes and names:
// i18n-iso-countries (MIT, © 2016 widdix GmbH).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [atlasDir, codesDir] = process.argv.slice(2);
if (!atlasDir || !codesDir) throw new Error('usage: node scripts/world-map.mjs <world-atlas dir> <i18n-iso-countries dir>');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const codes = readJson(path.join(codesDir, 'codes.json'));
const en = readJson(path.join(codesDir, 'langs/en.json')).countries;
const WIDTH = 1000;
const TOLERANCE = 0.5;

// Short names where the list's first is the formal one.
const SHORT = { US: 'United States', RU: 'Russia', CN: 'China', CZ: 'Czechia', IR: 'Iran', KR: 'South Korea', KP: 'North Korea', MK: 'North Macedonia', PS: 'Palestine', TW: 'Taiwan', TZ: 'Tanzania', TR: 'Türkiye', GB: 'United Kingdom', CD: 'DR Congo', CG: 'Congo', GM: 'Gambia', CI: "Côte d'Ivoire", NL: 'Netherlands', VN: 'Vietnam', LA: 'Laos', SY: 'Syria', MD: 'Moldova', BN: 'Brunei', BO: 'Bolivia', VE: 'Venezuela', FM: 'Micronesia', VA: 'Vatican City', AX: 'Åland Islands', PN: 'Pitcairn Islands' };
// Names stores and RevenueCat might use that the list doesn't have.
const MORE = { XK: ['Kosovo'], CV: ['Cape Verde'], SZ: ['Swaziland'], MM: ['Burma'], KR: ['Korea'], HK: ['Hong Kong SAR', 'Hong Kong SAR China'], MO: ['Macau', 'Macao SAR China'], CZ: ['Czech'], CD: ['Congo (Kinshasa)', 'Congo - Kinshasa', 'DRC'], CG: ['Congo (Brazzaville)', 'Congo - Brazzaville'], RU: ['Russian Federation'], VN: ['Viet Nam'], LA: ["Lao People's Democratic Republic", 'Lao PDR'], SY: ['Syrian Arab Republic'], MD: ['Republic of Moldova'], BN: ['Brunei Darussalam'], BO: ['Bolivia, Plurinational State of'], VE: ['Venezuela, Bolivarian Republic of'], TW: ['Taiwan, Republic of China'], IR: ['Iran, Islamic Republic of'], TZ: ['Tanzania, United Republic of'], KP: ["Korea, Democratic People's Republic of"], PS: ['Palestine, State of', 'Palestinian Territories'], VA: ['Holy See'], FK: ['Falkland Islands (Malvinas)'], MK: ['Macedonia'], TR: ['Turkey'] };

const names = {};
const aliases = {};
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
for (const [a2, a3, num] of codes) {
  const list = [en[a2]].flat().filter(Boolean);
  if (!list.length) continue;
  names[a2] = SHORT[a2] ?? list[0];
  for (const n of [...list, ...(MORE[a2] ?? []), names[a2], a3]) aliases[norm(n)] ??= a2;
  aliases[num] = a2;
}
names.XK = 'Kosovo';
for (const n of MORE.XK) aliases[norm(n)] = 'XK';
aliases.xkx = 'XK';
const byNumeric = Object.fromEntries(codes.map(([a2, , num]) => [num, a2]));
const unnamed = { Kosovo: 'XK' };

// ── TopoJSON → projected rings ──
function decode(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => [(x += dx) * sx + tx, (y += dy) * sy + ty]);
  });
  const ring = (ids) => ids.flatMap((i, k) => {
    const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
    return k ? a.slice(1) : a;
  });
  // A polygon stitched across the antimeridian (Chukotka, Fiji) is cut back into its pieces either side of it.
  const cut = (rings) => antimeridian(rings[0]).map((outer, k) => (k ? [outer] : [outer, ...rings.slice(1)]));
  return topo.objects.countries.geometries.map((g) => ({
    code: g.id ? byNumeric[g.id] ?? null : unnamed[g.properties?.name] ?? null,
    name: g.properties?.name,
    polygons: (g.type === 'Polygon' ? [g.arcs.map(ring)] : g.type === 'MultiPolygon' ? g.arcs.map((p) => p.map(ring)) : []).flatMap(cut),
  }));
}

// A ring that jumps across ±180° → its pieces on the map: longitudes made continuous, then the ring clipped to
// [-180, 180] as it is and moved a turn east or west (Sutherland–Hodgman against each edge).
function antimeridian(ring) {
  if (!ring.some(([lon], i) => i && Math.abs(lon - ring[i - 1][0]) > 180)) return [ring];
  const unwrapped = [];
  let prev = null;
  for (const [lon, lat] of ring) {
    let l = lon;
    if (prev != null) while (l - prev > 180) l -= 360;
    if (prev != null) while (prev - l > 180) l += 360;
    unwrapped.push([l, lat]);
    prev = l;
  }
  const clip = (pts, inside, at) => {
    const out = [];
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      if (inside(p)) out.push(p);
      if (inside(p) !== inside(q)) out.push(at(p, q));
    });
    return out;
  };
  const edge = (x) => (p, q) => [x, p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0])];
  return [-360, 0, 360]
    .map((d) => clip(clip(unwrapped.map(([l, lat]) => [l + d, lat]), (p) => p[0] <= 180, edge(180)), (p) => p[0] >= -180, edge(-180)))
    .filter((r) => r.length >= 3)
    .map((r) => [...r, r[0]]);
}

// Equal Earth (Šavrič, Patterson and Jenny, 2018).
const [A1, A2, A3, A4] = [1.340264, -0.081106, 0.000893, 0.003796];
const M = Math.sqrt(3) / 2;
function equalEarth([lon, lat]) {
  const l = (lon * Math.PI) / 180;
  const t = Math.asin(M * Math.sin((lat * Math.PI) / 180));
  const t2 = t * t;
  const t6 = t2 * t2 * t2;
  return [(l * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))), t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))];
}

function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  // A ring ends where it starts: split it at its point farthest from the start.
  const [x0, y0] = points[0];
  const mid = points.reduce((b, [x, y], i) => (Math.hypot(x - x0, y - y0) > Math.hypot(points[b][0] - x0, points[b][1] - y0) ? i : b), 0);
  keep[mid] = 1;
  const stack = [[0, mid], [mid, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let at = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len;
      if (d > far) [far, at] = [d, i];
    }
    if (far > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const area = (r) => Math.abs(r.reduce((s, [x, y], i) => { const [x2, y2] = r[(i + 1) % r.length]; return s + x * y2 - x2 * y; }, 0)) / 2;

function draw(features, scale, [ox, oy]) {
  const px = ([lon, lat]) => { const [x, y] = equalEarth([lon, lat]); return [(x - ox) * scale, (oy - y) * scale]; };
  return features.map((f) => {
    const rings = [];
    let biggest = null;
    for (const poly of f.polygons) {
      poly.forEach((r, k) => {
        const p = r.map(px);
        if (!k && (!biggest || area(p) > area(biggest))) biggest = p;
        const s = simplify(p, TOLERANCE);
        const xs = s.map((q) => q[0]);
        const ys = s.map((q) => q[1]);
        if (s.length >= 4 && Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) >= 2) rings.push(s);
      });
    }
    return { ...f, rings, biggest };
  });
}

function pathOf(rings) {
  const f = (v) => String(Math.round(v * 10) / 10);
  return rings
    .map((r) => {
      let [x0, y0] = r[0];
      let out = `M${f(x0)} ${f(y0)}`;
      let prev = [Math.round(x0 * 10), Math.round(y0 * 10)];
      for (const [x, y] of r.slice(1, -1)) {
        const q = [Math.round(x * 10), Math.round(y * 10)];
        const dx = (q[0] - prev[0]) / 10;
        const dy = (q[1] - prev[1]) / 10;
        if (!dx && !dy) continue;
        out += `l${dx}${dy < 0 ? '' : ' '}${dy}`;
        prev = q;
      }
      return `${out}z`;
    })
    .join('');
}

const small = decode(readJson(path.join(atlasDir, 'countries-110m.json'))).filter((f) => f.code !== 'AQ');
const detailed = decode(readJson(path.join(atlasDir, 'countries-50m.json'))).filter((f) => f.code && f.code !== 'AQ');
// The frame: the 110m outlines' extent, Antarctica left out.
const all = small.flatMap((f) => f.polygons.flat(2)).map(equalEarth);
const [minX, maxX] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
const [minY, maxY] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
const scale = WIDTH / (maxX - minX);
const height = Math.ceil((maxY - minY) * scale);
const shapes = draw(small, scale, [minX, maxY]);
const shapeCodes = new Set(shapes.filter((s) => s.code && s.rings.length).map((s) => s.code));
// A dot at the middle of the biggest piece of each country the 110m outlines leave out (or simplify away).
const dots = {};
for (const f of [...draw(detailed, scale, [minX, maxY]), ...shapes.filter((s) => s.code && !s.rings.length)]) {
  if (shapeCodes.has(f.code) || !f.biggest || dots[f.code]) continue;
  const n = f.biggest.length;
  dots[f.code] = [Math.round((f.biggest.reduce((s, p) => s + p[0], 0) / n) * 10) / 10, Math.round((f.biggest.reduce((s, p) => s + p[1], 0) / n) * 10) / 10];
}
const outlines = {};
const land = [];
for (const s of shapes) {
  if (!s.rings.length) continue;
  if (s.code) outlines[s.code] = (outlines[s.code] ? `${outlines[s.code]}` : '') + pathOf(s.rings);
  else land.push(pathOf(s.rings));
}

const header = (what) => `// Generated by scripts/world-map.mjs: do not edit by hand. ${what}\n`;
fs.writeFileSync(
  path.join(ROOT, 'apps/dashboard/src/world-map.js'),
  header(
    'The world map the country panels draw (Board.jsx), bundled so nothing is\n// fetched at runtime: each country (ISO 3166-1 alpha-2) as an SVG path in the Equal Earth projection, `width` × `height`\n// with Antarctica left out; `dots` for countries too small for these outlines; `land` for places without a code.\n// Outlines: Natural Earth (public domain) through world-atlas 2.0.2 (ISC, © Michael Bostock).',
  ) +
    `export const width = ${WIDTH};\nexport const height = ${height};\nexport const outlines = ${JSON.stringify(outlines)};\nexport const dots = ${JSON.stringify(dots)};\nexport const land = ${JSON.stringify(land)};\n`,
);
fs.writeFileSync(
  path.join(ROOT, 'server/src/countries.js'),
  header(
    "Countries by ISO 3166-1 alpha-2 code, with an English name for each\n// (`names`), and the other names, alpha-3 and numeric codes a source may give, lower-cased without accents (`aliases`).\n// Codes and names: i18n-iso-countries 7.14.0 (MIT, © 2016 widdix GmbH). Kosovo is XK.",
  ) +
    `export const names = ${JSON.stringify(names)};\nexport const aliases = ${JSON.stringify(aliases)};\n\n// A country as a source names it (a code, or a name in English) → its alpha-2 code, or null.\nexport function countryCode(v) {\n  const s = String(v ?? '').trim();\n  if (/^[A-Za-z]{2}$/.test(s) && names[s.toUpperCase()]) return s.toUpperCase();\n  const key = s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();\n  return aliases[key] ?? null;\n}\n`,
);
console.log(`world-map.js: ${Object.keys(outlines).length} outlines, ${Object.keys(dots).length} dots, ${land.length} without a code, ${WIDTH}×${height}; countries.js: ${Object.keys(names).length} names, ${Object.keys(aliases).length} aliases`);
