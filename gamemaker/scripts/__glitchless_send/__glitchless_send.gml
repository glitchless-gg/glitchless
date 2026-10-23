// Feather disable all
/// Glitchless: batches, sending and the outbox.
///
/// Events wait in a queue; every flush_interval seconds they become batches of at most ~60 KB in the
/// outbox, which is saved to glitchless/outbox.json in the game's save area. One batch is in flight at a
/// time, through http_request; its reply comes to obj_glitchless's Async HTTP event. A batch leaves the
/// outbox once the server has it (or turned it away for good), so a game played offline, or one that
/// crashed, sends on a later launch.

#macro __GLITCHLESS_BATCH_BYTES 60000
#macro __GLITCHLESS_MAX_OUTBOX_EVENTS 4000
#macro __GLITCHLESS_MAX_OUTBOX_AGE_MS 518400000 // 6 days: the server files anything over 7 days old under "now"
#macro __GLITCHLESS_OUTBOX "glitchless/outbox.json"

/// Closes the current frame window and moves what is waiting into the outbox. Runs by itself every
/// flush_interval seconds.
function __glitchless_flush(_g) {
    _g.next_flush = current_time + _g.opts.flush_interval * 1000;
    __glitchless_close_window(_g, true);
    if (!_g.inited) return;
    if (!_g.enabled) {
        _g.queue = [];
        return;
    }
    if (!_g.session_start_sent) {
        array_insert(_g.queue, 0, __glitchless_session_start_event(_g));
        _g.session_start_sent = true;
        if (_g.first_frame_ms > 0 && !_g.load_sent) {
            _g.load_sent = true;
            array_push(_g.queue, { type: "load", ts: __glitchless_now(_g), level: _g.level, ttff_ms: _g.first_frame_ms, assets: undefined });
        }
    }
    if (!_g.sampled) {
        _g.queue = [];
        _g.stats.last_status = "unsampled";
        return;
    }
    if (array_length(_g.queue) > 0) {
        __glitchless_add_batches(_g, _g.queue);
        _g.queue = [];
        __glitchless_save_outbox(_g);
    }
    if (!_g.shut || _g.quitting) __glitchless_send_next(_g);
}

function __glitchless_add_batches(_g, _events) {
    var _chunk = [];
    var _size = 0;
    for (var _i = 0; _i < array_length(_events); _i++) {
        var _e = _events[_i];
        var _bytes = string_byte_length(json_stringify(_e));
        if (array_length(_chunk) > 0 && _size + _bytes > __GLITCHLESS_BATCH_BYTES * 0.9) {
            array_push(_g.outbox, __glitchless_batch(_g, _chunk));
            _chunk = [];
            _size = 0;
        }
        array_push(_chunk, _e);
        _size += _bytes;
    }
    if (array_length(_chunk) > 0) array_push(_g.outbox, __glitchless_batch(_g, _chunk));
    var _total = 0;
    for (var _j = 0; _j < array_length(_g.outbox); _j++) _total += array_length(_g.outbox[_j].events);
    while (_total > __GLITCHLESS_MAX_OUTBOX_EVENTS && array_length(_g.outbox) > 1 && _g.outbox[0].bid != _g.in_flight) {
        _total -= array_length(_g.outbox[0].events);
        array_delete(_g.outbox, 0, 1);
    }
}

function __glitchless_batch(_g, _events) {
    var _b = { bid: _g.next_bid, service: _g.service, env: _g.env, version: _g.version, sid: _g.session_id, pid: _g.player_id, group: _g.started_at, events: _events, direct: false };
    _g.next_bid += 1;
    return _b;
}

function __glitchless_body(_b) {
    return json_stringify({
        service: _b.service,
        env: _b.env,
        version: _b.version,
        session_id: _b.sid,
        player_id: _b.pid != "" ? _b.pid : undefined, // the server uses the session ID in its place
        sdk: GLITCHLESS_SDK,
        events: _b.events
    });
}

