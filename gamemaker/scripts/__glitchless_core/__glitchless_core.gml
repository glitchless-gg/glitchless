// Feather disable all
/// Glitchless: frame times, hitches, errors and play events for a Glitchless server, in the shape the
/// browser SDK (packages/sdk/src/core.js) and the Godot, Unity and Unreal SDKs send them, so the
/// dashboard, findings and MCP tools take a GameMaker game as they are.
///
/// The game calls the glitchless_* functions in the Glitchless script. Everything here is internal.
/// State lives in one struct, global.__glitchless_state (read it with __glitchless()). A global time
/// source runs __glitchless_tick at the start of every frame, so the clock keeps going when the game
/// deactivates instances for its own pause menu; two persistent objects (obj_glitchless at the back,
/// obj_glitchless_tail at the front) mark when drawing starts and ends and receive the HTTP replies.
///
/// Struct fields are read with [$ "name"] wherever they may be missing: reading a missing one with
/// a dot stops a GameMaker game.

#macro GLITCHLESS_VERSION "0.1.0"
#macro GLITCHLESS_SDK "glitchless-gamemaker/0.1.0"

#macro __GLITCHLESS_HITCH_MS 50 // one frame over 50 ms is a stutter a player sees
#macro __GLITCHLESS_JANK_MS 33.4 // two missed 60 Hz frames
#macro __GLITCHLESS_FROZEN_MS 700 // Android vitals' "frozen frame"
#macro __GLITCHLESS_MAX_ERRORS_PER_FINGERPRINT 25
#macro __GLITCHLESS_MAX_QUEUE 2000
#macro __GLITCHLESS_MAX_HITCH_EVENTS_PER_WINDOW 3 // frame_window.hitches still counts every one
#macro __GLITCHLESS_RAGE_INPUT_COUNT 4 // the same key four times in a second
#macro __GLITCHLESS_RAGE_INPUT_WINDOW_MS 1000
#macro __GLITCHLESS_RING_SIZE 240
#macro __GLITCHLESS_BUG_RECENT 20 // game events and hitches a bug report carries
#macro __GLITCHLESS_BUG_FRAMES 6 // frame windows a bug report carries
#macro __GLITCHLESS_SPAWN_BURST 50 // instances added in one frame that make it an object_spawn hitch

/// Everything glitchless_init() takes in its options. PRIVACY.md says what each one changes.
function __glitchless_defaults() {
    return {
        client_token: "gl_pub_dev",
        privacy: "anonymous", // "install" keeps a random player ID on the device; "full" adds device detail and positions
        positions: undefined, // death and movement positions; undefined: on in full mode only
        sample_rate: 1,
        flush_interval: 5, // seconds between batches
        position_hz: 4,
        session_type: "", // "user" or "synthetic"; "": synthetic with -autoplay or -glitchless-measure
        session_timeout: 300, // seconds in the background after which coming back is a new session
        engine_gauges: true, // the instance count in ctx, where the findings look for leaks
        rooms_as_levels: true, // a room that reads as a level starts that level; the game's first glitchless_level_start turns it off
        rage_input: undefined, // undefined: on except on phones, where fast tapping is normal play
        enabled: undefined, // undefined: off when run from the IDE unless -glitchless
        gzip: true, // gzip batches (the server takes plain JSON too)
        debug: false,
        // true, or {hotkey: vk_f8, pause: true, screenshot: true, on_open, on_close}: players send bug reports from a form in the game
        bug_reports: false,
        exception_handler: undefined, // the game's own unhandled-exception handler, called after Glitchless writes the crash down
    };
}

/// The SDK's state. (Not global.__glitchless: a script's functions are global variables too, so that name is this
/// function.)
function __glitchless() {
    if (!variable_global_exists("__glitchless_state")) global.__glitchless_state = __glitchless_new_state();
    return global.__glitchless_state;
}

function __glitchless_new_state() {
    var _g = {
        opts: __glitchless_defaults(),
        inited: false,
        enabled: false,
        sampled: true,
        service: "unknown-game",
        version: "0.0.0",
        env: "dev",
        intake: "",
        privacy: "anonymous",
        full: false,
        keeps_ids: false, // install and full mode
        positions: false,
        session_type: "user",
        rage_input: false,
        engine_gauges: true,
        debug: false,
        gzip: false,
        session_id: "",
        player_id: "",
        level: undefined,
        manual_levels: false,
        level_room: -1,
        started_at: 0,
        epoch_ms: 0,
        level_started: 0,
        ctx: {},
        recent: [],
        queue: [],
        outbox: [],
        next_bid: 1,
        in_flight: -1,
        http_id: -1,
        http_buffer: -1,
        headers: -1, // one request header map for every request, kept for the game's life
        in_flight_since: 0,
        report_requests: {},
        retry_at: 0,
        backoff: 0,
        session_start_sent: false,
        load_sent: false,
        ended: false,
        shut: false,
        crashed: false,
        quitting: false,
        quit_deadline: 0,
        error_counts: {},
        error_log: {},
        probes: [],
        pending_hitches: [],
        win: undefined,
        ring: array_create(__GLITCHLESS_RING_SIZE, 0),
        ring_idx: 0,
        ring_count: 0,
        budget_ms: 1000 / 60,
        hz: 60,
        recent_median: 0,
        frame_id: 0,
        untimed: 0,
        skip_frame: true,
        pending_long: undefined,
        throttled: false,
        first_frame_ms: 0,
        first_input_ms: 0,
        key_history: {},
        position: undefined,
        pos_buffer: [],
        next_flush: 0,
        next_pos: 0,
        screen: [],
        window: [],
        engine: {},
        history: [],
        recent_hitches: [],
        recent_windows: [],
        bug_opts: undefined,
        bug_hotkey: -1,
        bug: undefined, // the bug report form while it is open
        bug_capture: undefined, // a report or the form, waiting for this frame's Post-Draw to take the screenshot
        has_focus: true,
        flags: __glitchless_read_flags(),
        measure_flag: undefined,
        time_source: -1,
        stats: { sent: 0, failed: 0, errors: 0, hitches: 0, deaths: 0, last_status: "idle" },
        // What the frame that just ended cost, read at the start of the next one.
        tick_us: 0,
        step_end_us: 0,
        draw_start_us: 0,
        draw_end_us: 0,
        last_room: -1, // the room rooms-as-levels last saw (Room Start and the clock)
        frame_room: -1, // the room the clock last saw, for the frame a room change lands in
        instances: 0,
        gc_frame: -1,
        texture_groups: [],
        texture_status: {},
        f: undefined
    };
    _g.win = __glitchless_new_window(_g);
    return _g;
}

// ───────────────────────────── the game's calls ─────────────────────────────

