// Feather disable all
/// Glitchless: players' bug reports (SPEC §2 bug_report).
///
/// A report carries what the player typed, a screenshot of the game as it was, where they were and what
/// had just happened (the last game events and hitches, and the last frame windows). It goes on a request
/// of its own straight away, from every session; it waits in the outbox meanwhile, so if the send fails,
/// or the game closes first, it goes with a later batch.
///
/// The screenshot can only be read in a draw event, so a report asked for in a Step event is finished in
/// obj_glitchless's Post-Draw of the same frame, when the frame is complete. The form itself (drawing it,
/// pausing the game, reading the surface) is in __glitchless_engine.

#macro __GLITCHLESS_MAX_NOTE 2000
#macro __GLITCHLESS_MAX_SCREENSHOT 200000 // characters of data URL the server keeps (larger ones lose the picture)

/// glitchless_report_bug: a report from the game's own UI. With the player's switch off it answers "off" at once,
/// before any screenshot is taken.
function __glitchless_report_bug(_note, _screenshot, _callback) {
    var _g = __glitchless();
    if (!_g.player_on) {
        if (!is_undefined(_callback)) _callback({ sent: false, reason: "off" });
        return;
    }
    __glitchless_remember(_g, "bug_report");
    var _request = { note: string(_note), callback: _callback, form: false };
    if (_screenshot == true) {
        _g.bug_capture = _request; // finished in this frame's Post-Draw
    } else {
        __glitchless_send_report(_g, __glitchless_bug_snapshot(_g, ""), _request);
    }
}

/// F8, or glitchless_open_bug_report: the form opens once this frame's screenshot is taken. Not while the player has
/// Glitchless off.
function __glitchless_bug_toggle(_g) {
    if (!is_undefined(_g.bug)) {
        __glitchless_bug_close(_g);
    } else if (is_undefined(_g.bug_capture) && _g.player_on) {
        _g.bug_capture = { note: "", callback: undefined, form: true };
    }
}

/// obj_glitchless's Post-Draw: takes the screenshot a report or the form is waiting for.
function __glitchless_post_draw() {
    var _g = __glitchless();
    var _request = _g.bug_capture;
    if (is_undefined(_request)) return;
    _g.bug_capture = undefined;
    var _want = is_undefined(_g.bug_opts) || _g.bug_opts.screenshot == true;
    if (!_request.form) _want = true;
    var _shot = _want ? __glitchless_capture_screenshot(_g) : { url: "", sprite: -1 };
    // Reading the picture back stalls this frame, and the form's first frame draws it: that isn't the
    // game stuttering, so neither is timed.
    _g.untimed = 2;
    var _snap = __glitchless_bug_snapshot(_g, _shot.url);
    if (_request.form) {
        __glitchless_bug_open(_g, _snap, _shot.sprite);
    } else {
        if (_shot.sprite != -1) sprite_delete(_shot.sprite);
        __glitchless_send_report(_g, _snap, _request);
    }
}

/// What the player is looking at and doing right now.
function __glitchless_bug_snapshot(_g, _screenshot) {
    var _snap = { ts: __glitchless_now(_g), level: _g.level, screenshot: _screenshot, position: undefined };
    if (_g.positions && !is_undefined(_g.position)) {
        _snap.position = [__glitchless_round(_g.position[0], 0.01), __glitchless_round(_g.position[1], 0.01), __glitchless_round(_g.position[2], 0.01)];
    }
    // The last game events and hitches, oldest first.
    var _recent = [];
    for (var _i = 0; _i < array_length(_g.history); _i++) array_push(_recent, _g.history[_i]);
    var _hitches = [];
    for (var _j = 0; _j < array_length(_g.recent_hitches); _j++) array_push(_hitches, _g.recent_hitches[_j]);
    for (var _k = 0; _k < array_length(_g.pending_hitches); _k++) array_push(_hitches, __glitchless_slim(_g.pending_hitches[_k]));
    for (var _h = 0; _h < array_length(_hitches); _h++) {
        if (_snap.ts - _hitches[_h].ts < 60000) array_push(_recent, _hitches[_h]);
    }
    array_sort(_recent, function(_a, _b) { return _a.ts - _b.ts; });
    _snap.recent = __glitchless_last(_recent, __GLITCHLESS_BUG_RECENT);
    // Frame rate and p95 of the last windows, and of the one still open.
    var _frames = [];
    for (var _f = 0; _f < array_length(_g.recent_windows); _f++) array_push(_frames, _g.recent_windows[_f]);
    var _w = _g.win;
    if (_w.frames > 0) {
        var _secs = max((current_time - _w.started_ms) / 1000, 0.001);
        array_push(_frames, { ts: _w.started_at, level: _g.level, fps: __glitchless_round(_w.frames / _secs, 0.1), p95: __glitchless_round(__glitchless_sketch_quantile(_w.sketch, 0.95), 0.01) });
    }
    _snap.frames = __glitchless_last(_frames, __GLITCHLESS_BUG_FRAMES);
    return _snap;
}

