/// The demo's game (obj_demo calls these, in its own scope). Not part of the SDK.

function demo_next_level() {
    level += 1;
    t = 0;
    next_event = 0.2;
    events_this_level = 0;
    if (level >= array_length(levels)) {
        if (autoplay) {
            quitting = true;
            glitchless_quit(); // sends the last batch, then ends the game
            return;
        }
        level = 0;
    }
    room_goto(levels[level]); // rooms as levels: the room's name is the level
}

/// One thing happening in the run: a pickup, a power-up, a death or a bonus.
function demo_play_event(_what) {
    if (_what == "") {
        var _pool = ["pickup", "pickup", "pickup", "powerup", "powerup", "death", "bonus"];
        _what = _pool[irandom(array_length(_pool) - 1)];
    }
    switch (_what) {
        case "pickup":
            glitchless_track("pickup", "coin");
            break;
        case "powerup":
            glitchless_track("powerup", "sparks");
            demo_burst(level == 1 ? 2500 : 30, level == 1);
            if (level == 1) {
                demo_sort_sparks_slowly();
                array_push(glow, surface_create(256, 256)); // planted leak: a glow surface per power-up, never freed
            }
            break;
        case "death":
            var _x = random(960);
            glitchless_death(_x, random(540), _x < 480 ? "spikes" : "fell");
            if (level == 2) glitchless_level_fail(undefined, "fell");
            break;
        default:
            glitchless_track("bonus", room_get_name(room));
            if (level == 2 && crash) {
                var _payout = obj_bonus_target.payout; // planted problem 2: there is no bonus target on rm_level_3
                show_debug_message("payout " + string(_payout));
            } else if (level == 0) {
                glitchless_error("bonus table missing row " + string(irandom_range(1000, 9999)) + " in " + game_save_id + "bonus.cfg", { table: "bonus" });
            }
            break;
    }
}

/// `_count` sparks from the middle of the room. Planted problem 1: on rm_level_2 they are persistent, so they
/// follow the player into every later room and are never destroyed.
function demo_burst(_count, _leak) {
    repeat (_count) {
        var _spark = instance_create_depth(480, 270, -10, obj_spark);
        _spark.persistent = _leak;
    }
}

/// Planted problem 1, the stutter: a bubble sort of the sparks by height, all in one step.
function demo_sort_sparks_slowly() {
    var _sparks = [];
    with (obj_spark) array_push(_sparks, id);
    var _n = min(array_length(_sparks), 1500);
    for (var _i = 0; _i < _n; _i++) {
        for (var _j = 0; _j < _n - _i - 1; _j++) {
            if (_sparks[_j].y > _sparks[_j + 1].y) {
                var _swap = _sparks[_j];
                _sparks[_j] = _sparks[_j + 1];
                _sparks[_j + 1] = _swap;
            }
        }
    }
}

/// A player pressing F8, changing their mind (Esc), pressing F8 again, typing a note and pressing Enter. GameMaker
/// can't fake key presses, so this calls what those keys call. Time sources keep running while the form has the
/// game paused, which obj_demo's own events don't.
function demo_pretend_bug_form(_at) {
    // Unbound (method(undefined, ...)): obj_demo is deactivated while the form is open.
    var _steps = [
        method(undefined, function() { glitchless_open_bug_report(); }),
        method(undefined, function() { __glitchless_bug_close(__glitchless()); }),
        method(undefined, function() { glitchless_open_bug_report(); }),
        method(undefined, function() { keyboard_string = "sparks froze the screen"; }),
        method(undefined, function() { __glitchless_bug_send(__glitchless()); })
    ];
    var _start = max(1, floor(_at * game_get_speed(gamespeed_fps)));
    for (var _i = 0; _i < array_length(_steps); _i++) {
        time_source_start(time_source_create(time_source_global, _start + _i * 3, time_source_units_frames, _steps[_i], [], 1));
    }
}