function __glitchless_init(_service, _version, _env, _intake, _options) {
    var _g = __glitchless();
    if (_g.inited) return;
    _g.inited = true;
    var _names = variable_struct_get_names(_options);
    for (var _i = 0; _i < array_length(_names); _i++) _g.opts[$ _names[_i]] = _options[$ _names[_i]];
    var _o = _g.opts;
    _g.debug = __glitchless_has_flag(_g, "glitchless-debug") || _o.debug == true;
    _g.service = _service != "" ? string_lower(_service) : "unknown-game";
    _g.version = _version != "" ? _version : GM_version;
    if (_g.version == "") _g.version = "0.0.0";
    _g.env = _env != "" ? _env : "prod";
    var _flag_intake = __glitchless_flag_value(_g, "glitchless-intake", "");
    _g.intake = _flag_intake != "" ? _flag_intake : _intake;
    while (string_length(_g.intake) > 0 && string_char_at(_g.intake, string_length(_g.intake)) == "/") _g.intake = string_copy(_g.intake, 1, string_length(_g.intake) - 1);
    var _privacy = __glitchless_flag_value(_g, "glitchless-privacy", _o.privacy);
    _g.privacy = _privacy == "full" || _privacy == "install" ? _privacy : "anonymous";
    _g.full = _g.privacy == "full";
    _g.keeps_ids = _g.privacy != "anonymous";
    _g.positions = is_undefined(_o.positions) ? _g.full : (_o.positions == true);
    _g.rage_input = is_undefined(_o.rage_input) ? !__glitchless_is_phone() : (_o.rage_input == true);
    _g.engine_gauges = _o.engine_gauges == true;
    if (_o.session_type != "") {
        _g.session_type = _o.session_type;
    } else if (__glitchless_has_flag(_g, "autoplay") || __glitchless_has_flag(_g, "glitchless-synthetic") || __glitchless_has_flag(_g, "glitchless-measure")) {
        _g.session_type = "synthetic";
    }
    if (!is_undefined(_o.enabled)) {
        _g.enabled = _o.enabled == true;
    } else {
        _g.enabled = GM_build_type != "run" || __glitchless_has_flag(_g, "glitchless") || _flag_intake != "";
    }
    _g.enabled = _g.enabled && _g.intake != "";
    _g.sampled = __glitchless_unit_random() < _o.sample_rate;
    var _bug = _o.bug_reports;
    if (is_struct(_bug) || _bug == true) {
        _g.bug_opts = { hotkey: vk_f8, pause: true, screenshot: true, on_open: undefined, on_close: undefined };
        if (is_struct(_bug)) {
            var _keys = variable_struct_get_names(_bug);
            for (var _k = 0; _k < array_length(_keys); _k++) _g.bug_opts[$ _keys[_k]] = _bug[$ _keys[_k]];
        }
        _g.bug_hotkey = is_undefined(_g.bug_opts.hotkey) ? -1 : _g.bug_opts.hotkey;
    }
    _g.gzip = _o.gzip == true && __glitchless_gzip_works();
    _g.epoch_ms = __glitchless_unix_ms() - current_time;
    _g.started_at = __glitchless_now(_g);
    _g.win = __glitchless_new_window(_g);
    _g.session_id = __glitchless_new_id("s_", 16); // anonymous mode keeps it in memory only
    _g.next_flush = current_time + min(2, _o.flush_interval) * 1000; // the first batch goes soon, so a session that crashes early is still seen
    exception_unhandled_handler(__glitchless_on_exception);
    __glitchless_sample_engine(_g, true); // where memory and the counts start
    __glitchless_start_clock(_g);
    __glitchless_check_room(_g); // init may come after the first room started
    var _measure = __glitchless_flag_value(_g, "glitchless-measure", "");
    if (_measure != "") {
        var _secs = real(_measure);
        _g.measure_flag = {
            seconds: _secs > 0 ? _secs : 5,
            start_at: current_time + real(__glitchless_flag_value(_g, "glitchless-warmup", "0")) * 1000,
            out: __glitchless_flag_value(_g, "glitchless-out", ""),
            started: false
        };
    }
    if (!_g.enabled) {
        _g.queue = [];
        __glitchless_log(_g, "off (run from the IDE without -glitchless, or no intake)");
        return;
    }
    directory_create("glitchless");
    if (_g.keeps_ids) {
        _g.player_id = __glitchless_load_player_id();
    } else if (file_exists("glitchless/player_id")) {
        file_delete("glitchless/player_id"); // left by an install- or full-mode build: anonymous mode keeps no ID
    }
    __glitchless_load_outbox(_g);
    __glitchless_log(_g, "on: " + _g.service + " " + _g.version + " " + _g.env + " -> " + _g.intake + " (" + _g.privacy + ", " + _g.session_type + (_g.gzip ? ", gzip" : "") + ")");
}

function __glitchless_level_start(_level, _manual) {
    var _g = __glitchless();
    if (_manual) _g.manual_levels = true;
    __glitchless_close_window(_g, false); // so a frame window never spans two levels
    _g.level = string(_level);
    _g.level_started = current_time;
    __glitchless_push(_g, { type: "level_start" });
    __glitchless_remember(_g, "level_start");
}

function __glitchless_level_complete(_level, _score, _duration_s) {
    var _g = __glitchless();
    var _lvl = is_undefined(_level) ? _g.level : string(_level);
    var _secs = _duration_s >= 0 ? _duration_s : (current_time - _g.level_started) / 1000;
    var _e = { type: "level_complete", level: _lvl, duration_s: __glitchless_round(_secs, 0.01) };
    _e[$ "score"] = _score; // `score` is also one of GameMaker's built-in variables: the accessor keeps it a field
    __glitchless_push(_g, _e);
    __glitchless_remember(_g, "level_complete");
}

function __glitchless_level_fail(_level, _cause) {
    var _g = __glitchless();
    var _lvl = is_undefined(_level) ? _g.level : string(_level);
    __glitchless_push(_g, { type: "level_fail", level: _lvl, cause: _cause != "" ? _cause : undefined });
    __glitchless_remember(_g, "level_fail");
}

/// A death at a place in the room. The place is sent only when positions are on (full mode, or the
/// positions option); the death and cause always are.
function __glitchless_death(_x, _y, _cause, _z) {
    var _g = __glitchless();
    _g.stats.deaths += 1;
    var _e = { type: "death", cause: _cause };
    if (_g.positions) {
        // x and y are also every instance's built-in variables: the accessor keeps them the struct's fields
        _e[$ "x"] = __glitchless_round(_x, 0.01);
        _e[$ "y"] = __glitchless_round(_y, 0.01);
        _e[$ "z"] = __glitchless_round(_z, 0.01);
    }
    __glitchless_push(_g, _e);
    __glitchless_remember(_g, "death:" + _cause);
}

function __glitchless_track(_name, _what) {
    var _g = __glitchless();
    var _attrs = {};
    if (is_struct(_what)) {
        _attrs = _what;
    } else if (!is_undefined(_what)) {
        _attrs = { what: _what };
    }
    __glitchless_push(_g, { type: "custom", name: string(_name), attrs: _attrs });
    __glitchless_remember(_g, string(_name));
}

function __glitchless_set_context(_gauges) {
    var _g = __glitchless();
    var _names = variable_struct_get_names(_gauges);
    for (var _i = 0; _i < array_length(_names); _i++) {
        var _v = _gauges[$ _names[_i]];
        if (is_real(_v) || is_int64(_v)) __glitchless_gauge(_g, _names[_i], _v);
    }
}

function __glitchless_set_position(_x, _y, _z) {
    var _g = __glitchless();
    if (_g.positions) _g.position = [_x, _y, _z];
}