/// Sends one report on a request of its own. `_request.callback({sent, reason})`: sent is true once the
/// server has it; otherwise reason is "offline" (nothing is sent from this build), "off" (the player turned
/// Glitchless off) or "error" (it goes with a later batch).
function __glitchless_send_report(_g, _snap, _request) {
    var _e = { type: "bug_report", ts: _snap.ts, level: _snap.level, note: __glitchless_cut(_request.note, __GLITCHLESS_MAX_NOTE) };
    if (_snap.screenshot != "") _e.screenshot = _snap.screenshot;
    if (!is_undefined(_snap.position)) {
        _e[$ "x"] = _snap.position[0];
        _e[$ "y"] = _snap.position[1];
        _e[$ "z"] = _snap.position[2];
    }
    _e.recent = _snap.recent;
    _e.frames = _snap.frames;
    _e.device = __glitchless_device(_g.full);
    if (!_g.inited || !_g.enabled) {
        __glitchless_report_done(_request, { sent: false, reason: _g.player_on ? "offline" : "off" });
        return;
    }
    __glitchless_flush(_g); // the session's own events first, so the report's session is there when someone opens it
    var _b = __glitchless_batch(_g, [_e]);
    _b.direct = true;
    array_push(_g.outbox, _b);
    __glitchless_save_outbox(_g);
    var _req = __glitchless_post(_g, _b);
    if (_req.id < 0) {
        if (_req.buffer != -1) buffer_delete(_req.buffer);
        _b.direct = false;
        _g.stats.failed += 1;
        __glitchless_report_done(_request, { sent: false, reason: "error" });
        return;
    }
    _g.report_requests[$ string(_req.id)] = { bid: _b.bid, buffer: _req.buffer, request: _request };
}

/// The reply to a report's own request (from __glitchless_on_http).
function __glitchless_report_sent(_g, _pending, _status, _http_status) {
    if (_pending.buffer != -1) buffer_delete(_pending.buffer);
    var _i = __glitchless_outbox_index(_g, _pending.bid);
    if (_i >= 0) _g.outbox[_i].direct = false;
    var _sent = _status == 0 && _http_status >= 200 && _http_status < 300;
    var _refused = _status == 0 && _http_status >= 400 && _http_status < 500 && _http_status != 408 && _http_status != 429; // a rejected report would only be rejected again
    if ((_sent || _refused) && _i >= 0) {
        array_delete(_g.outbox, _i, 1);
        __glitchless_save_outbox(_g);
    }
    if (_sent) {
        _g.stats.sent += 1;
        __glitchless_report_done(_pending.request, { sent: true });
    } else {
        _g.stats.failed += 1;
        __glitchless_log(_g, "bug report not sent (HTTP " + string(_http_status) + "): it goes with the next batch");
        __glitchless_report_done(_pending.request, { sent: false, reason: "error" });
    }
}

function __glitchless_report_done(_request, _result) {
    if (_request.form) {
        __glitchless_bug_result(__glitchless(), _result);
    } else if (!is_undefined(_request.callback)) {
        _request.callback(_result);
    }
}

// ───────────────────────────── the form ─────────────────────────────

function __glitchless_bug_open(_g, _snap, _sprite) {
    if (!is_undefined(_g.bug)) return;
    var _opts = is_undefined(_g.bug_opts) ? { pause: true, on_open: undefined, on_close: undefined } : _g.bug_opts;
    _g.bug = {
        snap: _snap,
        sprite: _sprite,
        state: "form",
        close_at: 0,
        pause: _opts.pause == true,
        paused: [],
        keyboard_string_was: keyboard_string,
        opened_at: current_time
    };
    keyboard_string = "";
    if (_g.bug.pause) _g.bug.paused = __glitchless_pause_game();
    __glitchless_log(_g, "bug report form opened");
    if (!is_undefined(_opts[$ "on_open"])) _opts.on_open();
}

function __glitchless_bug_close(_g) {
    var _bug = _g.bug;
    if (is_undefined(_bug)) return;
    _g.bug = undefined;
    if (_bug.sprite != -1) sprite_delete(_bug.sprite);
    if (_bug.pause) __glitchless_resume_game(_bug.paused);
    keyboard_string = _bug.keyboard_string_was;
    _g.untimed = max(_g.untimed, 1);
    __glitchless_log(_g, "bug report form closed");
    var _opts = _g.bug_opts;
    if (!is_undefined(_opts) && !is_undefined(_opts[$ "on_close"])) _opts.on_close();
}

/// Keys while the form is open: Esc cancels, Enter sends; the note is what the player types.
function __glitchless_bug_input(_g) {
    var _bug = _g.bug;
    if (_bug.state != "form") {
        if (current_time >= _bug.close_at) __glitchless_bug_close(_g);
        return;
    }
    if (string_length(keyboard_string) > __GLITCHLESS_MAX_NOTE) keyboard_string = string_copy(keyboard_string, 1, __GLITCHLESS_MAX_NOTE);
    if (keyboard_check_pressed(vk_escape)) {
        __glitchless_bug_close(_g);
    } else if (keyboard_check_pressed(vk_enter)) {
        __glitchless_bug_send(_g);
    } else if (mouse_check_button_pressed(mb_left)) {
        var _hit = __glitchless_bug_button_at(_g, device_mouse_x_to_gui(0), device_mouse_y_to_gui(0));
        if (_hit == "send") __glitchless_bug_send(_g);
        if (_hit == "cancel") __glitchless_bug_close(_g);
    }
}

function __glitchless_bug_send(_g) {
    var _bug = _g.bug;
    if (is_undefined(_bug) || _bug.state != "form") return;
    _bug.state = "sending";
    _bug.note = __glitchless_trim(keyboard_string);
    __glitchless_send_report(_g, _bug.snap, { note: _bug.note, callback: undefined, form: true });
}

function __glitchless_bug_result(_g, _result) {
    var _bug = _g.bug;
    if (is_undefined(_bug)) return; // closed meanwhile
    _bug.state = _result.sent ? "sent" : (_result[$ "reason"] == "offline" ? "offline" : "failed");
    _bug.close_at = current_time + (_result.sent ? 1200 : 2500);
}

function __glitchless_last(_array, _n) {
    var _out = [];
    for (var _i = max(0, array_length(_array) - _n); _i < array_length(_array); _i++) array_push(_out, _array[_i]);
    return _out;
}
