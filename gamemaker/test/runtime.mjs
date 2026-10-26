// A pretend GameMaker for the SDK's GML (gml.mjs translates it): the built-in functions the SDK calls, a save area
// in a temp folder, http_request over fetch (with the reply's body as async_load's result), and a frame loop the tests drive. Each `launch()` is one run of a game:
// fresh GML state, the same save area, so an outbox written by one launch is read by the next.
//
//   const game = launch({ saveDir, args: ['-glitchless'] });
//   game.call('glitchless_init', 'demo', '1.0.0', 'dev', 'http://127.0.0.1:7999', {});
//   await game.frames(300, { dt: 16.7 });
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { translate } from './gml.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Everything but __glitchless_engine.gml, which only runs in GameMaker; the tests stand in for it below.
export const SDK_SCRIPTS = ['__glitchless_text', '__glitchless_sketch', '__glitchless_device', '__glitchless_core', '__glitchless_send', '__glitchless_bug_report', '__glitchless_play', 'Glitchless'];

const translated = new Map();
function script(name) {
  if (!translated.has(name)) {
    const file = path.join(ROOT, 'scripts', name, `${name}.gml`);
    translated.set(name, translate(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)));
  }
  return translated.get(name);
}

// ───────────────────────────── structs ─────────────────────────────

const LENIENT = '\u0000';
const structs = new WeakSet();

// A struct: reading a field it doesn't have with a dot throws, as GameMaker does; s[$ "name"] (a key passed through
// __q) reads undefined instead.
export function struct(obj = {}) {
  const p = new Proxy(obj, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k.startsWith(LENIENT)) return t[k.slice(1)];
      if (k === 'toJSON' || k === 'then' || k === 'constructor') return undefined;
      if (!(k in t)) throw new Error(`variable not set before reading it: .${k}`);
      return t[k];
    },
    set(t, k, v) {
      t[typeof k === 'string' && k.startsWith(LENIENT) ? k.slice(1) : k] = v;
      return true;
    },
    has(t, k) {
      return (typeof k === 'string' && k.startsWith(LENIENT) ? k.slice(1) : k) in t;
    },
  });
  structs.add(p);
  return p;
}

const isStruct = (v) => structs.has(v);

// json_parse: structs all the way down.
function deep(v) {
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = deep(x);
    return struct(o);
  }
  return v === null ? undefined : v;
}

// json_stringify writes undefined as null, where JSON.stringify would leave the field out.
function plain(v) {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : plain(x)));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = v[k] === undefined ? null : plain(v[k]);
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`json_stringify of ${v}`);
  return v;
}

// GameMaker's string() of a number: whole numbers as they are, others to exactly 2 decimals (string(0.1) is "0.10",
// as runtime 2026.0.0.23 writes it).
function gmlString(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan';
    return v.toFixed(2);
  }
  if (typeof v === 'string') return v;
  return JSON.stringify(plain(v));
}

const chars = (s) => Array.from(String(s));

// ───────────────────────────── a run of the game ─────────────────────────────