/// An error the game caught itself: a message, or the exception a catch block got.
function __glitchless_error(_error, _attrs) {
    var _g = __glitchless();
    var _message = "";
    var _frames = [];
    if (is_struct(_error)) {
        _message = is_undefined(_error[$ "message"]) ? string(_error) : string(_error.message);
        var _trace = _error[$ "stacktrace"];
        if (is_array(_trace)) _frames = __glitchless_frames(_trace);
    } else {
        _message = string(_error);
        _frames = __glitchless_frames(debug_get_callstack());
    }
    __glitchless_report_error(_g, { kind: "manual", message: _message, frames: _frames, attrs: _attrs });
}

/// Sends what is waiting, gives the network up to 1.5 s to take it, then ends the game. GameMaker
/// has no way to wait on a request while the game closes, so a game that quits with game_end()
/// sends its last batch on the next launch instead.
function __glitchless_quit() {
    var _g = __glitchless();
    if (_g.quitting) return;
    __glitchless_shutdown(_g, "quit");
    _g.quitting = true;
    _g.quit_deadline = current_time + 1500;
    if (!_g.inited || !_g.enabled || array_length(_g.outbox) == 0) game_end();
}

// ───────────────────────────── the clock ─────────────────────────────

/// A global time source calls __glitchless_tick at the start of every frame. It keeps running when
/// the game deactivates instances (a pause menu), and it brings Glitchless's own objects back.
function __glitchless_start_clock(_g) {
    if (_g.time_source != -1) return;
    _g.time_source = time_source_create(time_source_global, 1, time_source_units_frames, __glitchless_tick, [], -1);
    time_source_start(_g.time_source);
    __glitchless_keep_objects();
}

function __glitchless_keep_objects() {
    if (!instance_exists(obj_glitchless)) {
        instance_activate_object(obj_glitchless);
        if (!instance_exists(obj_glitchless)) instance_create_depth(0, 0, 16000, obj_glitchless);
    }
    if (!instance_exists(obj_glitchless_tail)) {
        instance_activate_object(obj_glitchless_tail);
        if (!instance_exists(obj_glitchless_tail)) instance_create_depth(0, 0, -16000, obj_glitchless_tail);
    }
}

function __glitchless_tick() {
    var _g = __glitchless();
    var _now_us = get_timer();
    __glitchless_keep_objects();
    _g.frame_id += 1;
    __glitchless_read_last_frame(_g, _now_us);
    __glitchless_check_focus(_g);
    __glitchless_check_room(_g);
    var _dt = delta_time / 1000;
    if (_g.frame_id > 1 && !_g.skip_frame && _g.untimed == 0) __glitchless_frame(_g, _dt);
    _g.skip_frame = false;
    _g.untimed = max(0, _g.untimed - 1);
    _g.tick_us = _now_us;
    var _ms = current_time;
    if (_g.positions && !is_undefined(_g.position) && _ms >= _g.next_pos) {
        _g.next_pos = _ms + 1000 / max(_g.opts.position_hz, 0.1);
        array_push(_g.pos_buffer, [__glitchless_now(_g), __glitchless_round(_g.position[0], 0.01), __glitchless_round(_g.position[1], 0.01), __glitchless_round(_g.position[2], 0.01)]);
    }
    if (_g.frame_id % 30 == 0) {
        __glitchless_sample_engine(_g, false);
        __glitchless_check_screen(_g);
    }
    __glitchless_check_probes(_g);
    if (_ms >= _g.next_flush && !_g.shut) __glitchless_flush(_g);
    if (_g.inited && _g.enabled && _g.in_flight != -1 && _ms - _g.in_flight_since > 20000) {
        __glitchless_retry_later(_g, "no reply in 20 s"); // its reply went to an instance that was gone
        _g.in_flight = -1;
        _g.http_id = -1;
    }
    if (_g.inited && _g.enabled && _g.in_flight == -1 && array_length(_g.outbox) > 0 && _ms >= _g.retry_at) __glitchless_send_next(_g);
    if (_g.quitting && (_ms >= _g.quit_deadline || __glitchless_outbox_sent(_g))) {
        _g.quitting = false;
        game_end();
    }
}

function __glitchless_outbox_sent(_g) {
    return array_length(_g.outbox) == 0;
}

/// obj_glitchless's Begin Step: the keys and clicks of this frame (time sources may run before input is read).
function __glitchless_begin_step() {
    __glitchless_check_input(__glitchless());
}

/// obj_glitchless's Pre-Draw: every Step event of the frame has run.
function __glitchless_pre_draw() {
    var _g = __glitchless();
    var _now = get_timer();
    _g.step_end_us = _now;
    _g.draw_start_us = _now;
}

/// obj_glitchless_tail's Draw GUI End: the last thing the game draws.
function __glitchless_draw_end() {
    var _g = __glitchless();
    _g.draw_end_us = get_timer();
}

/// What the frame that just ended cost: its step code (from this tick to Pre-Draw), its drawing (Pre-Draw
/// to Draw GUI End), a garbage collection, texture pages loaded, instances added, a room change.
function __glitchless_read_last_frame(_g, _now_us) {
    var _step = undefined;
    var _draw = undefined;
    if (_g.tick_us > 0 && _g.step_end_us > _g.tick_us) _step = (_g.step_end_us - _g.tick_us) / 1000;
    if (_g.draw_start_us > _g.tick_us && _g.draw_end_us > _g.draw_start_us) _draw = (_g.draw_end_us - _g.draw_start_us) / 1000;
    var _gc = gc_get_stats();
    var _gc_ms = 0;
    var _collected = 0;
    if (_gc.gc_frame != _g.gc_frame) {
        if (_g.gc_frame != -1) {
            _gc_ms = (_gc.traversal_time + _gc.collection_time) / 1000;
            _collected = _gc.objects_collected;
        }
        _g.gc_frame = _gc.gc_frame;
    }
    var _count = instance_count;
    var _added = _g.frame_id > 1 ? max(0, _count - _g.instances) : 0;
    _g.instances = _count;
    _g.f = {
        step: _step,
        draw: _draw,
        gc_ms: _gc_ms,
        gc_collected: _collected,
        instances_added: _added,
        texture_loads: __glitchless_texture_loads(_g),
        room_changed: _g.frame_id > 1 && room != _g.frame_room
    };
    _g.frame_room = room;
}

/// Texture pages fetched since the last frame. A texture group that is not prefetched is loaded the
/// first time something on it is drawn, which stalls that frame.
function __glitchless_texture_loads(_g) {
    if (_g.frame_id == 1) {
        _g.texture_groups = texturegroup_get_names();
        for (var _i = 0; _i < array_length(_g.texture_groups); _i++) {
            _g.texture_status[$ _g.texture_groups[_i]] = texturegroup_get_status(_g.texture_groups[_i]);
        }
        return 0;
    }
    var _loads = 0;
    for (var _j = 0; _j < array_length(_g.texture_groups); _j++) {
        var _name = _g.texture_groups[_j];
        var _status = texturegroup_get_status(_name);
        var _was = _g.texture_status[$ _name];
        if (_status != _was) {
            if (_status == texturegroup_status_fetched || _status == texturegroup_status_loaded) _loads++;
            _g.texture_status[$ _name] = _status;
        }
    }
    return _loads;
}