/// -glitchless-selftest: the SDK's sketch and fingerprints of the JavaScript fixture (datafiles/glitchless_fixture.json,
/// written by gamemaker/test/make-fixtures.mjs), computed by this runner, plus what its JSON, zlib and CRC-32 give.
/// gamemaker/test/e2e.mjs compares glitchless/selftest.json with the fixture.
function demo_selftest() {
    var _buf = buffer_load("glitchless_fixture.json");
    var _fixture = json_parse(buffer_read(_buf, buffer_text));
    buffer_delete(_buf);
    var _sk = __glitchless_sketch_new();
    for (var _i = 0; _i < array_length(_fixture.values); _i++) __glitchless_sketch_add(_sk, _fixture.values[_i]);
    var _quantiles = {};
    var _qs = [[0.1, "0.1"], [0.5, "0.5"], [0.9, "0.9"], [0.95, "0.95"], [0.99, "0.99"]]; // string(0.1) is "0.10"
    for (var _q = 0; _q < array_length(_qs); _q++) _quantiles[$ _qs[_q][1]] = __glitchless_sketch_quantile(_sk, _qs[_q][0]);
    var _indexes = [];
    for (var _k = 0; _k < array_length(_fixture.indexes); _k++) array_push(_indexes, __glitchless_sketch_index(_sk, _fixture.indexes[_k][0]));
    var _fingerprints = [];
    for (var _f = 0; _f < array_length(_fixture.fingerprints); _f++) {
        var _c = _fixture.fingerprints[_f];
        array_push(_fingerprints, { normalized: __glitchless_normalize_message(_c.message), fingerprint: __glitchless_fingerprint(_c.kind, _c.message, _c.fn) });
    }
    var _gzip_ok = __glitchless_gzip_works();
    var _gz = __glitchless_gzip("glitchless gzip check: émoji 🐶");
    var _out = {
        runtime: GM_runtime_version,
        sketch: __glitchless_sketch_json(_sk),
        quantiles: _quantiles,
        fraction_above_19_17: __glitchless_sketch_fraction_above(_sk, 19.17),
        indexes: _indexes,
        fingerprints: _fingerprints,
        gzip_works: _gzip_ok,
        crc_inverted: global.__glitchless_crc_inverted,
        gzip: _gz == -1 ? "" : buffer_base64_encode(_gz, 0, buffer_get_size(_gz)),
        json_numbers: json_stringify({ ts: 1792766421123, ms: 16.67, tiny: 0.02, big: 123456789012 }),
        unix_ms: __glitchless_unix_ms(),
        save_dir: game_save_id,
        id: __glitchless_new_id("s_", 16),
        heap_mb: __glitchless_heap_mb()
    };
    if (_gz != -1) buffer_delete(_gz);
    directory_create("glitchless");
    __glitchless_write_text("glitchless/selftest.json", json_stringify(_out));
    show_debug_message("glitchless selftest written");
}

