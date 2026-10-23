// Source maps for web builds (SPEC §3d). A minified game's errors read "e (index-3f2a.js:1:48213)"; once the build's
// maps are uploaded (POST /v1/sourcemaps, the glitchless-sourcemaps package) they show the original function, file
// and line, and an error groups the same way in every build:
//   ingest   a browser error's top frame is mapped and its fingerprint recomputed on the original function
//            (refingerprint), so a bug in 1.2.0 and 1.2.1 is one issue although the minified names differ;
//   queries  the frames an issue, a finding, a board panel or a session timeline shows are mapped (prepare,
//            timeline), with the minified ones kept beside them.
//
// Every store keeps maps per project, service, version and file, where `file` is the minified script's path in the
// build (assets/index-3f2a.js) and a stack frame belongs to the longest file its URL path ends with:
//   putSourcemap(projectId, service, version, file, text)   stores one map (its JSON text, checked here first)
//   getSourcemap(projectId, service, version, file)         → the JSON text, or null
//   sourcemaps(projectId, service)                          → [{ version, file, size, uploaded_at }]
//   deleteSourcemaps(projectId, service, version)           a version's maps (the oldest go past MAX_VERSIONS)
//
// The reader needs no dependencies: Source Map v3 (base64 VLQ `mappings`, `sources`, `names`, `sourcesContent`, and
// index maps with `sections`).

import { gunzipSync } from 'node:zlib';
import { IntakeError } from './ingest.js';
import { errorList } from './analytics.js';

export const MAX_UPLOAD_BYTES = 10_000_000; // a request body (the CLI gzips: maps shrink 3–5×)
export const MAX_MAP_BYTES = 40_000_000; // one map, unpacked
export const MAX_FILES = 200; // maps per version
export const MAX_VERSIONS = 50; // versions per game: an upload past this deletes the oldest
export const RETENTION_DAYS = 400; // stores with a TTL keep a map this long after its upload
const INDEX_TTL_MS = 60_000; // how long a process trusts its list of a game's maps
const CACHE_BYTES = 96 * 2 ** 20; // parsed maps kept in memory, per process
const CONTEXT_FRAMES = 5; // frames that carry their line of source
const MAX_CODE = 200;
const MAX_KEY = 200; // a service, version or file, encoded (keySeg)
const INGEST_FRAMES = 4; // ingest needs the top frame and its caller, not the vendor chunk under them