/// A run of long frames is the OS throttling a hidden window, not the game: a single long frame
/// between normal ones is a real freeze; a run is dropped.
function __glitchless_frame(_g, _dt) {
    if (_dt >= 5000) {
        _g.pending_long = undefined;
    } else if (_dt > __GLITCHLESS_FROZEN_MS) {
        if (!is_undefined(_g.pending_long) || _g.throttled) {
            _g.pending_long = undefined;
            _g.throttled = true;
        } else {
            _g.pending_long = __glitchless_snapshot(_g, _dt);
        }
    } else {
        if (!is_undefined(_g.pending_long)) __glitchless_on_frame(_g, _g.pending_long);
        _g.pending_long = undefined;
        _g.throttled = false;
        __glitchless_on_frame(_g, __glitchless_snapshot(_g, _dt));
    }
}

function __glitchless_snapshot(_g, _dt) {
    var _f = _g.f;
    return {
        dt: _dt,
        step: is_undefined(_f) ? undefined : _f.step,
        draw: is_undefined(_f) ? undefined : _f.draw,
        gc_ms: is_undefined(_f) ? 0 : _f.gc_ms,
        gc_collected: is_undefined(_f) ? 0 : _f.gc_collected,
        instances_added: is_undefined(_f) ? 0 : _f.instances_added,
        texture_loads: is_undefined(_f) ? 0 : _f.texture_loads,
        room_changed: is_undefined(_f) ? false : _f.room_changed
    };
}

/// The frame budget is the game's own speed (game_set_speed), which GameMaker holds the frame rate to.
function __glitchless_update_budget(_g) {
    var _fps = game_get_speed(gamespeed_fps);
    if (_fps > 0) {
        _g.hz = _fps;
        _g.budget_ms = 1000 / _fps;
    }
}

function __glitchless_on_frame(_g, _f) {
    var _dt = _f.dt;
    var _w = _g.win;
    _w.frames += 1;
    __glitchless_sketch_add(_w.sketch, _dt);
    _w.mx = max(_w.mx, _dt);
    if (_dt > _g.budget_ms * 1.5) _w.slow += 1;
    if (_dt > __GLITCHLESS_JANK_MS) _w.jank += 1;
    if (_dt > __GLITCHLESS_FROZEN_MS) _w.frozen += 1;
    if (!is_undefined(_f.step)) {
        _w.step += _f.step;
        _w.step_n += 1;
    }
    if (!is_undefined(_f.draw)) {
        _w.draw += _f.draw;
        _w.draw_n += 1;
    }
    _w.gc_ms += _f.gc_ms;
    if (_f.gc_ms > 0) _w.gc_collections += 1;
    _w.texture_loads += _f.texture_loads;
    _g.ring[_g.ring_idx] = _dt;
    _g.ring_idx = (_g.ring_idx + 1) % __GLITCHLESS_RING_SIZE;
    _g.ring_count = min(_g.ring_count + 1, __GLITCHLESS_RING_SIZE);
    if (_g.first_frame_ms == 0) _g.first_frame_ms = current_time;
    if (_g.frame_id % 16 == 0 && _g.ring_count >= 30) _g.recent_median = __glitchless_median(__glitchless_last_frames(_g, 60));

    // A hitch is a stutter: over 50 ms and well above what this device usually does. A device that
    // is slow all the time shows in the percentiles instead.
    var _hitch = _dt > __GLITCHLESS_HITCH_MS && _dt > 2 * _g.recent_median;
    if (_hitch) __glitchless_sample_engine(_g, false); // the counts this frame ended with go in the hitch's ctx
    var _causes = _hitch ? __glitchless_causes(_g, _f) : [];
    for (var _i = 0; _i < array_length(_g.probes); _i++) {
        var _p = _g.probes[_i];
        _p.frames += 1;
        __glitchless_sketch_add(_p.sketch, _dt);
        _p.mx = max(_p.mx, _dt);
        if (!is_undefined(_f.step)) __glitchless_sketch_add(_p.step, _f.step);
        if (!is_undefined(_f.draw)) __glitchless_sketch_add(_p.draw, _f.draw);
        _p.gc_ms += _f.gc_ms;
        if (_hitch) array_push(_p.hitches, { ms: __glitchless_round(_dt, 0.1), level: _g.level, causes: _causes, ctx: __glitchless_copy(_g.ctx), recent: __glitchless_recent_within(_g, 1500) });
    }
    if (_hitch) {
        _w.hitches += 1;
        _g.stats.hitches += 1;
        array_push(_g.pending_hitches, {
            type: "hitch",
            ts: __glitchless_now(_g),
            level: _g.level,
            duration_ms: __glitchless_round(_dt, 0.1),
            frozen: _dt > __GLITCHLESS_FROZEN_MS,
            draw_calls: undefined,
            triangles: undefined,
            programs: undefined,
            ctx: __glitchless_copy(_g.ctx),
            recent: __glitchless_recent_within(_g, 1500),
            causes: _causes,
            loaf: [],
            process_ms: is_undefined(_f.step) ? undefined : __glitchless_round(_f.step, 0.1),
            render_ms: is_undefined(_f.draw) ? undefined : __glitchless_round(_f.draw, 0.1),
            gc_ms: __glitchless_round(_f.gc_ms, 0.1),
            gc_collected: _f.gc_collected,
            instances_added: _f.instances_added,
            texture_loads: _f.texture_loads
        });
    }
}

/// Likely causes of one long frame, from what that frame measured (SPEC §5d).
function __glitchless_causes(_g, _f) {
    var _out = [];
    var _share = max(16, _f.dt * 0.4);
    if (_f.texture_loads > 0) array_push(_out, "texture_upload");
    if (_f.room_changed) array_push(_out, "scene_change");
    if (_f.gc_ms >= max(4, _f.dt * 0.25)) array_push(_out, "gc");
    if (_f.instances_added >= __GLITCHLESS_SPAWN_BURST) array_push(_out, "object_spawn");
    if (!is_undefined(_f.step) && _f.step >= _share) array_push(_out, "script");
    if (!is_undefined(_f.draw) && _f.draw >= _share) array_push(_out, "render");
    if (_f.dt > __GLITCHLESS_FROZEN_MS) array_push(_out, "frozen");
    return _out;
}

function __glitchless_new_window(_g) {
    return {
        started_at: _g.epoch_ms > 0 ? __glitchless_now(_g) : 0,
        started_ms: current_time,
        frames: 0,
        sketch: __glitchless_sketch_new(),
        mx: 0,
        slow: 0,
        jank: 0,
        hitches: 0,
        frozen: 0,
        step: 0,
        step_n: 0,
        draw: 0,
        draw_n: 0,
        gc_ms: 0,
        gc_collections: 0,
        texture_loads: 0,
        ctx: {}
    };
}