function __glitchless_intake_url(_g) {
    return _g.intake + "/v1/intake?token=" + __glitchless_url_encode(_g.opts.client_token);
}

/// Sends one batch: gzipped in a buffer when the runner's zlib works, plain JSON otherwise. Content-Type
/// is text/plain, as the browser SDK sends it; the server knows gzip by its first two bytes.
function __glitchless_post(_g, _b) {
    var _json = __glitchless_body(_b);
    if (_g.headers == -1) {
        _g.headers = ds_map_create();
        ds_map_add(_g.headers, "Content-Type", "text/plain");
    }
    var _body = _json;
    var _buffer = -1;
    if (_g.gzip) {
        _buffer = __glitchless_gzip(_json);
        if (_buffer != -1) _body = _buffer;
    }
    if (_g.debug) __glitchless_log(_g, "sending " + string(array_length(_b.events)) + " events (" + string(string_byte_length(_json)) + " bytes" + (_buffer != -1 ? ", " + string(buffer_get_size(_buffer)) + " gzipped" : "") + ")");
    var _id = http_request(__glitchless_intake_url(_g), "POST", _g.headers, _body);
    return { id: _id, buffer: _buffer };
}

function __glitchless_send_next(_g) {
    if (_g.in_flight != -1 || array_length(_g.outbox) == 0 || current_time < _g.retry_at) return;
    var _b = undefined;
    for (var _i = 0; _i < array_length(_g.outbox); _i++) {
        if (!_g.outbox[_i].direct) { // a bug report on its own request
            _b = _g.outbox[_i];
            break;
        }
    }
    if (is_undefined(_b)) return;
    var _req = __glitchless_post(_g, _b);
    if (_req.id < 0) {
        if (_req.buffer != -1) buffer_delete(_req.buffer);
        __glitchless_retry_later(_g, "http_request failed");
        return;
    }
    _g.in_flight = _b.bid;
    _g.http_id = _req.id;
    _g.http_buffer = _req.buffer;
    _g.in_flight_since = current_time;
}

/// obj_glitchless's Async HTTP event, with async_load's id, status and http_status.
function __glitchless_on_http(_id, _status, _http_status) {
    var _g = __glitchless();
    if (_status == 1) return; // still downloading the reply
    var _report = _g.report_requests[$ string(_id)];
    if (!is_undefined(_report)) {
        variable_struct_remove(_g.report_requests, string(_id));
        __glitchless_report_sent(_g, _report, _status, _http_status);
        return;
    }
    if (_id != _g.http_id) return;
    var _bid = _g.in_flight;
    _g.in_flight = -1;
    _g.http_id = -1;
    if (_g.http_buffer != -1) {
        buffer_delete(_g.http_buffer);
        _g.http_buffer = -1;
    }
    var _i = __glitchless_outbox_index(_g, _bid);
    var _n = _i >= 0 ? array_length(_g.outbox[_i].events) : 0;
    var _ok = _status == 0 && _http_status >= 200 && _http_status < 300;
    var _refused = _status == 0 && _http_status >= 400 && _http_status < 500 && _http_status != 408 && _http_status != 429;
    if (_ok) {
        _g.stats.sent += _n;
        _g.stats.last_status = "ok";
        _g.backoff = 0;
    } else if (_refused) {
        _g.stats.failed += _n; // the server turned it away; sending it again would only fail again
        _g.stats.last_status = "rejected " + string(_http_status);
    } else {
        _g.stats.failed += _n;
        __glitchless_retry_later(_g, "HTTP " + string(_http_status) + ", status " + string(_status));
        return;
    }
    if (_i >= 0) array_delete(_g.outbox, _i, 1);
    __glitchless_save_outbox(_g);
    __glitchless_send_next(_g);
}

