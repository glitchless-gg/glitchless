// Feather disable all
/// Glitchless: batches, sending and the outbox.
///
/// Events wait in a queue; every flush_interval seconds they become batches of at most ~60 KB in the
/// outbox, which is saved to glitchless/outbox.json in the game's save area. One batch is in flight at a
/// time, through http_request; its reply comes to obj_glitchless's Async HTTP event. A batch leaves the
/// outbox once the server has it (or turned it away for good), so a game played offline, or one that
/// crashed, sends on a later launch. Glitchless's other files in the save area are here too: the player ID,
/// the version that last ran, and the player's switch.

#macro __GLITCHLESS_BATCH_BYTES 60000
#macro __GLITCHLESS_MAX_OUTBOX_EVENTS 4000
#macro __GLITCHLESS_MAX_OUTBOX_AGE_MS 518400000 // 6 days: the server files anything over 7 days old under "now"
#macro __GLITCHLESS_OUTBOX "glitchless/outbox.json"
#macro __GLITCHLESS_CHOICE "glitchless/enabled" // the player's switch

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
        var _start = __glitchless_session_start_event(_g);
        _g.starts[$ string(_g.started_at)] = _start;
        array_insert(_g.queue, 0, _start);
        _g.session_start_sent = true;
    }
    // Once a launch, with the first batch after the first frame: a batch can go before it (the window lost focus
    // as the game opened), and the load would be lost if it only went with the session's start.
    if (_g.first_frame_ms > 0 && !_g.load_sent) {
        _g.load_sent = true;
        array_push(_g.queue, { type: "load", ts: _g.first_frame_at, level: _g.level, ttff_ms: _g.first_frame_ms, assets: undefined, first_launch: _g.first_launch });
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
    var _texts = []; // each event as JSON: measured here, and kept as the batch's events_json
    var _size = 0;
    for (var _i = 0; _i < array_length(_events); _i++) {
        var _e = _events[_i];
        var _text = json_stringify(_e);
        var _bytes = string_byte_length(_text);
        if (array_length(_chunk) > 0 && _size + _bytes > __GLITCHLESS_BATCH_BYTES * 0.9) {
            array_push(_g.outbox, __glitchless_batch(_g, _chunk, _texts));
            _chunk = [];
            _texts = [];
            _size = 0;
        }
        array_push(_chunk, _e);
        array_push(_texts, _text);
        _size += _bytes;
    }
    if (array_length(_chunk) > 0) array_push(_g.outbox, __glitchless_batch(_g, _chunk, _texts));
    var _total = 0;
    for (var _j = 0; _j < array_length(_g.outbox); _j++) _total += array_length(_g.outbox[_j].events);
    while (_total > __GLITCHLESS_MAX_OUTBOX_EVENTS && array_length(_g.outbox) > 1 && _g.outbox[0].bid != _g.in_flight) {
        _total -= array_length(_g.outbox[0].events);
        array_delete(_g.outbox, 0, 1);
    }
}

/// `batch_id` is the batch's own random ID (SPEC §2 batch_id). It goes with every try of the batch and is saved with
/// it, so the server stores a batch once however many times it is sent: after a reply that never came, or a launch
/// that sends what the last one saved (a crash's batches too). It names the batch, not the player or the session, so
/// anonymous mode saves it too. `bid` is only this launch's handle for it. The session ID goes into the hash: two
/// players' first batches, cut seconds into their sessions, must never share an ID (the server would drop one).
function __glitchless_batch(_g, _events, _texts = undefined) {
    var _b = { bid: _g.next_bid, batch_id: __glitchless_new_id("b_", 16, _g.session_id), service: _g.service, env: _g.env, version: _g.version, sid: _g.session_id, pid: _g.player_id, group: _g.started_at, events: _events, direct: false };
    if (is_array(_texts)) _b.events_json = "[" + string_join_ext(",", _texts) + "]";
    _g.next_bid += 1;
    return _b;
}

/// A batch's events as JSON, made once. A batch never changes once it's in the outbox, so saving the outbox again
/// (after every flush and every reply) and sending the batch reuse it: turning the whole outbox into JSON again, near
/// its cap offline, was most of a save.
function __glitchless_events_json(_b) {
    if (is_undefined(_b[$ "events_json"])) _b.events_json = json_stringify(_b.events);
    return _b.events_json;
}

/// _head as JSON, with one more field whose value is JSON already.
function __glitchless_json_with(_head, _key, _json) {
    var _text = json_stringify(_head);
    return string_copy(_text, 1, string_length(_text) - 1) + "," + json_stringify(_key) + ":" + _json + "}";
}

function __glitchless_body(_b) {
    return __glitchless_json_with({
        service: _b.service,
        env: _b.env,
        version: _b.version,
        session_id: _b.sid,
        player_id: _b.pid != "" ? _b.pid : undefined, // the server uses the session ID in its place
        sdk: GLITCHLESS_SDK,
        batch_id: _b.batch_id
    }, "events", __glitchless_events_json(_b));
}