/// -glitchless-overhead: what the SDK costs this build's frames, for the README's "What it costs" (gamemaker/test/
/// overhead.mjs runs it). Its per-frame calls (the time source's tick, Begin Step, Pre-Draw, Draw GUI End, Post-Draw)
/// in a loop, so GML time only with nothing drawn; the frame window closing and a flush (the events become a batch,
/// saved, and its send started), as every 5 seconds; and the offline worst case, a flush and a save with the outbox
/// near its 4,000-event cap. The intake is a closed port and no reply comes while it runs, so nothing is sent. The
/// outbox is removed, and once demo_overhead_async_step has saved it again with buffer_save_async, the numbers go to
/// glitchless/overhead.txt in the save area and the game ends.
function demo_overhead() {
    var _g = __glitchless();
    glitchless_level_start("level_1");
    _g.next_flush = infinity; // flushed below, by hand
    var _frame = function() {
        __glitchless_tick();
        __glitchless_begin_step();
        __glitchless_pre_draw();
        __glitchless_draw_end();
        __glitchless_post_draw();
    };
    var _frames = 5000;
    var _t = get_timer();
    for (var _i = 0; _i < _frames; _i++) {}
    var _loop = get_timer() - _t;
    var _best = infinity;
    for (var _run = 0; _run < 5; _run++) {
        _t = get_timer();
        for (var _i = 0; _i < _frames; _i++) _frame();
        _best = min(_best, (get_timer() - _t - _loop) / _frames);
        __glitchless_close_window(_g, true); // a window as long as a real one
        _g.next_flush = infinity;
    }

    var _closes = "";
    var _flushes = "";
    for (var _k = 0; _k < 8; _k++) {
        for (var _i = 0; _i < 300; _i++) _frame();
        glitchless_track("pickup", "coin");
        _t = get_timer();
        __glitchless_close_window(_g, true);
        _closes += (_k > 0 ? ", " : "") + string(get_timer() - _t);
        _t = get_timer();
        __glitchless_flush(_g); // a batch, saved, and its send started
        _flushes += (_k > 0 ? ", " : "") + string(get_timer() - _t);
        _g.outbox = []; // as if sent
        _g.in_flight = -1;
        _g.next_flush = infinity;
    }

    // Offline: the send started below never gets its reply while this runs, so batches pile up to the cap.
    var _events = 0;
    var _loops = 0;
    while (_events < 3900) {
        for (var _i = 0; _i < 300; _i++) _frame();
        _loops += 1;
        for (var _j = 0; _j < 19; _j++) glitchless_track("pickup_" + string(_loops), { item: "coin", n: _j }); // under 20 a second
        __glitchless_flush(_g);
        _g.next_flush = infinity;
        _events = 0;
        for (var _b = 0; _b < array_length(_g.outbox); _b++) _events += array_length(_g.outbox[_b].events);
    }
    var _offline = "";
    for (var _k = 0; _k < 3; _k++) {
        for (var _j = 0; _j < 19; _j++) glitchless_track("pickup_more_" + string(_k), { item: "coin", n: _j });
        _t = get_timer();
        __glitchless_flush(_g);
        _offline += (_k > 0 ? ", " : "") + string(get_timer() - _t);
        _g.next_flush = infinity;
    }
    var _saves = "";
    for (var _k = 0; _k < 3; _k++) {
        _t = get_timer();
        __glitchless_save_outbox(_g);
        _saves += (_k > 0 ? ", " : "") + string(get_timer() - _t);
    }
    _events = 0;
    for (var _b = 0; _b < array_length(_g.outbox); _b++) _events += array_length(_g.outbox[_b].events);
    var _kb = floor(string_byte_length(__glitchless_read_text("glitchless/outbox.json")) / 1024);

    var _text = "GameMaker " + GM_runtime_version + ", " + (code_is_compiled() ? "YYC" : "VM") + " build\n"
        + "each frame: " + string(_best) + " us\n"
        + "window close (every 5 s): [" + _closes + "] us\n"
        + "flush and its send started (every 5 s): [" + _flushes + "] us\n"
        + "flush with " + string(_events) + " events waiting offline: [" + _offline + "] us\n"
        + "save with " + string(_events) + " events waiting offline (" + string(_kb) + " KB): [" + _saves + "] us\n";
    // The same file again with buffer_save_async, over the next frames (demo_overhead_async_step), then the game ends.
    global.demo_async_save = { text: _text, buffer: buffer_load(__GLITCHLESS_OUTBOX), id: -1, step_at: 0, frames: 0, count: 0, calls: "", passes: "" };
    _g.outbox = []; // nothing left for a next launch to send
    _g.queue = [];
    __glitchless_save_outbox(_g);
    _g.enabled = false;
}

/// -glitchless-overhead, after demo_overhead: the outbox it saved, saved again with buffer_save_async, to show where that
/// write happens. The call only copies the buffer; the runner writes the file on the main thread in its pass over async
/// events, which comes after the Step events of the same frame. So obj_demo's Step notes the time, and its Async
/// Save/Load event (demo_overhead_async_saved) how long that pass took. Five saves a few frames apart, then the numbers
/// go to glitchless/overhead.txt and the game ends.
function demo_overhead_async_step() {
    var _a = global.demo_async_save;
    _a.frames += 1;
    _a.step_at = get_timer();
    if (_a.count == 5 || _a.buffer == -1 || _a.frames > 600) { // 600: an event that never came
        var _text = _a.text;
        if (_a.count > 0) _text += "the same save with buffer_save_async: the call [" + _a.calls + "] us, then the runner's async pass in the same frame [" + _a.passes + "] us\n";
        show_debug_message(_text);
        __glitchless_write_text("glitchless/overhead.txt", _text);
        if (_a.buffer != -1) buffer_delete(_a.buffer);
        if (file_exists("default/glitchless/overhead_async.json")) file_delete("default/glitchless/overhead_async.json"); // where it saves
        global.demo_async_save = undefined;
        game_end();
        return;
    }
    if (_a.id != -1 || _a.frames % 4 != 0) return;
    var _t = get_timer();
    _a.id = buffer_save_async(_a.buffer, "glitchless/overhead_async.json", 0, buffer_get_size(_a.buffer));
    _a.calls += (_a.count > 0 ? ", " : "") + string(get_timer() - _t);
    _a.step_at = get_timer();
}

/// obj_demo's Async Save/Load event.
function demo_overhead_async_saved(_id) {
    var _a = variable_global_exists("demo_async_save") ? global.demo_async_save : undefined;
    if (!is_struct(_a) || _id != _a.id) return;
    _a.passes += (_a.count > 0 ? ", " : "") + string(get_timer() - _a.step_at);
    _a.count += 1;
    _a.id = -1;
}