function __glitchless_retry_later(_g, _why) {
    _g.stats.last_status = "error";
    _g.backoff = clamp(_g.backoff * 2, 5, 300);
    _g.retry_at = current_time + _g.backoff * 1000;
    __glitchless_log(_g, "send failed: " + _why + "; trying again in " + string(_g.backoff) + "s");
}

function __glitchless_outbox_index(_g, _bid) {
    for (var _i = 0; _i < array_length(_g.outbox); _i++) {
        if (_g.outbox[_i].bid == _bid) return _i;
    }
    return -1;
}

// ───────────────────────────── gzip ─────────────────────────────

/// A gzip file of `_text` in a new buffer, or -1. GameMaker's buffer_compress writes a zlib stream (a
/// 2-byte header, the deflate data, an Adler-32); gzip wraps the same deflate data in its own 10-byte
/// header and a CRC-32 and length of the original.
function __glitchless_gzip(_text) {
    var _size = string_byte_length(_text);
    var _src = buffer_create(max(1, _size), buffer_fixed, 1);
    buffer_write(_src, buffer_text, _text);
    var _z = buffer_compress(_src, 0, _size);
    if (_z < 0) {
        buffer_delete(_src);
        return -1;
    }
    var _zsize = buffer_get_size(_z);
    var _cmf = buffer_peek(_z, 0, buffer_u8);
    var _flg = buffer_peek(_z, 1, buffer_u8);
    // deflate, no preset dictionary, and a valid header check: anything else is not a stream gzip can carry
    if (_zsize < 6 || (_cmf % 16) != 8 || ((_cmf * 256 + _flg) % 31) != 0 || (floor(_flg / 32) % 2) == 1) {
        buffer_delete(_src);
        buffer_delete(_z);
        return -1;
    }
    var _crc = __glitchless_crc32(_src, _size);
    var _deflate = _zsize - 6;
    var _out = buffer_create(10 + _deflate + 8, buffer_fixed, 1);
    buffer_write(_out, buffer_u8, 31); // 0x1f 0x8b: gzip
    buffer_write(_out, buffer_u8, 139);
    buffer_write(_out, buffer_u8, 8); // deflate
    buffer_write(_out, buffer_u8, 0); // no flags
    buffer_write(_out, buffer_u32, 0); // no modification time
    buffer_write(_out, buffer_u8, 0);
    buffer_write(_out, buffer_u8, 255); // unknown OS
    buffer_copy(_z, 2, _deflate, _out, 10);
    buffer_seek(_out, buffer_seek_start, 10 + _deflate);
    buffer_write(_out, buffer_u32, _crc);
    buffer_write(_out, buffer_u32, _size % 4294967296);
    buffer_delete(_src);
    buffer_delete(_z);
    return _out;
}

/// The standard CRC-32 (zlib's, gzip's) of a buffer's first `_size` bytes. buffer_crc32 is native and
/// fast, but runners have differed on whether it inverts the result, so __glitchless_gzip_works checks
/// it against the known value once and this follows what it found.
function __glitchless_crc32(_buf, _size) {
    var _c = buffer_crc32(_buf, 0, _size);
    if (_c < 0) _c += 4294967296;
    return global.__glitchless_crc_inverted ? 4294967295 - _c : _c;
}

/// Whether gzip can be made here: buffer_compress makes a zlib stream and the CRC-32 of "123456789" comes
/// out as 0xCBF43926 (or its inverse). If not, batches go as plain JSON.
function __glitchless_gzip_works() {
    global.__glitchless_crc_inverted = false;
    try {
        if (os_browser != browser_not_a_browser) return false; // a web build sends strings
        var _b = buffer_create(9, buffer_fixed, 1);
        buffer_write(_b, buffer_text, "123456789");
        var _c = buffer_crc32(_b, 0, 9);
        buffer_delete(_b);
        if (_c < 0) _c += 4294967296;
        if (_c == 3421780262) return true;
        if (_c == 4294967295 - 3421780262) {
            global.__glitchless_crc_inverted = true;
            return true;
        }
    } catch (_e) {}
    return false;
}