function __glitchless_intake_url(_g) {
    return _g.intake + "/v1/intake?token=" + __glitchless_url_encode(_g.opts.client_token);
}

/// Sends one batch: gzipped in a buffer when the runner's zlib works, plain JSON otherwise. Content-Type
/// is text/plain, as the browser SDK sends it; the server knows gzip by its first two bytes.
function __glitchless_post(_g, _b) {
    var _json = __glitchless_body(_b);
    var _body = _json;
    var _buffer = -1;
    if (_g.gzip) {
        _buffer = __glitchless_gzip(_json);
        if (_buffer != -1) _body = _buffer;
    }
    if (_g.debug) __glitchless_log(_g, "sending " + string(array_length(_b.events)) + " events (" + string(string_byte_length(_json)) + " bytes" + (_buffer != -1 ? ", " + string(buffer_get_size(_buffer)) + " gzipped" : "") + ")");
    var _id = http_request(__glitchless_intake_url(_g), "POST", __glitchless_headers(_g), _body);
    return { id: _id, buffer: _buffer };
}

/// The one request header map every request uses, made the first time it is needed.
function __glitchless_headers(_g) {
    if (_g.headers == -1) {
        _g.headers = ds_map_create();
        ds_map_add(_g.headers, "Content-Type", "text/plain");
    }
    return _g.headers;
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

/// obj_glitchless's Async HTTP event, with async_load's id, status, http_status and result (the reply's body).
function __glitchless_on_http(_id, _status, _http_status, _result = "") {
    var _g = __glitchless();
    if (_status == 1) return; // still downloading the reply
    var _ignored = _g.ignored[$ string(_id)];
    if (!is_undefined(_ignored)) {
        // Sent before the player turned Glitchless off: what it carried is gone, so its answer changes nothing.
        variable_struct_remove(_g.ignored, string(_id));
        if (_ignored != -1) buffer_delete(_ignored);
        return;
    }
    if (_id == _g.health_id) {
        _g.health_id = -1;
        __glitchless_on_features(_g, _status == 0 && _http_status >= 200 && _http_status < 300, _result);
        return;
    }
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
/// batches go under a new random ID, so nothing written to the device ties two sessions together. Every
/// mode saves each batch's own ID, so a batch the server took just before the game closed is not stored
/// twice when the next launch sends it.
/// Anonymous mode also saves each of those sessions' session_start (it holds no ID): when its first batch
/// went out before the game closed or crashed (or the server stored it but its reply was lost), the next
/// launch sends it again first, marked continued, so the rest of the session, a crash included, still says
/// what device and kind of session it was (SPEC §2 session_start.continued).
function __glitchless_save_outbox(_g) {
    if (!_g.enabled) return;
    var _parts = ["{\"v\":1,\"batches\":["];
    var _bytes = 0;
    var _waiting = {}; // each group still waiting → its group as saved
    for (var _i = 0; _i < array_length(_g.outbox); _i++) {
        var _b = _g.outbox[_i];
        if (is_undefined(_b[$ "saved_json"])) { // made once too: the privacy mode is set once, at init
            var _saved = { batch_id: _b.batch_id, service: _b.service, env: _b.env, version: _b.version, group: _b.group };
            if (_g.keeps_ids) {
                _saved.sid = _b.sid;
                _saved.pid = _b.pid;
            }
            _b.saved_json = __glitchless_json_with(_saved, "events", __glitchless_events_json(_b));
            _b.saved_bytes = string_byte_length(_b.saved_json);
        }
        if (_i > 0) array_push(_parts, ",");
        array_push(_parts, _b.saved_json);
        _bytes += _b.saved_bytes + 1;
        _waiting[$ string(_b.group)] = _b.group;
    }
    // Only the starts of the sessions still waiting, and this one's.
    var _groups = variable_struct_get_names(_g.starts);
    for (var _i = 0; _i < array_length(_groups); _i++) {
        if (is_undefined(_waiting[$ _groups[_i]]) && _groups[_i] != string(_g.started_at)) variable_struct_remove(_g.starts, _groups[_i]);
    }
    if (array_length(_g.outbox) == 0) {
        if (file_exists(__GLITCHLESS_OUTBOX)) file_delete(__GLITCHLESS_OUTBOX);
        return;
    }
    array_push(_parts, "]");
    if (!_g.keeps_ids) {
        var _starts = [];
        var _keys = variable_struct_get_names(_waiting);
        for (var _i = 0; _i < array_length(_keys); _i++) {
            var _start = _g.starts[$ _keys[_i]];
            if (!is_undefined(_start)) array_push(_starts, { group: _waiting[$ _keys[_i]], event: _start });
        }
        if (array_length(_starts) > 0) array_push(_parts, ",\"starts\":" + json_stringify(_starts));
    }
    array_push(_parts, "}");
    // Written now, in the frame. GML has no threads, and buffer_save_async is no way out: the runner writes its file on
    // the main thread later in the same frame, and takes as long (gamemaker/README.md, "What it costs").
    var _tmp = __GLITCHLESS_OUTBOX + ".tmp";
    __glitchless_write_parts(_tmp, _parts, _bytes);
    if (file_exists(__GLITCHLESS_OUTBOX)) file_delete(__GLITCHLESS_OUTBOX);
    file_rename(_tmp, __GLITCHLESS_OUTBOX);
}

/// The outbox on the device, deleted unread: the player turned Glitchless off (SPEC §4d), bug reports in it included.
function __glitchless_delete_outbox() {
    if (file_exists(__GLITCHLESS_OUTBOX)) file_delete(__GLITCHLESS_OUTBOX);
    if (file_exists(__GLITCHLESS_OUTBOX + ".tmp")) file_delete(__GLITCHLESS_OUTBOX + ".tmp");
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
    // Each earlier session's session_start, from its saved batches or saved beside them. One saved beside them
    // goes again first, marked continued: the session's first batch had gone.
    var _start_of = {};
    var _in_batches = {};
    var _saved_starts = _data[$ "starts"];
    if (is_array(_saved_starts)) {
        for (var _i = 0; _i < array_length(_saved_starts); _i++) {
            var _s = _saved_starts[_i];
            if (is_struct(_s) && __glitchless_is_start(_s[$ "event"], _oldest)) _start_of[$ string(_s[$ "group"])] = _s.event;
        }
    }
    for (var _i = 0; _i < array_length(_batches); _i++) {
        var _saved = _batches[_i];
        if (!is_struct(_saved) || !is_array(_saved[$ "events"])) continue;
        for (var _j = 0; _j < array_length(_saved.events); _j++) {
            if (__glitchless_is_start(_saved.events[_j], _oldest)) {
                _start_of[$ string(_saved[$ "group"])] = _saved.events[_j];
                _in_batches[$ string(_saved[$ "group"])] = true;
            }
        }
    }
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
            if (is_undefined(_fresh_ids[$ _group])) {
                _fresh_ids[$ _group] = __glitchless_new_id("s_", 16);
                var _start = _start_of[$ _group];
                if (!is_undefined(_start)) {
                    if (is_undefined(_in_batches[$ _group])) {
                        _start.continued = true;
                        array_push(_g.outbox, {
                            bid: _g.next_bid,
                            batch_id: __glitchless_new_id("b_", 16),
                            service: is_string(_saved[$ "service"]) ? _saved.service : _g.service,
                            env: is_string(_saved[$ "env"]) ? _saved.env : _g.env,
                            version: is_string(_saved[$ "version"]) ? _saved.version : _g.version,
                            sid: _fresh_ids[$ _group],
                            pid: "",
                            group: _group,
                            events: [_start],
                            direct: false
                        });
                        _g.next_bid += 1;
                    }
                    // Kept for this launch's saves too: it may send the session's first batch and not the rest.
                    _g.starts[$ _group] = _start;
                }
            }
            _sid = _fresh_ids[$ _group];
        }
        var _batch_id = is_string(_saved[$ "batch_id"]) ? _saved.batch_id : "";
        array_push(_g.outbox, {
            bid: _g.next_bid,
            batch_id: string_copy(_batch_id, 1, 2) == "b_" ? _batch_id : __glitchless_new_id("b_", 16), // saved before batch IDs: a new one
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

function __glitchless_is_start(_e, _oldest) {
    return is_struct(_e) && is_string(_e[$ "type"]) && _e.type == "session_start" && is_numeric(_e[$ "ts"]) && _e.ts >= _oldest;
}

/// Whether this is the first launch of this game version on this device. The first after an install or an update
/// starts cold (empty texture and file caches), which shows in the time to the first frame. The file holds only the
/// version, the same on every player's device, so it ties no two sessions together.
function __glitchless_note_launch(_g) {
    var _last = __glitchless_trim(__glitchless_read_text("glitchless/launched"));
    if (_last == _g.version) return false;
    __glitchless_write_text("glitchless/launched", _g.version);
    return true;
}

/// The player's switch (SPEC §4d): "on" or "off" in glitchless/enabled, written once the game has called
/// glitchless_set_enabled, in every privacy mode. It holds nothing else, the same on every device that made the same
/// choice, so it ties nothing to anyone. true, false, or undefined while there is none.
function __glitchless_load_choice() {
    var _saved = __glitchless_trim(__glitchless_read_text(__GLITCHLESS_CHOICE));
    if (_saved == "on") return true;
    if (_saved == "off") return false;
    return undefined;
}

function __glitchless_save_choice(_on) {
    directory_create("glitchless");
    __glitchless_write_text(__GLITCHLESS_CHOICE, _on ? "on" : "off");
}

function __glitchless_load_player_id() {
    var _saved = __glitchless_trim(__glitchless_read_text("glitchless/player_id"));
    if (string_copy(_saved, 1, 2) == "p_") return _saved;
    var _id = __glitchless_new_id("p_", 12);
    __glitchless_write_text("glitchless/player_id", _id);
    return _id;
}