// Stores' keys: a version or a file as one key or path segment (letters, digits, "%", "-" and "_" only, so no "/",
// "#" or "..", and every character sorts before "~").
export function keySeg(s) {
  return encodeURIComponent(String(s)).replace(/[.~!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function fromKeySeg(s) {
  return decodeURIComponent(s);
}

// ───────────────────────────── reading a map ─────────────────────────────

const B64 = new Int8Array(128).fill(-1);
[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((c, i) => (B64[c.charCodeAt(0)] = i));

// `mappings` → { segs, lines }: segs holds 5 numbers per segment (generated column, source, original line, original
// column, name; −1 where a segment has none; all 0-based), lines[l] is the first segment of generated line l and
// lines[l + 1] the end. Segments are sorted by column within a line.
export function decodeMappings(str) {
  let segs = new Int32Array(Math.max(64, str.length));
  const lines = [0];
  let n = 0;
  let col = 0;
  let src = 0;
  let line = 0;
  let ocol = 0;
  let name = 0;
  const f = [0, 0, 0, 0, 0];
  let fields = 0;
  let value = 0;
  let shift = 0;
  const commit = () => {
    if (fields !== 1 && fields !== 4 && fields !== 5) throw new IntakeError(400, `invalid mappings: a segment has ${fields} fields (1, 4 or 5)`);
    if (n + 5 > segs.length) {
      const bigger = new Int32Array(segs.length * 2);
      bigger.set(segs);
      segs = bigger;
    }
    col += f[0];
    segs[n] = col;
    if (fields >= 4) {
      src += f[1];
      line += f[2];
      ocol += f[3];
      segs[n + 1] = src;
      segs[n + 2] = line;
      segs[n + 3] = ocol;
    } else segs[n + 1] = segs[n + 2] = segs[n + 3] = -1;
    if (fields === 5) name += f[4];
    segs[n + 4] = fields === 5 ? name : -1;
    if (col < 0 || (fields >= 4 && (src < 0 || line < 0 || ocol < 0)) || (fields === 5 && name < 0)) throw new IntakeError(400, 'invalid mappings: a negative position');
    n += 5;
    fields = 0;
  };
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 44 || c === 59) {
      // ',' ends a segment, ';' a generated line
      if (shift) throw new IntakeError(400, 'invalid mappings: a value is cut short');
      if (fields) commit();
      if (c === 59) {
        lines.push(n / 5);
        col = 0;
      }
      continue;
    }
    const d = c < 128 ? B64[c] : -1;
    if (d < 0) throw new IntakeError(400, `invalid mappings: unexpected "${str[i]}" at ${i}`);
    value += (d & 31) * 2 ** shift;
    if (d & 32) {
      shift += 5;
      if (shift > 30) throw new IntakeError(400, 'invalid mappings: a value is too large');
      continue;
    }
    if (fields === 5) throw new IntakeError(400, 'invalid mappings: a segment has more than 5 fields');
    f[fields++] = value % 2 ? -(value - 1) / 2 : value / 2;
    value = 0;
    shift = 0;
  }
  if (shift) throw new IntakeError(400, 'invalid mappings: a value is cut short');
  if (fields) commit();
  lines.push(n / 5);
  const out = { segs: segs.slice(0, n), lines: Int32Array.from(lines) };
  for (let l = 0; l + 1 < out.lines.length; l++) sortLine(out, l);
  return out;
}

// Bundlers write segments in column order; sort the rare line that isn't.
function sortLine({ segs, lines }, l) {
  const a = lines[l];
  const b = lines[l + 1];
  for (let s = a + 1; s < b; s++) {
    if (segs[s * 5] >= segs[(s - 1) * 5]) continue;
    const list = [];
    for (let k = a; k < b; k++) list.push(segs.slice(k * 5, k * 5 + 5));
    list.sort((x, y) => x[0] - y[0]);
    list.forEach((seg, k) => segs.set(seg, (a + k) * 5));
    return;
  }
}

// A map's JSON (text or parsed) → what lookups need. Throws IntakeError(400) when it isn't a v3 source map.
export function parseMap(input) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new IntakeError(400, 'not JSON: send the .map file itself');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new IntakeError(400, 'not a source map: expected a JSON object');
  if (raw.version !== 3) throw new IntakeError(400, 'not a version 3 source map ("version": 3)');
  if (Array.isArray(raw.sections)) {
    // An index map: each section is a whole map placed at an offset of the generated file.
    const sections = raw.sections.map((s) => {
      if (!s?.map || !Number.isInteger(s.offset?.line) || !Number.isInteger(s.offset?.column)) throw new IntakeError(400, 'invalid section: each needs an offset {line, column} and a map (sections by url are not supported)');
      return { line: s.offset.line, column: s.offset.column, map: parseMap(s.map) };
    });
    return { sections, file: str(raw.file), weight: sections.reduce((w, s) => w + s.map.weight, 0) };
  }
  if (typeof raw.mappings !== 'string') throw new IntakeError(400, 'not a source map: "mappings" must be a string');
  if (!Array.isArray(raw.sources) || raw.sources.some((s) => s != null && typeof s !== 'string')) throw new IntakeError(400, 'not a source map: "sources" must be a list of paths');
  const names = Array.isArray(raw.names) ? raw.names.map((x) => (typeof x === 'string' ? x : null)) : [];
  const content = Array.isArray(raw.sourcesContent) ? raw.sourcesContent.map((x) => (typeof x === 'string' ? x : null)) : [];
  const root = typeof raw.sourceRoot === 'string' ? raw.sourceRoot : '';
  const { segs, lines } = decodeMappings(raw.mappings);
  return {
    file: str(raw.file),
    sources: raw.sources.map((s) => (s == null ? null : cleanSource(root && !/^([a-z][\w+.-]*:|\/)/i.test(s) ? root.replace(/\/?$/, '/') + s : s))),
    names,
    content,
    segs,
    lines,
    scopes: new Map(), // source index → { text, starts, fns }, worked out the first time a frame lands there
    weight: segs.byteLength + lines.byteLength + content.reduce((w, c) => w + (c?.length ?? 0), 0) + 64 * names.length,
  };
}

// Where generated (line, column) came from, both 1-based as stack traces give them: { map, source, index, line,
// column (1-based), name }, or null where the map has nothing.
export function originalPosition(map, line, column) {
  if (map.sections) {
    let hit = null;
    for (const s of map.sections) if (s.line < line - 1 || (s.line === line - 1 && s.column <= column - 1)) hit = s;
    if (!hit) return null;
    return originalPosition(hit.map, line - hit.line, line - 1 === hit.line ? column - hit.column : column);
  }
  const l = line - 1;
  if (l < 0 || l + 1 >= map.lines.length) return null;
  const col = column - 1;
  let lo = map.lines[l];
  let hi = map.lines[l + 1] - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map.segs[mid * 5] <= col) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0 || map.segs[found * 5 + 1] < 0) return null;
  const index = map.segs[found * 5 + 1];
  if (index >= map.sources.length || map.sources[index] == null) return null;
  const name = map.segs[found * 5 + 4];
  return { map, source: map.sources[index], index, line: map.segs[found * 5 + 2] + 1, column: map.segs[found * 5 + 3] + 1, name: name >= 0 ? (map.names[name] ?? null) : null };
}