/// `_fresh`: sample the engine counts now. Not when a level starts: whatever the game just did to load
/// the new level belongs to the new level.
function __glitchless_close_window(_g, _fresh) {
    if (_fresh && _g.win.frames > 0) __glitchless_sample_engine(_g, true);
    var _w = _g.win;
    _g.win = __glitchless_new_window(_g);
    __glitchless_update_budget(_g);
    if (_w.frames > 0) {
        var _secs = max((current_time - _w.started_ms) / 1000, 0.001);
        var _n = _w.frames;
        var _s = _w.sketch;
        var _e = _g.engine;
        __glitchless_queue_event(_g, {
            type: "frame_window",
            ts: _w.started_at,
            level: _g.level,
            duration_s: __glitchless_round(_secs, 0.01),
            frames: _n,
            fps: __glitchless_round(_n / _secs, 0.1),
            hz: _g.hz,
            budget_ms: __glitchless_round(_g.budget_ms, 0.01),
            ft: __glitchless_sketch_json(_s),
            ft_p50: __glitchless_round(__glitchless_sketch_quantile(_s, 0.5), 0.01),
            ft_p95: __glitchless_round(__glitchless_sketch_quantile(_s, 0.95), 0.01),
            ft_p99: __glitchless_round(__glitchless_sketch_quantile(_s, 0.99), 0.01),
            ft_max: __glitchless_round(_w.mx, 0.1),
            slow: _w.slow,
            jank: _w.jank,
            hitches: _w.hitches,
            frozen: _w.frozen,
            render_ms: _w.draw_n > 0 ? __glitchless_round(_w.draw / _w.draw_n, 0.01) : undefined,
            gpu_ms: undefined,
            process_ms: _w.step_n > 0 ? __glitchless_round(_w.step / _w.step_n, 0.01) : undefined,
            physics_ms: undefined,
            draw_calls: undefined,
            draw_calls_max: undefined,
            triangles: undefined,
            geometries: undefined,
            textures: undefined,
            programs: undefined,
            gc_collections: _w.gc_collections,
            gc_ms: __glitchless_round(_w.gc_ms, 0.01),
            texture_loads: _w.texture_loads,
            heap_mb: _e[$ "heap_mb"],
            instances: _e[$ "instances"],
            surfaces: _e[$ "surfaces"],
            ds_lists: _e[$ "ds_lists"],
            ds_maps: _e[$ "ds_maps"],
            buffers: _e[$ "buffers"],
            screen: _g.screen,
            window: _g.window,
            ctx: _w.ctx
        });
        array_push(_g.recent_windows, { ts: _w.started_at, level: _g.level, fps: __glitchless_round(_n / _secs, 0.1), p95: __glitchless_round(__glitchless_sketch_quantile(_s, 0.95), 0.01) });
        if (array_length(_g.recent_windows) > 12) array_delete(_g.recent_windows, 0, 1);
    }
    if (array_length(_g.pos_buffer) > 0) {
        __glitchless_queue_event(_g, { type: "pos", ts: _g.pos_buffer[0][0], level: _g.level, pts: _g.pos_buffer });
        _g.pos_buffer = [];
    }
    array_sort(_g.pending_hitches, function(_a, _b) { return _b.duration_ms - _a.duration_ms; });
    for (var _i = 0; _i < min(array_length(_g.pending_hitches), __GLITCHLESS_MAX_HITCH_EVENTS_PER_WINDOW); _i++) {
        __glitchless_queue_event(_g, _g.pending_hitches[_i]);
        array_push(_g.recent_hitches, __glitchless_slim(_g.pending_hitches[_i]));
    }
    if (array_length(_g.recent_hitches) > __GLITCHLESS_BUG_RECENT) array_delete(_g.recent_hitches, 0, array_length(_g.recent_hitches) - __GLITCHLESS_BUG_RECENT);
    _g.pending_hitches = [];
}

/// Engine counts. The instance count climbs room after room when something creates instances and never
/// destroys them, and the surface, DS and buffer counts when something makes them and never frees them;
/// with engine_gauges on they go in ctx too, where the findings look for leaks. `_memory`: also read the
/// runner's memory and resource counts, which cost more, so only when a window closes or measure asks.
function __glitchless_sample_engine(_g, _memory) {
    _g.engine.instances = instance_count;
    if (_g.engine_gauges) __glitchless_gauge(_g, "instances", instance_count);
    if (_memory) {
        _g.engine.heap_mb = __glitchless_heap_mb();
        var _counts = __glitchless_resource_counts();
        var _names = variable_struct_get_names(_counts);
        for (var _i = 0; _i < array_length(_names); _i++) {
            _g.engine[$ _names[_i]] = _counts[$ _names[_i]];
            if (_g.engine_gauges) __glitchless_gauge(_g, _names[_i], _counts[$ _names[_i]]);
        }
    }
    return _g.engine;
}

/// The screen size changes when a desktop window moves to another screen or is resized: a breadcrumb
/// for any stutter that follows.
function __glitchless_check_screen(_g) {
    var _screen = [display_get_width(), display_get_height()];
    var _win = [window_get_width(), window_get_height()];
    if (array_length(_g.screen) == 0) {
        _g.screen = _screen;
        _g.window = _win;
    } else if (_screen[0] != _g.screen[0] || _screen[1] != _g.screen[1] || _win[0] != _g.window[0] || _win[1] != _g.window[1]) {
        _g.screen = _screen;
        _g.window = _win;
        __glitchless_track("screen_change", { screen: _screen, window: _win });
    }
}

/// Losing focus (another window, a call on a phone) is not a frame: the time until focus comes back is
/// left out, as are a trip to the background and back on a phone (os_is_paused).
function __glitchless_check_focus(_g) {
    var _focus = window_has_focus();
    if (_focus != _g.has_focus) {
        _g.has_focus = _focus;
        _g.skip_frame = true;
        _g.pending_long = undefined;
        if (!_focus && _g.inited && !_g.shut) __glitchless_flush(_g);
    }
    if (os_is_paused()) {
        _g.skip_frame = true;
        _g.pending_long = undefined;
        var _away = delta_time / 1000000;
        if (_g.inited && _g.enabled && _away > _g.opts.session_timeout) {
            __glitchless_new_session(_g);
        } else if (_g.inited) {
            __glitchless_track("app_resume", { away_s: __glitchless_round(_away, 0.1) });
        }
    }
}

/// Rooms as levels: a room that reads as a level (not a menu, title, boot or loading room) starts that
/// level, unless the game calls glitchless_level_start itself. Called from Room Start and every tick.
function __glitchless_check_room(_g) {
    if (room == _g.last_room) return;
    _g.last_room = room;
    if (!_g.inited || _g.manual_levels || _g.opts.rooms_as_levels != true) return;
    var _level = __glitchless_level_for_room(room_get_name(room));
    if (_level != "") {
        _g.level_room = room;
        __glitchless_level_start(_level, false);
    } else if (_g.level_room != -1) {
        _g.level_room = -1;
        __glitchless_close_window(_g, false);
        _g.level = undefined; // back in a menu: frames there have no level
    }
}

function __glitchless_gauge(_g, _key, _v) {
    _g.ctx[$ _key] = _v;
    var _had = _g.win.ctx[$ _key];
    _g.win.ctx[$ _key] = is_undefined(_had) ? _v : max(_had, _v);
    for (var _i = 0; _i < array_length(_g.probes); _i++) {
        var _p = _g.probes[_i];
        var _peak = _p.ctx_max[$ _key];
        _p.ctx_max[$ _key] = is_undefined(_peak) ? _v : max(_peak, _v);
    }
}

function __glitchless_last_frames(_g, _count) {
    var _out = [];
    for (var _i = min(_count, _g.ring_count); _i > 0; _i--) {
        array_push(_out, _g.ring[(_g.ring_idx - _i + __GLITCHLESS_RING_SIZE) % __GLITCHLESS_RING_SIZE]);
    }
    return _out;
}