// ───────────────────────────── saved batches ─────────────────────────────

/// Batches that have not been sent are saved, so a game played offline sends when the network is back.
/// In anonymous mode they are saved without the session ID; on the next launch each earlier session's
/// batches go under a new random ID, so nothing written to the device ties two sessions together.
function __glitchless_save_outbox(_g) {
    if (!_g.enabled) return;
    var _out = [];
    for (var _i = 0; _i < array_length(_g.outbox); _i++) {
        var _b = _g.outbox[_i];
        var _saved = { service: _b.service, env: _b.env, version: _b.version, group: _b.group, events: _b.events };
        if (_g.keeps_ids) {
            _saved.sid = _b.sid;
            _saved.pid = _b.pid;
        }
        array_push(_out, _saved);
    }
    if (array_length(_out) == 0) {
        if (file_exists(__GLITCHLESS_OUTBOX)) file_delete(__GLITCHLESS_OUTBOX);
        return;
    }
    var _tmp = __GLITCHLESS_OUTBOX + ".tmp";
    __glitchless_write_text(_tmp, json_stringify({ v: 1, batches: _out }));
    if (file_exists(__GLITCHLESS_OUTBOX)) file_delete(__GLITCHLESS_OUTBOX);
    file_rename(_tmp, __GLITCHLESS_OUTBOX);
}

function __glitchless_load_outbox(_g) {
    var _path = file_exists(__GLITCHLESS_OUTBOX) ? __GLITCHLESS_OUTBOX : __GLITCHLESS_OUTBOX + ".tmp"; // a save cut off between its two steps
    var _text = __glitchless_read_text(_path);
    if (_text == "") return;
    var _data = undefined;
    try {
        _data = json_parse(_text);
    } catch (_e) {
        return;
    }
    if (!is_struct(_data) || !is_array(_data[$ "batches"])) return;
    var _oldest = __glitchless_now(_g) - __GLITCHLESS_MAX_OUTBOX_AGE_MS;
    var _fresh_ids = {};
    var _batches = _data.batches;
    for (var _i = 0; _i < array_length(_batches); _i++) {
        var _saved = _batches[_i];
        if (!is_struct(_saved) || !is_array(_saved[$ "events"])) continue;
        var _events = [];
        for (var _j = 0; _j < array_length(_saved.events); _j++) {
            var _e = _saved.events[_j];
            if (is_struct(_e) && !is_undefined(_e[$ "ts"]) && _e.ts >= _oldest) array_push(_events, _e);
        }
        if (array_length(_events) == 0) continue;
        var _group = string(_saved[$ "group"]);
        var _sid = is_string(_saved[$ "sid"]) ? _saved.sid : "";
        if (_sid == "") {
            if (is_undefined(_fresh_ids[$ _group])) _fresh_ids[$ _group] = __glitchless_new_id("s_", 16);
            _sid = _fresh_ids[$ _group];
        }
        array_push(_g.outbox, {
            bid: _g.next_bid,
            service: is_string(_saved[$ "service"]) ? _saved.service : _g.service,
            env: is_string(_saved[$ "env"]) ? _saved.env : _g.env,
            version: is_string(_saved[$ "version"]) ? _saved.version : _g.version,
            sid: _sid,
            pid: _g.keeps_ids && is_string(_saved[$ "pid"]) ? _saved.pid : "",
            group: _group,
            events: _events,
            direct: false
        });
        _g.next_bid += 1;
    }
    __glitchless_log(_g, string(array_length(_g.outbox)) + " saved batches from earlier launches");
}

function __glitchless_load_player_id() {
    var _saved = __glitchless_trim(__glitchless_read_text("glitchless/player_id"));
    if (string_copy(_saved, 1, 2) == "p_") return _saved;
    var _id = __glitchless_new_id("p_", 12);
    __glitchless_write_text("glitchless/player_id", _id);
    return _id;
}