// "../../src/weapons.js", "webpack://game/./src/weapons.js", "/@fs/home/me/game/node_modules/three/build/x.js" →
// "src/weapons.js", "src/weapons.js", "node_modules/three/build/x.js".
export function cleanSource(s) {
  let p = String(s).replace(/^webpack:\/\/[^/]*\//, '').replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  p = parts.join('/');
  const nm = p.lastIndexOf('node_modules/');
  return nm > 0 ? p.slice(nm) : p;
}

// ───────────────────────────── stacks ─────────────────────────────

// One stack line → { fn, url, line, col }, or null for lines that aren't frames (the message, native frames):
//   Chrome, Edge  "    at fn (https://host/assets/index-3f2a.js:1:48213)", "    at https://host/a.js:1:2"
//   Firefox       "fn@https://host/assets/index-3f2a.js:1:48213", "@https://host/a.js:1:2"
//   Safari        "fn@https://host/a.js:1:48213", "https://host/a.js:1:2"
export function parseFrame(raw) {
  const line = String(raw).trim();
  let m = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
  if (!m) m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
  if (!m) m = /^()((?:https?|file|blob|app|capacitor|tauri):\/\/.+?):(\d+):(\d+)$/.exec(line);
  if (!m || /^(eval at |<anonymous>|native)/.test(m[2])) return null;
  const fn = (m[1] || '').replace(/^(async|new) /, (k) => (k === 'new ' ? k : '')).replace(/^Object\./, '');
  return { fn: fn || '<anonymous>', url: m[2], line: Number(m[3]), col: Number(m[4]) };
}

export function parseStack(stack) {
  return String(stack || '')
    .split('\n')
    .map(parseFrame);
}

// The uploaded file a script URL is: the longest one its path ends with ("assets/index-3f2a.js" is
// https://cdn.example.com/game/assets/index-3f2a.js).
export function matchFile(url, files) {
  let p = String(url).split(/[?#]/)[0];
  try {
    p = decodeURI(new URL(p).pathname);
  } catch {
    // a bare path
  }
  let best = null;
  for (const f of files) if ((p === f || p.endsWith('/' + f)) && (!best || f.length > best.length)) best = f;
  return best;
}

// A file name as an upload names it: the path in the build, forward slashes, nothing that climbs out, and short
// enough to be a file name or a database key once encoded (keySeg).
export function cleanFile(file) {
  const f = String(file ?? '')
    .replace(/\\/g, '/')
    .replace(/^(\.?\/)+/, '');
  if (!f || keySeg(f).length > MAX_KEY || f.split('/').some((s) => s === '..' || s === '.')) return null;
  return f;
}

// Glitchless's own frames are skipped, as the SDK skips them when it picks the top frame.
function ours(file) {
  return /(^|\/)node_modules\/glitchless\//.test(file) || basename(file).startsWith('glitchless');
}

// Frames of a stack, mapped where `find(url)` gives the script's map: [{ fn, file, line, col, mapped, named, script,
// code?, minified? }] for the lines that are frames. `named`: fn is the original function's name; `script`: the
// minified file's path.
function mapFrames(lines, find) {
  const frames = [];
  for (const f of lines) {
    if (!f) continue;
    const map = find(f.url);
    const pos = map && originalPosition(map, f.line, f.col);
    frames.push({ f, pos });
  }
  return frames.map(({ f, pos }, i) => {
    const script = pathOf(f.url);
    if (!pos) return { fn: f.fn, file: script, line: f.line, col: f.col, mapped: false, named: false, script };
    let fn = functionAt(pos);
    // No source text to read the function from: the name the caller's call site has.
    if (fn == null) fn = frames[i + 1]?.pos?.name ?? null;
    const code = codeAt(pos);
    return { fn: fn ?? f.fn, file: pos.source, line: pos.line, col: pos.column, mapped: true, named: fn != null, script, ...(code != null ? { code } : {}), minified: `${f.fn} (${script}:${f.line}:${f.col})` };
  });
}

function pathOf(url) {
  try {
    return new URL(String(url)).pathname.replace(/^\//, '');
  } catch {
    return String(url);
  }
}

function basename(p) {
  return String(p || '').split('/').pop();
}

// The frame that names the error: the first that isn't Glitchless's own.
function topOf(frames) {
  return frames.find((x) => !ours(x.file) && !ours(x.script)) ?? null;
}

// A stack with each frame that has a map written out at its original place (other lines as they were), in the
// format Chrome uses: "    at fireShotgun (src/weapons.js:141:9)".
function stackText(lines, raw, frames) {
  let k = 0;
  return raw
    .map((text, i) => {
      if (!lines[i]) return text;
      const x = frames[k++];
      return x.mapped ? `    at ${x.fn} (${x.file}:${x.line}:${x.col})` : text;
    })
    .join('\n');
}

// What an issue or a timeline error shows once its stack is mapped, or null when its stack has no mapped frame.
function mapError(stack, find) {
  const raw = String(stack || '').split('\n');
  const lines = raw.map(parseFrame);
  const frames = mapFrames(lines, find);
  if (!frames.some((x) => x.mapped)) return null;
  let withCode = 0;
  for (const x of frames) if (x.code != null && withCode++ >= CONTEXT_FRAMES) delete x.code;
  return { stack: stackText(lines, raw, frames), frames: frames.map(({ named, script, ...x }) => x), top: topOf(frames) };
}

// ───────────────────────────── function names from source ─────────────────────────────

// The function a mapped position is in, named the way V8 names it in a stack (fireShotgun, Player.update,
// new Player, <anonymous> for a callback), or null when the map has no source text for it.
function functionAt(pos) {
  const scope = scopeOf(pos.map, pos.index);
  // No source text, or a position past its end (a map that doesn't fit its sourcesContent).
  if (!scope || pos.line > scope.starts.length) return null;
  const at = scope.starts[pos.line - 1] + pos.column - 1;
  let best = null;
  for (const fn of scope.fns) if (fn.start <= at && at <= fn.end && (!best || fn.start > best.start)) best = fn;
  return best ? best.name : '<anonymous>';
}

function codeAt(pos) {
  const scope = scopeOf(pos.map, pos.index);
  if (!scope || pos.line > scope.starts.length) return null;
  const text = scope.text.slice(scope.starts[pos.line - 1], scope.starts[pos.line] ?? scope.text.length).trim();
  return text.length > MAX_CODE ? text.slice(0, MAX_CODE) + '…' : text;
}

function scopeOf(map, index) {
  if (map.scopes.has(index)) return map.scopes.get(index);
  const text = map.content[index];
  let scope = null;
  if (typeof text === 'string') {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    scope = { text, starts, fns: functionsOf(text) };
  }
  map.scopes.set(index, scope);
  return scope;
}

const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);
// Character classes for the tokenizer: 1 starts a name, 2 continues one, 4 can start a longer punctuator.
const CHARS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (/[A-Za-z_$#\\]/.test(ch)) CHARS[c] |= 3;
  if (/[0-9]/.test(ch)) CHARS[c] |= 2;
  if ('>.=!*<&|?+-/%^'.includes(ch)) CHARS[c] |= 4;
}
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];

// The functions of one source as [{ start, end, name }] (character offsets of their bodies). A small tokenizer
// that skips strings, template literals, comments and regular expressions decides at each "{" whether it opens a
// function and what it is called: function NAME(…) {, NAME(…) { (a method), NAME = function / (…) => {, NAME: …,
// TypeScript return types and generics included. Expression-bodied arrows have no braces and fall to the function
// around them.
export function functionsOf(src) {
  const out = [];
  const t = []; // tokens: an identifier or punctuator as written, '0' a number, '""' a string or template, '/re/'
  const opens = []; // unmatched "(" and "[" (token indexes)
  const match = new Map(); // ")" or "]" → its "(" or "["
  const blocks = []; // open "{": { fn: name | null, cls: class name | undefined, start, tpl }
  const n = src.length;
  let i = 0;
  const template = (from) => {
    // In a template literal from `from`: to its end, or into a ${ … } (a block that resumes the template).
    for (let j = from; j < n; j++) {
      const c = src.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 96) {
        t.push('""');
        return j + 1;
      } else if (c === 36 && src.charCodeAt(j + 1) === 123) {
        blocks.push({ tpl: true });
        t.push('${');
        return j + 2;
      }
    }
    return n;
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c <= 32 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        const e = src.indexOf('\n', i);
        i = e < 0 ? n : e;
        continue;
      }
      if (d === 42) {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (regexAllowed(t.at(-1))) {
        let j = i + 1;
        for (let cls = false; j < n; j++) {
          const r = src.charCodeAt(j);
          if (r === 92) j++;
          else if (r === 10) break;
          else if (r === 91) cls = true;
          else if (r === 93) cls = false;
          else if (r === 47 && !cls) break;
        }
        i = j + 1;
        while (i < n && src.charCodeAt(i) < 128 && CHARS[src.charCodeAt(i)] & 2) i++;
        t.push('/re/');
        continue;
      }
    }
    if (c === 39 || c === 34) {
      let j = i + 1;
      for (; j < n; j++) {
        const r = src.charCodeAt(j);
        if (r === 92) j++;
        else if (r === c || r === 10) break;
      }
      i = j + 1;
      t.push('""');
      continue;
    }
    if (c === 96) {
      i = template(i + 1);
      continue;
    }
    if (c >= 128 || CHARS[c] & 1) {
      let j = i + 1;
      for (let d = src.charCodeAt(j); j < n && (d >= 128 || (CHARS[d] & 2 && d !== 35)); d = src.charCodeAt(++j));
      t.push(src.slice(i, j));
      i = j;
      continue;
    }
    const d = src.charCodeAt(i + 1);
    if ((c >= 48 && c <= 57) || (c === 46 && d >= 48 && d <= 57)) {
      let j = i + 1;
      for (let e = src.charCodeAt(j); j < n && e < 128 && (CHARS[e] & 2 || e === 46); e = src.charCodeAt(++j));
      t.push('0');
      i = j;
      continue;
    }
    const p = (CHARS[c] & 4 && d < 128 && CHARS[d] & 4 && PUNCTUATORS.find((x) => src.startsWith(x, i))) || src[i];
    i += p.length;
    if (p === '(' || p === '[') opens.push(t.length);
    else if (p === ')' || p === ']') {
      const o = opens.pop();
      if (o != null) match.set(t.length, o);
    } else if (p === '{') {
      const top = blocks.at(-1);
      let fn = functionName(t, match);
      if (fn && fn !== '<anonymous>' && top?.cls) fn = fn === 'constructor' ? `new ${top.cls}` : `${top.cls}.${fn}`;
      blocks.push({ fn, cls: fn == null ? classAt(t) : undefined, start: i - 1 });
    } else if (p === '}') {
      const b = blocks.pop();
      if (b?.tpl) {
        i = template(i);
        continue;
      }
      if (b?.fn != null) out.push({ start: b.start, end: i - 1, name: b.fn });
    }
    t.push(p);
  }
  for (const b of blocks) if (b.fn != null) out.push({ start: b.start, end: n, name: b.fn });
  return out;
}

function isName(x) {
  return x != null && /^[A-Za-z_$#\\\u0080-\uffff][\w$\\\u0080-\uffff]*$/.test(x);
}

function regexAllowed(prev) {
  if (prev == null) return true;
  if (prev === ')' || prev === ']' || prev === '}' || prev === '0' || prev === '""' || prev === '/re/') return false;
  return isName(prev) ? BEFORE_EXPRESSION.has(prev) : true;
}

// At a "{": the function it opens (its name, '<anonymous>') or null when it opens a block, object or class.
function functionName(t, match) {
  let k = t.length - 1;
  if (t[k] === '=>') return arrowName(t, k, match);
  if (t[k] !== ')') k = returnType(t, k);
  const open = k >= 0 ? match.get(k) : null;
  if (open == null) return null;
  let j = open - 1;
  if (t[j] === '>') j = skipGenerics(t, j);
  const before = t[j];
  if (before === 'function' || (before === '*' && t[j - 1] === 'function')) return assignedName(t, before === '*' ? j - 1 : j);
  if (before === ']') return '<anonymous>'; // [Symbol.iterator]() {
  if (!isName(before) || NOT_FUNCTIONS.has(before)) return null;
  return before;
}

// `(a, b) => {` or `x => {` (async, TypeScript return types too): named after what it is assigned to.
function arrowName(t, k, match) {
  let start = k - 1;
  if (t[start] !== ')' && !isName(t[start])) start = returnType(t, start);
  if (t[start] === ')') start = match.get(start) ?? start;
  if (t[start - 1] === 'async') start--;
  return assignedName(t, start);
}

// A function expression starting at token j: `NAME = …`, `NAME: …` (a property), `const NAME: Type = …`.
function assignedName(t, j) {
  if (t[j - 1] === 'async') j--;
  if (t[j - 1] === '=' || t[j - 1] === ':') {
    if (isName(t[j - 2]) && !BEFORE_EXPRESSION.has(t[j - 2])) return t[j - 2];
  }
  if (t[j - 1] === '=' && isName(t[j - 2]) && t[j - 3] === ':' && isName(t[j - 4])) return t[j - 4];
  return '<anonymous>';
}

// TypeScript: in `foo(a: number): Promise<void> {`, the ")" before the return type's ":", or −1.
function returnType(t, k) {
  for (let j = k, steps = 0; j > 0 && steps < 40; j--, steps++) {
    const x = t[j];
    if (x === ':') return t[j - 1] === ')' ? j - 1 : -1;
    if (x === '{' || x === '}' || x === ';' || x === '=' || x === '=>' || x === ')') return -1;
  }
  return -1;
}

// `foo<T, U>(` → the index of `foo`.
function skipGenerics(t, j) {
  for (let depth = 0; j >= 0; j--) {
    if (t[j] === '>') depth++;
    else if (t[j] === '<' && --depth === 0) return j - 1;
    else if (t[j] === '>>') depth += 2;
  }
  return j;
}

// At a "{" that is not a function: the class it opens (its name, or '' when anonymous), else undefined.
function classAt(t) {
  for (let j = t.length - 1, steps = 0; j >= 0 && steps < 30; j--, steps++) {
    const x = t[j];
    if (x === 'class') return isName(t[j + 1]) && t[j + 1] !== 'extends' && t[j + 1] !== '{' ? t[j + 1] : '';
    if (x === '{' || x === '}' || x === ';' || x === '=>' || x === '(' || x === ')') return undefined;
  }
  return undefined;
}

// ───────────────────────────── grouping ─────────────────────────────

// As the browser SDK groups errors (packages/sdk/src/fingerprint.js): kind + normalized message + function.
export function fingerprint(kind, message, fn = '') {
  return hash(`${kind}|${normalizeMessage(scrubUrls(message))}|${fn}`);
}

function normalizeMessage(msg = '') {
  return String(msg)
    .replace(/^Uncaught\s+/, '')
    .replace(/\d{3,}/g, 'N')
    .replace(/0x[0-9a-f]+/gi, 'X')
    .slice(0, 200);
}

function scrubUrls(text) {
  return String(text).replace(/(https?:\/\/[^\s?#)'"]+)[?#][^\s)'"]*?(?=(?::\d+){1,2}(?=[\s)'"]|$)|[\s)'"]|$)/gm, '$1');
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Engines quote the code that failed, and in a minified build that code names minified variables ("t.getPos is
// not a function"), which change from build to build. A mapped error groups on its message with the variables
// masked and the property names kept: "?.getPos is not a function".
const QUOTED = [
  /(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[\w$]+)*)(?= is not (?:a function|a constructor|iterable|an object)\b)/g, // V8, Firefox, Safari
  /(?<=Cannot access ')([^']+)(?=' before initialization)/g, // V8
  /(?<=can't access lexical declaration ')([^']+)(?=' before initialization)/g, // Firefox
  /(?<=Cannot destructure (?:property '[^']*' of )?')([^']+)(?=' as it is)/g, // V8
  /(?<=(?:, |^(?:\w*Error: )?))([A-Za-z_$][\w$.]*)(?= is (?:undefined|null)$)/g, // Firefox: [can't access property "x", ]e is undefined
  /(?<=\(evaluating ')([^']+)(?='\))/g, // Safari
  /(?<=\(In ')([^']+)(?=', ')/g, // Safari
  /(?<=', ')([^']+)(?=' is (?:undefined|null)\))/g, // Safari
];

export function stableMessage(message) {
  let out = String(message ?? '');
  for (const re of QUOTED) out = out.replace(re, (m, code) => maskCode(code));
  return out;
}

const NOT_MINIFIED = new Set(['this', 'undefined', 'null', 'true', 'false', 'NaN', 'Infinity', 'globalThis', 'window', 'document', 'super']);
function maskCode(code) {
  return code.replace(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g, (m, pre, id) => pre + (NOT_MINIFIED.has(id) ? id : '?'));
}

// ───────────────────────────── the server's side ─────────────────────────────

// Browser SDKs send JavaScript stacks; the engine SDKs' stacks are their own.
function isWeb(sdk) {
  return !/^glitchless-(godot|unity|unreal|gamemaker)\//.test(sdk || '');
}

// One per app (app.js): the upload route's checks, and per-process caches of each game's list of maps and of
// parsed maps, so ingest only reads a map the first time an error needs it.
export function createSourcemaps(store, { now = Date.now, logger = console, cacheBytes = CACHE_BYTES, indexTtlMs = INDEX_TTL_MS } = {}) {
  const indexes = new Map(); // `${project}\n${service}` → { at, versions: Map<version, Map<file, uploaded_at>> }
  const parsed = new Map(); // `${project}\n${service}\n${version}\n${file}\n${uploaded_at}` → map (in LRU order)
  const loading = new Map();
  let used = 0;

  // After an upload or a delete in this process. Other processes see it within INDEX_TTL_MS.
  function forget(projectId, service) {
    indexes.delete(`${projectId}\n${service}`);
  }

  async function indexOf(projectId, service) {
    const key = `${projectId}\n${service}`;
    const hit = indexes.get(key);
    if (hit && now() - hit.at < indexTtlMs) return hit.versions;
    const versions = new Map();
    try {
      for (const m of store.sourcemaps ? await store.sourcemaps(projectId, service) : []) {
        if (!versions.has(m.version)) versions.set(m.version, new Map());
        versions.get(m.version).set(m.file, m.uploaded_at ?? 0);
      }
    } catch (err) {
      logger.warn('[sourcemaps] list', err.message);
    }
    indexes.delete(key);
    indexes.set(key, { at: now(), versions });
    if (indexes.size > 5000) indexes.delete(indexes.keys().next().value);
    return versions;
  }

  async function load(projectId, service, version, file, stamp) {
    const key = [projectId, service, version, file, stamp].join('\n');
    if (parsed.has(key)) {
      const map = parsed.get(key);
      parsed.delete(key);
      parsed.set(key, map);
      return map;
    }
    if (!loading.has(key)) {
      const p = (async () => {
        const text = await store.getSourcemap(projectId, service, version, file);
        if (!text) return null;
        const map = parseMap(text);
        parsed.set(key, map);
        used += map.weight;
        for (const [k, m] of parsed) {
          if (used <= cacheBytes || parsed.size <= 1) break;
          parsed.delete(k);
          used -= m.weight;
        }
        return map;
      })()
        .catch((err) => {
          logger.warn('[sourcemaps] load', file, err.message);
          return null;
        })
        .finally(() => loading.delete(key));
      loading.set(key, p);
    }
    return loading.get(key);
  }

  // Loads the maps the stacks' frames need (version → stacks; the first `frames` frames of each) and →
  // find(version, url): its map, or null.
  async function finder(projectId, service, versions, stacks, frames = Infinity) {
    const loaded = new Map();
    const need = [];
    for (const [version, list] of stacks) {
      const files = versions.get(version);
      if (!files) continue;
      for (const stack of list) {
        for (const f of parseStack(stack).filter(Boolean).slice(0, frames)) {
          const file = matchFile(f.url, files.keys());
          const key = file && `${version}\n${file}`;
          if (key && !loaded.has(key)) {
            loaded.set(key, null);
            need.push([key, version, file, files.get(file)]);
          }
        }
      }
    }
    await Promise.all(need.map(async ([key, version, file, stamp]) => loaded.set(key, await load(projectId, service, version, file, stamp))));
    return (version, url) => {
      const files = versions.get(version);
      const file = files && matchFile(url, files.keys());
      return (file && loaded.get(`${version}\n${file}`)) || null;
    };
  }

  return {
    // POST /v1/sourcemaps: checks one map and stores it. `body` is the request body (the .map file, or gzip of it).
    async upload(projectId, { service, version, file }, body) {
      if (!store.putSourcemap) throw new IntakeError(501, `the ${store.kind} store keeps no source maps`);
      let text = body;
      if (Buffer.isBuffer(body)) {
        if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
          try {
            text = gunzipSync(body, { maxOutputLength: MAX_MAP_BYTES });
          } catch (err) {
            throw err?.code === 'ERR_BUFFER_TOO_LARGE' ? new IntakeError(413, `a source map may be at most ${MAX_MAP_BYTES / 1e6} MB unpacked`) : new IntakeError(400, 'invalid gzip body');
          }
        }
        text = text.toString('utf8');
      }
      if (text.length > MAX_MAP_BYTES) throw new IntakeError(413, `a source map may be at most ${MAX_MAP_BYTES / 1e6} MB unpacked`);
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new IntakeError(400, 'not JSON: send the .map file itself');
      }
      const map = parseMap(raw);
      const name = cleanFile(file || raw?.file);
      if (!name) throw new IntakeError(400, 'file is required: the minified script\'s path in the build, e.g. assets/index-3f2a.js (up to about 200 characters)');
      if (keySeg(service).length > MAX_KEY || keySeg(version).length > MAX_KEY) throw new IntakeError(400, 'service and version must be shorter');
      const list = await store.sourcemaps(projectId, service);
      const mine = list.filter((m) => m.version === version);
      if (!mine.some((m) => m.file === name) && mine.length >= MAX_FILES) throw new IntakeError(413, `a version keeps at most ${MAX_FILES} source maps`);
      await store.putSourcemap(projectId, service, version, name, text);
      // Past MAX_VERSIONS, the versions uploaded longest ago go.
      const latest = new Map();
      for (const m of list) latest.set(m.version, Math.max(latest.get(m.version) ?? 0, m.uploaded_at ?? 0));
      latest.set(version, Infinity);
      const pruned = [...latest].sort((a, b) => b[1] - a[1]).slice(MAX_VERSIONS).map(([v]) => v);
      for (const v of pruned) await store.deleteSourcemaps(projectId, service, v);
      forget(projectId, service);
      const sections = map.sections ? map.sections.map((s) => s.map) : [map];
      const sources = sections.reduce((n, m) => n + m.sources.length, 0);
      const withContent = sections.reduce((n, m) => n + m.content.filter((c) => typeof c === 'string').length, 0);
      return { service, version, file: name, bytes: text.length, sources, sources_with_content: withContent, ...(pruned.length ? { pruned } : {}) };
    },

    async list(projectId, service) {
      return (store.sourcemaps ? await store.sourcemaps(projectId, service) : []).sort((a, b) => b.uploaded_at - a.uploaded_at || (a.file < b.file ? -1 : 1));
    },

    async remove(projectId, service, version) {
      const had = !!store.sourcemaps && (await store.sourcemaps(projectId, service)).some((m) => m.version === version);
      if (had) await store.deleteSourcemaps(projectId, service, version);
      forget(projectId, service);
      return had;
    },

    // Ingest: browser errors whose top frame has a map get the original function, file and line, and a fingerprint
    // on the original function; what the SDK sent is kept as `minified`. Never fails a batch.
    async refingerprint(projectId, events) {
      try {
        const byService = new Map();
        for (const e of events) {
          if (e.type !== 'error' || typeof e.stack !== 'string' || !e.stack || !isWeb(e.sdk)) continue;
          if (!byService.has(e.service)) byService.set(e.service, []);
          byService.get(e.service).push(e);
        }
        for (const [service, list] of byService) {
          const versions = await indexOf(projectId, service);
          const mine = list.filter((e) => versions.has(e.version));
          if (!mine.length) continue;
          const stacks = new Map();
          for (const e of mine) (stacks.get(e.version) || stacks.set(e.version, []).get(e.version)).push(e.stack);
          const find = await finder(projectId, service, versions, stacks, INGEST_FRAMES);
          for (const e of mine) {
            const frames = mapFrames(parseStack(e.stack), (url) => find(e.version, url));
            const top = topOf(frames);
            if (!top?.mapped) continue;
            e.minified = { fingerprint: e.fingerprint ?? null, fn: e.fn ?? null, source: e.source ?? null, line: e.line ?? null, col: e.col ?? null };
            e.fingerprint = fingerprint(e.kind, stableMessage(e.message), top.named ? top.fn : `${basename(top.file)}:${top.line}`);
            Object.assign(e, { fn: top.fn, source: basename(top.file), line: top.line, col: top.col });
          }
        }
      } catch (err) {
        logger.warn('[sourcemaps] ingest', err.message);
      }
    },

    // Queries that show issues (errors, findings, boards): when the game has maps, ctx.symbolicate(issue) gives an
    // issue its original location and stack (analytics.js errorIssues calls it), with `frames` and `minified`.
    async prepare(ctx, projectId, service) {
      try {
        const versions = await indexOf(projectId, service);
        if (!versions.size) return;
        const stacks = new Map();
        for (const i of errorList(ctx)) if (i.stack && versions.has(i.first_version)) (stacks.get(i.first_version) || stacks.set(i.first_version, []).get(i.first_version)).push(i.stack);
        if (!stacks.size) return;
        const find = await finder(projectId, service, versions, stacks);
        // A query can list the issues more than once (findings, the overview's top errors, a board's panels).
        const mapped = new Map();
        const mapOnce = (version, stack) => {
          const key = `${version}\n${stack}`;
          if (!mapped.has(key)) mapped.set(key, mapError(stack, (url) => find(version, url)));
          return mapped.get(key);
        };
        ctx.symbolicate = (issue) => {
          const m = issue.stack && versions.has(issue.first_version) ? mapOnce(issue.first_version, issue.stack) : null;
          if (!m) return issue;
          const top = m.top?.mapped ? m.top : null;
          return {
            ...issue,
            ...(top ? { fn: top.fn, source: basename(top.file), line: top.line, location: `${top.fn} (${basename(top.file)}:${top.line})` } : {}),
            stack: m.stack,
            frames: m.frames,
            minified: { location: top ? top.minified : issue.location, stack: issue.stack },
          };
        };
      } catch (err) {
        logger.warn('[sourcemaps] query', err.message);
      }
    },

    // A session's timeline: its errors with mapped stacks (version: the session's).
    async timeline(projectId, service, version, timeline) {
      try {
        const versions = await indexOf(projectId, service);
        const errors = timeline.filter((e) => e.type === 'error' && e.stack);
        if (!versions.has(version) || !errors.length) return timeline;
        const find = await finder(projectId, service, versions, new Map([[version, errors.map((e) => e.stack)]]));
        return timeline.map((e) => {
          const m = e.type === 'error' && e.stack ? mapError(e.stack, (url) => find(version, url)) : null;
          if (!m) return e;
          const top = m.top?.mapped ? m.top : null;
          return { ...e, ...(top ? { fn: top.fn, source: basename(top.file), line: top.line, col: top.col } : {}), stack: m.stack, frames: m.frames, minified: { ...(e.minified || {}), stack: e.stack } };
        });
      } catch (err) {
        logger.warn('[sourcemaps] timeline', err.message);
        return timeline;
      }
    },
  };
}

function str(v) {
  return typeof v === 'string' ? v : null;
}