// ───────────────────────────── measure ─────────────────────────────

/// Frame stats over the next `_seconds`, the same numbers as the browser SDK's glitchless_measure tool
/// and the other engines' measure flags; `_callback(result)` gets them.
function __glitchless_measure(_seconds, _callback) {
    var _g = __glitchless();
    __glitchless_sample_engine(_g, true);
    array_push(_g.probes, {
        sketch: __glitchless_sketch_new(),
        step: __glitchless_sketch_new(),
        draw: __glitchless_sketch_new(),
        frames: 0,
        mx: 0,
        gc_ms: 0,
        hitches: [],
        ctx_max: {},
        errors: _g.stats.errors,
        fingerprints: __glitchless_counts(_g.error_log),
        level: _g.level,
        engine: __glitchless_copy(_g.engine),
        seconds: _seconds,
        ends_at: current_time + _seconds * 1000,
        callback: _callback
    });
}

function __glitchless_check_probes(_g) {
    var _flag = _g.measure_flag;
    if (!is_undefined(_flag) && !_flag.started && current_time >= _flag.start_at) {
        _flag.started = true;
        __glitchless_measure(_flag.seconds, __glitchless_measure_flag_done);
    }
    for (var _i = array_length(_g.probes) - 1; _i >= 0; _i--) {
        var _p = _g.probes[_i];
        if (current_time >= _p.ends_at) {
            array_delete(_g.probes, _i, 1);
            var _result = __glitchless_probe_result(_g, _p);
            if (!is_undefined(_p.callback)) _p.callback(_result);
        }
    }
}

function __glitchless_probe_result(_g, _p) {
    if (_p.frames == 0) return { error: "No frames were drawn: the game was paused or in the background." };
    var _s = _p.sketch;
    var _now = __glitchless_sample_engine(_g, true);
    var _before = _p.engine;
    var _delta = {};
    var _keys = ["instances", "heap_mb", "surfaces", "ds_lists", "ds_maps", "buffers"];
    for (var _k = 0; _k < array_length(_keys); _k++) {
        var _a = _now[$ _keys[_k]];
        var _b = _before[$ _keys[_k]];
        _delta[$ _keys[_k]] = is_undefined(_a) || is_undefined(_b) ? undefined : __glitchless_round(_a - _b, 0.1);
    }
    var _new_errors = [];
    var _fps = variable_struct_get_names(_g.error_log);
    for (var _i = 0; _i < array_length(_fps); _i++) {
        var _e = _g.error_log[$ _fps[_i]];
        var _was = _p.fingerprints[$ _fps[_i]];
        if (is_undefined(_was)) _was = 0;
        if (_e.count > _was && array_length(_new_errors) < 5) array_push(_new_errors, { message: _e.message, kind: _e.kind, location: _e.location, count: _e.count - _was });
    }
    var _hitches = [];
    for (var _h = 0; _h < min(10, array_length(_p.hitches)); _h++) array_push(_hitches, _p.hitches[_h]);
    var _step_p50 = __glitchless_sketch_quantile(_p.step, 0.5);
    return {
        seconds: _p.seconds,
        level_start: _p.level,
        level_end: _g.level,
        frames: _p.frames,
        fps: __glitchless_round(_p.frames / _p.seconds, 0.1),
        frame_budget_ms: __glitchless_round(_g.budget_ms, 0.01),
        refresh_hz: __glitchless_refresh_rate(),
        frame_ms: {
            p50: __glitchless_round(__glitchless_sketch_quantile(_s, 0.5), 0.01),
            p95: __glitchless_round(__glitchless_sketch_quantile(_s, 0.95), 0.01),
            p99: __glitchless_round(__glitchless_sketch_quantile(_s, 0.99), 0.01),
            worst: __glitchless_round(_p.mx, 0.1)
        },
        pct_frames_over_budget: __glitchless_round(__glitchless_sketch_fraction_above(_s, _g.budget_ms * 1.15) * 100, 0.1),
        // CPU time the draw events took each frame: it rises with what the game draws even while the frame rate holds.
        render_cpu_ms: _p.draw.n > 0 ? {
            p50: __glitchless_round(__glitchless_sketch_quantile(_p.draw, 0.5), 0.01),
            p95: __glitchless_round(__glitchless_sketch_quantile(_p.draw, 0.95), 0.01),
            share_of_budget_pct: floor(__glitchless_sketch_quantile(_p.draw, 0.5) / _g.budget_ms * 100 + 0.5)
        } : undefined,
        gpu_ms: undefined,
        // Every instance's Begin Step, Step and End Step in a frame, and the collisions and alarms between.
        process_ms: _p.step.n > 0 ? { p50: __glitchless_round(_step_p50, 0.01), p95: __glitchless_round(__glitchless_sketch_quantile(_p.step, 0.95), 0.01) } : undefined,
        gc_ms: __glitchless_round(_p.gc_ms, 0.1),
        hitches: _hitches,
        hitch_count: array_length(_p.hitches),
        draw_calls: undefined,
        triangles_avg: undefined,
        peak_context: _p.ctx_max,
        memory: __glitchless_copy(_now),
        memory_delta: _delta,
        new_errors: _g.stats.errors - _p.errors,
        errors: _new_errors,
        renderer: code_is_compiled() ? "yyc" : "vm",
        headless: false,
        session_id: _g.session_id,
        sdk: GLITCHLESS_SDK
    };
}

function __glitchless_measure_flag_done(_result) {
    var _g = __glitchless();
    var _line = json_stringify({ glitchless_measure: _result });
    show_debug_message(_line);
    directory_create("glitchless");
    __glitchless_write_text("glitchless/measure.json", _line + "\n");
    show_debug_message("[glitchless] measure written to " + game_save_id + "glitchless/measure.json");
    var _out = _g.measure_flag.out;
    if (_out != "") __glitchless_write_text(_out, _line + "\n");
    __glitchless_shutdown(_g, "measure");
    _g.quitting = true;
    _g.quit_deadline = current_time + 1500;
}

// ───────────────────────────── errors ─────────────────────────────

/// A callstack's lines (from an exception, or debug_get_callstack) as frames, without Glitchless's own.
function __glitchless_frames(_lines) {
    var _out = [];
    for (var _i = 0; _i < array_length(_lines); _i++) {
        var _line = _lines[_i];
        if (!is_string(_line)) continue; // debug_get_callstack ends with a 0
        var _f = __glitchless_parse_frame(_line);
        if (array_length(_out) == 0 && __glitchless_is_own(_f.raw)) continue;
        array_push(_out, _f);
    }
    return _out;
}

function __glitchless_is_own(_name) {
    return string_copy(_name, 1, 24) == "gml_Script___glitchless_" || string_copy(_name, 1, 22) == "gml_Script_glitchless_"
        || string_copy(_name, 1, 25) == "gml_Object_obj_glitchless";
}