// `osType`: GameMaker's os_type (3 macOS, 0 Windows, 6 Linux). `files`: absolute paths outside the save area (/sys, /etc)
// and what they hold.
export function launch({ saveDir, args = [], env = {}, buildType = 'exe', rooms = ['rm_boot'], fetchImpl = fetch, log = () => {}, crcInverted = false, osType = 3, files = {} } = {}) {
  fs.mkdirSync(saveDir, { recursive: true });
  const savePath = (p) => (path.isAbsolute(p) ? p : path.join(saveDir, p));
  const state = {
    now: 1000, // current_time, ms since the game started
    timer: 1_000_000, // get_timer, µs
    delta: 16_667, // delta_time, µs
    room: 0,
    instances: 2,
    gcFrame: 0,
    gcStats: { traversal: 0, collection: 0, collected: 0 },
    focus: true,
    paused: false,
    pressed: new Set(),
    keyboardString: '',
    textureStatus: { Default: 3 },
    resources: { surfaceCount: 0, listCount: 0, mapCount: 0, gridCount: 0, bufferCount: 0, partSystemCount: 0, vertexBufferCount: 0 },
    ended: false,
    handler: undefined,
    timeSource: null,
    pending: [], // HTTP replies on their way: {id, promise, result}
    output: [],
    nextHttp: 1,
    buffers: new Map(),
    nextBuffer: 1,
    maps: new Set(),
    sprites: 0,
  };
  const debugMessages = [];
  // The GML globals (global.x). In GameMaker a script's functions are global variables too, so global.<name> of a
  // function is that function: a global named like one of the SDK's functions would be the function.
  const globals = {};
  let ctx = null;
  const g = new Proxy(globals, {
    get: (t, k) => (k in t ? t[k] : typeof ctx?.[k] === 'function' ? ctx[k] : undefined),
    has: (t, k) => k in t || typeof ctx?.[k] === 'function',
  });
  const buf = (id) => {
    const b = state.buffers.get(id);
    if (!b) throw new Error(`buffer ${id} does not exist`);
    return b;
  };
  const newBuffer = (bytes) => {
    const id = state.nextBuffer++;
    state.buffers.set(id, { bytes: Buffer.from(bytes), pos: 0 });
    return id;
  };
  const TYPES = { buffer_u8: 1, buffer_u32: 5, buffer_text: 11, buffer_string: 9 };
  const unixNow = () => Date.now();

  const builtins = {
    global: g,
    __q: (k) => LENIENT + k,
    __struct: struct,
    infinity: Infinity,
    pi: Math.PI,
    // types
    is_struct: isStruct,
    is_array: Array.isArray,
    is_string: (v) => typeof v === 'string',
    is_real: (v) => typeof v === 'number',
    is_int64: () => false,
    is_bool: (v) => typeof v === 'boolean',
    is_numeric: (v) => typeof v === 'number' || typeof v === 'boolean',
    is_undefined: (v) => v === undefined,
    string: gmlString,
    real: (s) => {
      const n = typeof s === 'number' ? s : Number(String(s).trim());
      if (Number.isNaN(n)) throw new Error(`unable to convert "${s}" to a number`);
      return n;
    },
    // maths
    floor: Math.floor,
    ceil: Math.ceil,
    abs: Math.abs,
    sqrt: Math.sqrt,
    ln: Math.log,
    power: Math.pow,
    min: (...a) => Math.min(...a),
    max: (...a) => Math.max(...a),
    clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
    // strings (1-based, by character as GameMaker counts them)
    string_length: (s) => chars(s).length,
    string_char_at: (s, i) => chars(s)[i - 1] ?? '',
    string_ord_at: (s, i) => chars(s)[i - 1]?.codePointAt(0) ?? -1,
    string_copy: (s, i, n) => chars(s).slice(Math.max(1, i) - 1, Math.max(1, i) - 1 + Math.max(0, n)).join(''),
    string_pos: (sub, s) => {
      const a = chars(s);
      const b = chars(sub);
      for (let i = 0; i + b.length <= a.length; i++) if (a.slice(i, i + b.length).join('') === b.join('')) return i + 1;
      return 0;
    },
    string_last_pos: (sub, s) => {
      const a = chars(s);
      const b = chars(sub);
      for (let i = a.length - b.length; i >= 0; i--) if (a.slice(i, i + b.length).join('') === b.join('')) return i + 1;
      return 0;
    },
    string_lower: (s) => String(s).toLowerCase(),
    string_upper: (s) => String(s).toUpperCase(),
    string_replace_all: (s, a, b) => (a === '' ? s : String(s).split(a).join(b)),
    string_digits: (s) => String(s).replace(/[^0-9]/g, ''),
    string_split: (s, d, removeEmpty = false) => String(s).split(d).filter((x) => !removeEmpty || x !== ''),
    string_byte_length: (s) => Buffer.byteLength(String(s), 'utf8'),
    ord: (c) => String(c).codePointAt(0),
    chr: (n) => String.fromCodePoint(n),
    sha1_string_utf8: (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex'),
    // arrays
    array_length: (a) => a.length,
    array_push: (a, ...v) => void a.push(...v),
    array_delete: (a, i, n) => void a.splice(i, n),
    array_insert: (a, i, ...v) => void a.splice(i, 0, ...v),
    array_create: (n, v = 0) => Array(n).fill(v),
    array_copy: (dest, di, src, si, n) => {
      for (let k = 0; k < n; k++) dest[di + k] = src[si + k];
    },
    array_sort: (a, how) => {
      if (typeof how === 'function') a.sort((x, y) => how(x, y));
      else a.sort((x, y) => (how ? 1 : -1) * (x < y ? -1 : x > y ? 1 : 0));
    },
    // structs
    variable_struct_get_names: (s) => Object.keys(s),
    variable_struct_exists: (s, k) => k in s,
    variable_struct_remove: (s, k) => void delete s[k],
    variable_struct_names_count: (s) => Object.keys(s).length,
    variable_global_exists: (k) => k in g,
    json_stringify: (v) => JSON.stringify(plain(v)).replace(/\//g, '\\/'), // runtime 2026.0.0.23 writes / as \/
    json_parse: (s) => deep(JSON.parse(s)),
    // time
    get current_time() {
      return state.now;
    },
    get delta_time() {
      return state.delta;
    },
    get_timer: () => state.timer,
    date_current_datetime: () => unixNow() / 86_400_000 + 25569,
    date_get_timezone: () => 0,
    date_set_timezone: () => {},
    timezone_utc: 1,
    // files, in the save area
    get game_save_id() {
      return saveDir + '/';
    },
    file_exists: (p) => p in files || fs.existsSync(savePath(p)),
    file_delete: (p) => fs.rmSync(savePath(p), { force: true }),
    file_rename: (a, b) => {
      fs.renameSync(savePath(a), savePath(b));
      return true;
    },
    directory_create: (p) => fs.mkdirSync(savePath(p), { recursive: true }),
    // buffers
    buffer_fixed: 0,
    buffer_grow: 1,
    buffer_seek_start: 0,
    ...TYPES,
    buffer_create: (size) => newBuffer(Buffer.alloc(size)),
    buffer_delete: (id) => void state.buffers.delete(id),
    buffer_get_size: (id) => buf(id).bytes.length,
    buffer_tell: (id) => buf(id).pos,
    buffer_seek: (id, _base, pos) => void (buf(id).pos = pos),
    buffer_write: (id, type, v) => {
      const b = buf(id);
      if (type === TYPES.buffer_u8) b.bytes.writeUInt8(v, b.pos), (b.pos += 1);
      else if (type === TYPES.buffer_u32) b.bytes.writeUInt32LE(v >>> 0, b.pos), (b.pos += 4);
      else {
        const bytes = Buffer.from(String(v) + (type === TYPES.buffer_string ? '\0' : ''), 'utf8');
        if (b.pos + bytes.length > b.bytes.length) throw new Error('buffer_write past the end of a fixed buffer');
        bytes.copy(b.bytes, b.pos);
        b.pos += bytes.length;
      }
    },
    buffer_read: (id, type) => {
      const b = buf(id);
      if (type !== TYPES.buffer_text) throw new Error('buffer_read: only buffer_text');
      const s = b.bytes.subarray(b.pos).toString('utf8');
      b.pos = b.bytes.length;
      return s;
    },
    buffer_peek: (id, off, type) => {
      if (type !== TYPES.buffer_u8) throw new Error('buffer_peek: only buffer_u8');
      return buf(id).bytes[off];
    },
    buffer_copy: (src, off, size, dest, destOff) => void buf(src).bytes.copy(buf(dest).bytes, destOff, off, off + size),
    buffer_save_ext: (id, p, off, size) => fs.writeFileSync(savePath(p), buf(id).bytes.subarray(off, off + size)),
    buffer_load: (p) => (p in files ? newBuffer(Buffer.from(files[p])) : fs.existsSync(savePath(p)) ? newBuffer(fs.readFileSync(savePath(p))) : -1),
    buffer_compress: (id, off, size) => newBuffer(zlib.deflateSync(buf(id).bytes.subarray(off, off + size))),
    buffer_crc32: (id, off, size) => {
      const c = zlib.crc32(buf(id).bytes.subarray(off, off + size));
      return crcInverted ? 0xffffffff - c : c;
    },
    buffer_base64_encode: (id, off, size) => buf(id).bytes.subarray(off, off + size).toString('base64'),
    // DS maps (request headers, os_get_info): a map's id is the map itself here, so m[? key] reads it
    ds_type_map: 1,
    ds_map_create: () => {
      const m = struct({});
      state.maps.add(m);
      return m;
    },
    ds_map_add: (m, k, v) => void (m[k] = v),
    ds_map_destroy: (m) => void state.maps.delete(m),
    ds_exists: (m, type) => type === 1 && state.maps.has(m),
    os_get_info: () => {
      const m = struct({ gl_renderer_string: 'Apple M2 Pro', gl_vendor_string: 'Apple', udid: 'not-sent' });
      state.maps.add(m);
      return m;
    },
    // HTTP
    http_request: (url, method, headers, body) => {
      const id = state.nextHttp++;
      const h = Object.fromEntries(Object.keys(headers).map((k) => [k, headers[k]]));
      const data = typeof body === 'string' ? body : Buffer.from(buf(body).bytes.subarray(0, buf(body).pos));
      const entry = { id, done: false, status: -1, http: 0, body: data, url, method, result: undefined };
      entry.promise = fetchImpl(url, { method, headers: h, body: method === 'GET' ? undefined : data })
        .then(async (r) => {
          entry.result = await r.text();
          entry.status = 0;
          entry.http = r.status;
        })
        .catch(() => {
          entry.status = -1;
          entry.http = 200; // GameMaker leaves a stale 200 in http_status when the transport fails
        })
        .finally(() => (entry.done = true));
      state.pending.push(entry);
      return id;
    },
    // the command line
    parameter_count: () => args.length,
    parameter_string: (i) => (i === 0 ? '/Applications/Demo.app/Contents/MacOS/Mac_Runner' : args[i - 1] ?? ''),
    environment_get_variable: (k) => env[k] ?? '',
    // the build and the device
    GM_build_type: buildType,
    GM_version: '1.0.0.0',
    GM_runtime_version: '2026.0.0.23',
    os_type: osType,
    os_windows: 0,
    os_macosx: 3,
    os_linux: 6,
    os_ios: 2,
    os_tvos: 20,
    os_android: 4,
    os_gxgames: 21,
    os_operagx: 22,
    os_switch: 12,
    os_ps4: 14,
    os_ps5: 15,
    os_xboxseriesxs: 17,
    os_version: 26 * 16777216 + 1 * 4096,
    os_browser: -1,
    browser_not_a_browser: -1,
    code_is_compiled: () => false,
    display_get_width: () => 3024,
    display_get_height: () => 1964,
    window_get_width: () => 1280,
    window_get_height: () => 720,
    display_get_frequency: () => 120,
    display_mouse_get_x: () => 10,
    display_mouse_get_y: () => 20,
    window_has_focus: () => state.focus,
    os_is_paused: () => state.paused,
    game_get_speed: () => 60,
    gamespeed_fps: 0,
    // rooms and instances
    get room() {
      return state.room;
    },
    room_get_name: (r) => rooms[r] ?? '<undefined>',
    get instance_count() {
      return state.instances;
    },
    obj_glitchless: 100,
    obj_glitchless_tail: 101,
    instance_exists: () => true,
    instance_activate_object: () => {},
    instance_create_depth: () => 1,
    time_source_global: 0,
    time_source_units_frames: 1,
    time_source_create: (_parent, _period, _units, fn) => {
      state.timeSource = fn;
      return 1;
    },
    time_source_start: () => {},
    exception_unhandled_handler: (fn) => {
      const was = state.handler;
      state.handler = fn;
      return was;
    },
    gc_get_stats: () =>
      struct({ objects_touched: 0, objects_collected: state.gcStats.collected, traversal_time: state.gcStats.traversal, collection_time: state.gcStats.collection, gc_frame: state.gcFrame, generation_collected: 0, num_generations: 4, num_objects_in_generation: [0, 0, 0, 0] }),
    texturegroup_get_names: () => Object.keys(state.textureStatus),
    texturegroup_get_status: (name) => state.textureStatus[name],
    texturegroup_status_unloaded: 0,
    texturegroup_status_loading: 1,
    texturegroup_status_loaded: 2,
    texturegroup_status_fetched: 3,
    debug_event: (what) => {
      if (what === 'DumpMemory') return struct({ totalUsed: 64 * 1048576, free: 0, peakUsage: 80 * 1048576 });
      if (what === 'ResourceCounts') return struct({ ...state.resources });
      return undefined;
    },
    debug_get_callstack: () => ['gml_Script_glitchless_error (line 77)', 'gml_Object_obj_demo_Step_0 (line 12)', 0],
    show_debug_message: (s) => {
      debugMessages.push(String(s));
      log(String(s));
    },
    game_end: () => void (state.ended = true),
    // input
    vk_anykey: 1,
    vk_f8: 119,
    vk_escape: 27,
    vk_enter: 13,
    mb_any: -1,
    mb_left: 1,
    gp_face1: 32769,
    get keyboard_string() {
      return state.keyboardString;
    },
    set keyboard_string(v) {
      state.keyboardString = v;
    },
    keyboard_lastkey: 32,
    keyboard_check_pressed: (k) => state.pressed.has(k) || (k === 1 && state.pressed.size > 0),
    mouse_check_button_pressed: () => false,
    gamepad_is_connected: () => false,
    gamepad_button_check_pressed: () => false,
    device_mouse_x_to_gui: () => 0,
    device_mouse_y_to_gui: () => 0,
    sprite_delete: () => {},
  };

  // __glitchless_engine.gml's functions, which need a real GameMaker.
  const engine = {
    __glitchless_pause_game: () => ['inst_1', 'inst_2'],
    __glitchless_resume_game: () => {},
    __glitchless_capture_screenshot: () => struct({ url: 'data:image/png;base64,' + PNG_1PX, sprite: ++state.sprites }),
    __glitchless_bug_button_at: () => '',
  };

  ctx = vm.createContext({});
  for (const [k, desc] of Object.entries(Object.getOwnPropertyDescriptors({ ...builtins, ...engine }))) Object.defineProperty(ctx, k, desc);
  // the accessors above lose their getters in a spread, so define those again from the original object
  for (const k of ['current_time', 'delta_time', 'game_save_id', 'room', 'instance_count', 'keyboard_string']) Object.defineProperty(ctx, k, Object.getOwnPropertyDescriptor(builtins, k));
  for (const name of SDK_SCRIPTS) vm.runInContext(script(name), ctx, { filename: `${name}.gml` });

  const game = {
    state,
    ctx,
    debugMessages,
    saveDir,
    call: (fn, ...a) => ctx[fn](...a),
    struct,
    get g() {
      return ctx.__glitchless();
    },
    // One frame that takes `dt` ms: the time source's tick at its start (which reads how long the frame before took,
    // as delta_time does), Begin Step (which sees the keys pressed since the last frame), `during` (the game's own step
    // code, which takes `step` ms; keys it presses arrive in the next frame), Pre-Draw, drawing
    // (`draw` ms), Post-Draw and Draw GUI End, then the HTTP replies that have arrived. What `during` changes (instances
    // made, a collection, a texture page) is seen at the next frame's tick, with this frame's dt.
    async frame({ dt = 16.667, step = 4, draw = 3, during = null } = {}) {
      if (state.ended) return false;
      const prev = state.prevDt ?? 16.667;
      state.delta = Math.round(prev * 1000);
      state.now += prev;
      state.frameStart = (state.frameStart ?? state.timer) + Math.round(prev * 1000);
      state.timer = state.frameStart;
      state.timeSource?.();
      ctx.__glitchless_begin_step?.();
      state.pressed.clear(); // keys pressed in `during` are the next frame's
      during?.(game);
      state.timer = state.frameStart + Math.round(step * 1000);
      ctx.__glitchless_pre_draw();
      state.timer = state.frameStart + Math.round((step + draw) * 1000);
      ctx.__glitchless_post_draw();
      ctx.__glitchless_draw_end();
      state.prevDt = dt;
      await new Promise((r) => setImmediate(r));
      await game.deliver();
      return !state.ended;
    },
    // A garbage collection during this frame, as gc_get_stats reports it from the next tick on.
    gc({ traversal = 0, collection = 0, collected = 0 } = {}) {
      state.gcFrame++;
      state.gcStats = { traversal, collection, collected };
    },
    async frames(n, opts = {}) {
      for (let i = 0; i < n; i++) if (!(await game.frame(typeof opts === 'function' ? opts(i) : opts))) return false;
      return true;
    },
    // The Async HTTP event, for each request whose reply has arrived.
    async deliver() {
      const done = state.pending.filter((p) => p.done);
      state.pending = state.pending.filter((p) => !p.done);
      for (const p of done) ctx.__glitchless_on_http(p.id, p.status, p.http, p.result);
    },
    // Waits for every request in flight, delivering replies, for at most `ms` of real time.
    async settle(ms = 3000) {
      const end = Date.now() + ms;
      while (state.pending.length && Date.now() < end) {
        await Promise.race([...state.pending.map((p) => p.promise), new Promise((r) => setTimeout(r, 20))]);
        await game.deliver();
      }
    },
    roomGoto(i) {
      state.room = i;
      ctx.__glitchless_check_room(ctx.__glitchless());
    },
    // An unhandled exception: GameMaker calls the handler and stops the game.
    crash(ex) {
      const result = state.handler?.(struct(ex));
      state.ended = true;
      return result;
    },
  };
  return game;
}

// A 1×1 PNG, as the stand-in screenshot.
export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
