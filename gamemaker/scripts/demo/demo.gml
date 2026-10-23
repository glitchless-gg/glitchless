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