/// `_entry`: {kind, message, frames, attrs}. kind is "crash" (an unhandled exception: GameMaker stops
/// the game), "manual" (glitchless_error) or the game's own word.
function __glitchless_report_error(_g, _entry) {
    var _frames = _entry.frames;
    var _kind = _entry.kind;
    var _message = __glitchless_trim(__glitchless_scrub(_entry.message, game_save_id));
    _message = __glitchless_cut(_message, 500);
    if (_message == "") _message = "Unknown error";
    var _top = array_length(_frames) > 0 ? _frames[0] : undefined;
    var _fn = is_undefined(_top) ? "" : _top.fn;
    var _file = is_undefined(_top) ? "" : _top.source;
    var _line = is_undefined(_top) ? 0 : _top.line;
    var _fingerprint = __glitchless_fingerprint(_kind, _message, _fn);
    var _count = _g.error_counts[$ _fingerprint];
    _count = is_undefined(_count) ? 1 : _count + 1;
    _g.error_counts[$ _fingerprint] = _count;
    _g.stats.errors += 1;
    var _recent = __glitchless_recent_names(_g, 6);
    __glitchless_remember(_g, "error:" + __glitchless_cut(_message, 40));
    var _location = _fn != "" ? _fn + " (" + (_file != "" ? _file : "gml") + ":" + string(_line) + ")" : "";
    var _logged = _g.error_log[$ _fingerprint];
    if (is_undefined(_logged)) {
        _g.error_log[$ _fingerprint] = { message: _message, kind: _kind, location: _location, count: _count };
    } else {
        _logged.count = _count;
    }
    if (_count > __GLITCHLESS_MAX_ERRORS_PER_FINGERPRINT && _kind != "crash") return;
    var _stack = _kind + ": " + _message;
    for (var _i = 0; _i < min(20, array_length(_frames)); _i++) {
        var _f = _frames[_i];
        _stack += "\n    at " + _f.fn + " (" + _f.raw + (_f.line > 0 ? ":" + string(_f.line) : "") + ")";
    }
    var _attrs = _entry[$ "attrs"];
    __glitchless_push(_g, {
        type: "error",
        kind: _kind,
        message: _message,
        stack: __glitchless_cut(__glitchless_scrub(_stack, game_save_id), 4000),
        source: _file != "" ? _file : undefined,
        line: _fn != "" ? _line : undefined,
        col: undefined,
        fn: _fn != "" ? _fn : undefined,
        fingerprint: _fingerprint,
        attrs: is_struct(_attrs) && variable_struct_names_count(_attrs) > 0 ? _attrs : undefined,
        recent: _recent
    });
}

/// exception_unhandled_handler's function: GameMaker is about to stop the game. The crash, the session's
/// end and the frames up to it are written to the outbox and sent on the next launch.
function __glitchless_on_exception(_ex) {
    var _g = __glitchless();
    __glitchless_crash(_g, _ex);
    var _theirs = _g.opts.exception_handler;
    if (!is_undefined(_theirs)) return _theirs(_ex);
    return 0;
}

function __glitchless_crash(_g, _ex) {
    if (_g.crashed) return;
    _g.crashed = true;
    try {
        var _message = "";
        var _frames = [];
        if (is_struct(_ex)) {
            _message = is_undefined(_ex[$ "message"]) ? string(_ex) : string(_ex.message);
            var _trace = _ex[$ "stacktrace"];
            if (is_array(_trace)) _frames = __glitchless_frames(_trace);
        } else {
            _message = string(_ex);
        }
        __glitchless_report_error(_g, { kind: "crash", message: _message, frames: _frames, attrs: undefined });
        if (_g.inited && _g.enabled && !_g.ended) {
            _g.ended = true;
            __glitchless_push(_g, __glitchless_session_end(_g, "crash"));
        }
        _g.pending_long = undefined;
        __glitchless_close_window(_g, false); // the frames up to the crash
        if (!_g.inited || !_g.enabled) return;
        // Into the outbox file, which the next launch sends. Shut first, so the dying game starts no request:
        // one the server took just as the game died would arrive again from the outbox.
        _g.shut = true;
        __glitchless_flush(_g);
    } catch (_e) {
        // a failure here must not hide the game's own crash
    }
}

// ───────────────────────────── lifecycle and input ─────────────────────────────

/// Back after a long time away: a new session with a new random ID. In anonymous mode nothing joins it
/// to the last one.
function __glitchless_new_session(_g) {
    __glitchless_flush(_g);
    _g.session_id = __glitchless_new_id("s_", 16);
    _g.started_at = __glitchless_now(_g);
    _g.session_start_sent = false;
    _g.ended = false;
    _g.recent = [];
    _g.history = [];
    _g.error_counts = {};
}

function __glitchless_shutdown(_g, _reason) {
    if (_g.shut) return;
    _g.shut = true;
    if (_g.inited && _g.enabled && !_g.ended) {
        _g.ended = true;
        __glitchless_push(_g, __glitchless_session_end(_g, _reason));
    }
    if (_g.inited && _g.enabled) __glitchless_flush(_g);
}

function __glitchless_session_end(_g, _reason) {
    return { type: "session_end", reason: _reason, duration_s: __glitchless_round((__glitchless_now(_g) - _g.started_at) / 1000, 0.1) };
}

/// obj_glitchless's Game End: whatever has not gone is saved, and the next launch sends it.
function __glitchless_game_end() {
    var _g = __glitchless();
    __glitchless_shutdown(_g, "quit");
    __glitchless_save_outbox(_g);
}

function __glitchless_check_input(_g) {
    if (_g.bug_hotkey != -1 && keyboard_check_pressed(_g.bug_hotkey)) {
        __glitchless_bug_toggle(_g);
        return;
    }
    if (!is_undefined(_g.bug)) {
        __glitchless_bug_input(_g);
        return;
    }
    var _code = "";
    if (keyboard_check_pressed(vk_anykey)) {
        _code = string(keyboard_lastkey);
    } else if (mouse_check_button_pressed(mb_any)) {
        _code = "pointer";
    } else {
        for (var _pad = 0; _pad < 4 && _code == ""; _pad++) {
            if (gamepad_is_connected(_pad) && gamepad_button_check_pressed(_pad, gp_face1)) _code = "pad0";
        }
    }
    if (_code == "") return;
    var _now = current_time;
    if (_g.first_input_ms == 0 && _g.first_frame_ms > 0) {
        _g.first_input_ms = _now;
        __glitchless_push(_g, { type: "load", ttp_ms: _now });
    }
    if (!_g.rage_input) return;
    var _hist = _g.key_history[$ _code];
    var _kept = [];
    if (is_array(_hist)) {
        for (var _i = 0; _i < array_length(_hist); _i++) {
            if (_now - _hist[_i] < __GLITCHLESS_RAGE_INPUT_WINDOW_MS) array_push(_kept, _hist[_i]);
        }
    }
    array_push(_kept, _now);
    _g.key_history[$ _code] = _kept;
    if (array_length(_kept) == __GLITCHLESS_RAGE_INPUT_COUNT) __glitchless_track("rage_input", { key: _code, count: array_length(_kept) });
}

// ───────────────────────────── events ─────────────────────────────

function __glitchless_push(_g, _e) {
    if (_g.inited && !_g.enabled) return;
    if (is_undefined(_e[$ "ts"])) _e.ts = __glitchless_now(_g);
    if (!variable_struct_exists(_e, "level")) _e.level = _g.level;
    __glitchless_queue_event(_g, _e);
    if (_e.type != "session_end") {
        array_push(_g.history, __glitchless_slim(_e));
        if (array_length(_g.history) > __GLITCHLESS_BUG_RECENT) array_delete(_g.history, 0, 1);
    }
}

function __glitchless_queue_event(_g, _e) {
    array_push(_g.queue, _e);
    if (array_length(_g.queue) > __GLITCHLESS_MAX_QUEUE) array_delete(_g.queue, 0, array_length(_g.queue) - __GLITCHLESS_MAX_QUEUE);
}

function __glitchless_remember(_g, _name) {
    array_push(_g.recent, { name: _name, t: current_time });
    if (array_length(_g.recent) > 20) array_delete(_g.recent, 0, 1);
}

function __glitchless_recent_within(_g, _ms) {
    var _cutoff = current_time - _ms;
    var _out = [];
    for (var _i = 0; _i < array_length(_g.recent); _i++) {
        var _r = _g.recent[_i];
        if (_r.t >= _cutoff && !__glitchless_has(_out, _r.name)) array_push(_out, _r.name);
    }
    return _out;
}

function __glitchless_recent_names(_g, _count) {
    var _out = [];
    for (var _i = max(0, array_length(_g.recent) - _count); _i < array_length(_g.recent); _i++) array_push(_out, _g.recent[_i].name);
    return _out;
}

function __glitchless_session_start_event(_g) {
    return {
        type: "session_start",
        ts: _g.started_at,
        level: undefined,
        session_type: _g.session_type,
        privacy: _g.privacy,
        device: __glitchless_device(_g.full),
        page: undefined,
        nav_ms: undefined
    };
}

/// A game event as a bug report lists it: when, what, and the few fields that say what happened.
function __glitchless_slim(_e) {
    var _out = { ts: _e.ts, type: _e.type, level: _e[$ "level"] };
    var _keys = ["name", "cause", "kind", "reason", "duration_s", "score", "duration_ms", "causes", "x", "y", "z"];
    for (var _i = 0; _i < array_length(_keys); _i++) {
        var _v = _e[$ _keys[_i]];
        if (!is_undefined(_v)) _out[$ _keys[_i]] = _v;
    }
    var _message = _e[$ "message"];
    if (!is_undefined(_message)) _out.message = __glitchless_cut(string(_message), 200);
    var _attrs = _e[$ "attrs"];
    if (is_struct(_attrs) && variable_struct_names_count(_attrs) > 0 && string_length(json_stringify(_attrs)) <= 300) _out.attrs = _attrs;
    return _out;
}

// ───────────────────────────── helpers ─────────────────────────────

function __glitchless_log(_g, _msg) {
    if (_g.debug) show_debug_message("[glitchless] " + _msg);
}

/// The command line's arguments, without their leading dashes: "-glitchless-measure=5" and
/// "--glitchless-measure=5" both read as "glitchless-measure=5". Igor's Run (and so the IDE's) does not
/// pass a command line on to the game, so the same flags are also read from the GLITCHLESS_ARGS
/// environment variable and, in a build run from the IDE or Igor only, from glitchless/args.txt in the
/// save area.
function __glitchless_read_flags() {
    var _raw = [];
    for (var _i = 1; _i <= parameter_count(); _i++) array_push(_raw, parameter_string(_i));
    var _more = environment_get_variable("GLITCHLESS_ARGS");
    if (GM_build_type == "run") _more += " " + __glitchless_read_text("glitchless/args.txt");
    _more = string_replace_all(string_replace_all(string_replace_all(_more, "\r", " "), "\n", " "), "\t", " ");
    var _words = string_split(_more, " ", true);
    for (var _j = 0; _j < array_length(_words); _j++) array_push(_raw, _words[_j]);
    var _out = [];
    for (var _k = 0; _k < array_length(_raw); _k++) {
        var _a = _raw[_k];
        while (string_char_at(_a, 1) == "-") _a = string_copy(_a, 2, string_length(_a) - 1);
        if (_a != "") array_push(_out, _a);
    }
    return _out;
}

function __glitchless_has_flag(_g, _flag) {
    for (var _i = 0; _i < array_length(_g.flags); _i++) {
        var _a = _g.flags[_i];
        if (_a == _flag || string_copy(_a, 1, string_length(_flag) + 1) == _flag + "=") return true;
    }
    return false;
}

function __glitchless_flag_value(_g, _flag, _fallback) {
    for (var _i = 0; _i < array_length(_g.flags); _i++) {
        var _a = _g.flags[_i];
        if (string_copy(_a, 1, string_length(_flag) + 1) == _flag + "=") return string_copy(_a, string_length(_flag) + 2, string_length(_a) - string_length(_flag) - 1);
    }
    return _fallback;
}

/// Milliseconds since 1970 (UTC), to the millisecond: the clock gives whole seconds and
/// current_time the milliseconds since the game started.
function __glitchless_now(_g) {
    return _g.epoch_ms + current_time;
}

function __glitchless_unix_ms() {
    var _tz = date_get_timezone();
    date_set_timezone(timezone_utc);
    var _days = date_current_datetime() - 25569; // days from 1899-12-30 to 1970-01-01
    date_set_timezone(_tz);
    return floor(_days * 86400 + 0.5) * 1000;
}

/// A number in [0, 1) that leaves the game's random sequence alone.
function __glitchless_unit_random() {
    var _id = __glitchless_new_id("", 6);
    var _v = 0;
    for (var _i = 1; _i <= 6; _i++) _v = _v * 36 + string_pos(string_char_at(_id, _i), "abcdefghijklmnopqrstuvwxyz0123456789") - 1;
    return _v / power(36, 6);
}

function __glitchless_median(_values) {
    if (array_length(_values) == 0) return 0;
    var _sorted = [];
    array_copy(_sorted, 0, _values, 0, array_length(_values));
    array_sort(_sorted, true);
    return _sorted[floor(array_length(_sorted) / 2)];
}

function __glitchless_copy(_s) {
    var _out = {};
    var _names = variable_struct_get_names(_s);
    for (var _i = 0; _i < array_length(_names); _i++) _out[$ _names[_i]] = _s[$ _names[_i]];
    return _out;
}

/// {fingerprint: count} from the error log, for measure's "new since" errors.
function __glitchless_counts(_log) {
    var _out = {};
    var _names = variable_struct_get_names(_log);
    for (var _i = 0; _i < array_length(_names); _i++) _out[$ _names[_i]] = _log[$ _names[_i]].count;
    return _out;
}

function __glitchless_has(_array, _v) {
    for (var _i = 0; _i < array_length(_array); _i++) {
        if (_array[_i] == _v) return true;
    }
    return false;
}

function __glitchless_write_text(_path, _text) {
    var _buf = buffer_create(string_byte_length(_text) + 1, buffer_fixed, 1);
    buffer_write(_buf, buffer_text, _text);
    buffer_save_ext(_buf, _path, 0, string_byte_length(_text));
    buffer_delete(_buf);
}

function __glitchless_read_text(_path) {
    if (!file_exists(_path)) return "";
    var _buf = buffer_load(_path);
    if (_buf == -1) return "";
    var _text = buffer_get_size(_buf) > 0 ? buffer_read(_buf, buffer_text) : "";
    buffer_delete(_buf);
    return _text;
}
