// Feather disable all
/// Glitchless: what a game says about its play beyond levels and events, in the shape every SDK sends it
/// (docs/design/genre-coverage.md, A5 to A8):
///   - counters for streams of events (kills, gold, taps), added up on the device and sent once a window
///     as one `counts` event, so a stream never fills the queue;
///   - properties: the game's words about the session (rank tier, class, server region), checked here
///     before they go, so none can carry who the player is;
///   - groups (a match, a party, a run) and zones (where a player is in an open world), which every
///     event and frame window then carries, as it carries the level;
///   - network samples and disconnects, from the game's own ping around GameMaker's network_* functions.
///
/// The windows that hold counters and network samples are __glitchless_core's frame windows: they close
/// every flush_interval seconds, when a level starts, when a group changes and (after a second) a zone, so what they
/// counted keeps its level, zone and match.

#macro __GLITCHLESS_MAX_COUNT_ENTRIES 64 // entries a window: past it, a name's new groups go under "(other)"
#macro __GLITCHLESS_MAX_COUNT_ATTRS 4 // words and true/false that group a counter, and numbers it sums
#macro __GLITCHLESS_MAX_COUNT_N 1000000 // n a call
#macro __GLITCHLESS_TRACK_WARN_PER_S 20 // track() calls of one name a second that earn the count() warning
#macro __GLITCHLESS_MAX_PROPS 12 // property keys a session
#macro __GLITCHLESS_MAX_PROP_NUMBER 1000000
#macro __GLITCHLESS_NET_ALPHA 0.05 // the round-trip sketch's accuracy: the server merges ping percentiles to 5%
#macro __GLITCHLESS_NET_MIN_GAP_MS 500 // samples closer than this to the last are ignored (one a second is plenty)
#macro __GLITCHLESS_MAX_DISCONNECTS 20 // disconnect events a session
#macro __GLITCHLESS_MIN_ZONE_WINDOW_MS 1000 // a zone change closes the frame window only once it has run this long

/// Warns once per `_key`, in a build run from the IDE or with -glitchless-debug, about something the SDK dropped.
function __glitchless_warn(_g, _key, _msg) {
    if (!(_g.debug || GM_build_type == "run") || !is_undefined(_g.warned[$ _key])) return;
    _g.warned[$ _key] = true;
    show_debug_message("[glitchless] " + _msg);
}

/// What every event carries besides its own fields, as the browser SDK's push adds them: the level, and the zone
/// and the groups while they are set. Fields the event already has are kept.
function __glitchless_stamp(_g, _e) {
    if (!variable_struct_exists(_e, "level")) _e.level = _g.level;
    if (!is_undefined(_g.zone) && !variable_struct_exists(_e, "zone")) _e.zone = _g.zone;
    if (variable_struct_names_count(_g.groups) > 0) {
        var _kinds = variable_struct_get_names(_g.groups);
        for (var _i = 0; _i < array_length(_kinds); _i++) {
            if (!variable_struct_exists(_e, _kinds[_i])) _e[$ _kinds[_i]] = _g.groups[$ _kinds[_i]];
        }
    }
    return _e;
}

// ───────────────────────────── counters (A5) ─────────────────────────────

/// One more of a stream of events in this window. The call's words and true/false values (at most 4) say which
/// entry it adds to; its numbers (at most 4) are added up as given; `_n` adds to the entry's count.
function __glitchless_count(_name, _what, _n) {
    var _g = __glitchless();
    if (__glitchless_off(_g) || (!is_undefined(_g.counts_ok) && !_g.counts_ok)) return;
    if (!is_real(_n) && !is_int64(_n)) _n = 1;
    _n = min(floor(_n), __GLITCHLESS_MAX_COUNT_N);
    if (_n < 1) return;
    var _name_s = string(_name);
    var _attrs = {};
    if (is_struct(_what)) {
        _attrs = _what;
    } else if (!is_undefined(_what)) {
        _attrs = { what: _what };
    }
    var _keys = variable_struct_get_names(_attrs);
    array_sort(_keys, true);
    var _group = {};
    var _sums = {};
    var _groups = 0;
    var _summed = 0;
    var _key = _name_s;
    for (var _i = 0; _i < array_length(_keys); _i++) {
        var _k = _keys[_i];
        var _v = _attrs[$ _k];
        if (is_bool(_v)) {
            if (_groups >= __GLITCHLESS_MAX_COUNT_ATTRS) continue;
            _group[$ _k] = _v;
            _key += "\n" + _k + "=b" + (_v ? "1" : "0");
            _groups++;
        } else if (is_string(_v)) {
            if (_groups >= __GLITCHLESS_MAX_COUNT_ATTRS) continue;
            var _word = __glitchless_cut(_v, 64);
            _group[$ _k] = _word;
            _key += "\n" + _k + "=s" + _word;
            _groups++;
        } else if (is_real(_v) || is_int64(_v)) {
            if (_summed >= __GLITCHLESS_MAX_COUNT_ATTRS) continue;
            _sums[$ _k] = _v;
            _summed++;
        }
    }
    var _w = _g.win;
    var _entry = _w.counts[$ _key];
    if (is_undefined(_entry)) {
        if (array_length(_w.count_list) < __GLITCHLESS_MAX_COUNT_ENTRIES) {
            _entry = __glitchless_count_entry(_g, _w, _key, _name_s, _group);
            _w.count_names[$ _name_s] = true;
        } else if (is_undefined(_w.count_names[$ _name_s])) {
            _w.dropped += _n; // a new name in a full window
            return;
        } else {
            // a new group of a name already counted: its words become "(other)"
            var _other = _name_s + "\n(other)";
            _entry = _w.counts[$ _other];
            if (is_undefined(_entry)) {
                var _blank = {};
                var _gk = variable_struct_get_names(_group);
                for (var _j = 0; _j < array_length(_gk); _j++) _blank[$ _gk[_j]] = "(other)";
                _entry = __glitchless_count_entry(_g, _w, _other, _name_s, _blank);
            }
        }
    }
    _entry.n += _n;
    var _sk = variable_struct_get_names(_sums);
    for (var _s = 0; _s < array_length(_sk); _s++) {
        var _had = _entry.sums[$ _sk[_s]];
        if (!is_undefined(_had)) {
            _entry.sums[$ _sk[_s]] = _had + _sums[$ _sk[_s]];
        } else if (variable_struct_names_count(_entry.sums) < __GLITCHLESS_MAX_COUNT_ATTRS) {
            _entry.sums[$ _sk[_s]] = _sums[$ _sk[_s]];
        }
    }
}

function __glitchless_count_entry(_g, _w, _key, _name, _attrs) {
    var _entry = { name: _name, attrs: _attrs, n: 0, sums: {}, first_ts: __glitchless_now(_g) };
    _w.counts[$ _key] = _entry;
    array_push(_w.count_list, _entry);
    return _entry;
}

/// The window's `counts` event, or undefined when it counted nothing.
function __glitchless_counts_event(_g, _w, _secs) {
    if (array_length(_w.count_list) == 0 && _w.dropped == 0) return undefined;
    var _list = [];
    for (var _i = 0; _i < array_length(_w.count_list); _i++) {
        var _c = _w.count_list[_i];
        var _out = { name: _c.name, attrs: _c.attrs, n: _c.n, first_ts: _c.first_ts };
        if (variable_struct_names_count(_c.sums) > 0) _out.sums = _c.sums;
        array_push(_list, _out);
    }
    return { type: "counts", ts: _w.started_at > 0 ? _w.started_at : __glitchless_now(_g), level: _g.level, duration_s: __glitchless_round(_secs, 0.01), dropped: _w.dropped, counts: _list };
}

/// A debug build warns once about a name sent with track() more than 20 times a second: a stream belongs in
/// glitchless_count, or it fills the queue and pushes out frame windows.
function __glitchless_check_track_rate(_g, _name) {
    if (!(_g.debug || GM_build_type == "run")) return;
    var _sec = floor(current_time / 1000);
    var _r = _g.track_rate[$ _name];
    if (is_undefined(_r)) {
        _g.track_rate[$ _name] = { sec: _sec, n: 1 };
        return;
    }
    if (_r.sec != _sec) {
        _r.sec = _sec;
        _r.n = 0;
    }
    _r.n += 1;
    if (_r.n > __GLITCHLESS_TRACK_WARN_PER_S) __glitchless_warn(_g, "track:" + _name, "\"" + _name + "\" is tracked more than " + string(__GLITCHLESS_TRACK_WARN_PER_S) + " times a second: use glitchless_count(\"" + _name + "\", ...) for a stream like this, or it fills the queue");
}

/// What the server takes, from GET /v1/health's `features`, asked once a launch. An older server drops a `counts`
/// event, so against one that answers without "counts" the counters send nothing and say so once. No answer
/// (offline) leaves them on: a later launch may send them to a server that takes them.
function __glitchless_ask_features(_g) {
    if (!_g.enabled || _g.health_id != -1 || !is_undefined(_g.counts_ok) || !_g.sampled) return;
    var _id = http_request(_g.intake + "/v1/health", "GET", __glitchless_headers(_g), "");
    if (_id >= 0) _g.health_id = _id;
}

function __glitchless_on_features(_g, _ok, _result) {
    if (!_ok || !is_string(_result) || _result == "") return;
    var _data = undefined;
    try {
        _data = json_parse(_result);
    } catch (_e) {
        return;
    }
    if (!is_struct(_data)) return;
    var _f = _data[$ "features"];
    var _counts = false;
    if (is_array(_f)) {
        _counts = __glitchless_has(_f, "counts");
    } else if (is_struct(_f)) {
        var _c = _f[$ "counts"];
        _counts = !is_undefined(_c) && _c == true;
    }
    _g.counts_ok = _counts;
    if (_counts) return;
    show_debug_message("[glitchless] this Glitchless server does not take counters yet: glitchless_count sends nothing until it is updated");
    var _kept = [];
    for (var _i = 0; _i < array_length(_g.queue); _i++) {
        if (_g.queue[_i].type != "counts") array_push(_kept, _g.queue[_i]);
    }
    _g.queue = _kept;
    _g.win.counts = {};
    _g.win.count_list = [];
    _g.win.count_names = {};
    _g.win.dropped = 0;
}

// ───────────────────────────── properties (A6) ─────────────────────────────

/// Sets or (with undefined) removes properties of the session. Each is checked: a key or value that breaks the rules
/// is dropped with a warning in a debug build. They are kept in memory only, never on the device.
function __glitchless_set_properties(_props) {
    var _g = __glitchless();
    if (!is_struct(_props)) return;
    var _keys = variable_struct_get_names(_props);
    array_sort(_keys, true);
    var _changed = false;
    for (var _i = 0; _i < array_length(_keys); _i++) {
        var _k = _keys[_i];
        var _v = _props[$ _k];
        if (is_string(_v)) _v = __glitchless_cut(__glitchless_trim(_v), 64);
        var _why = __glitchless_prop_problem(_k, _v);
        if (_why != "") {
            __glitchless_warn(_g, "prop:" + _k, "property \"" + _k + "\" dropped: " + _why);
            continue;
        }
        if (is_undefined(_v)) {
            if (variable_struct_exists(_g.props, _k)) {
                variable_struct_remove(_g.props, _k);
                _changed = true;
            }
            continue;
        }
        if (is_undefined(_g.prop_keys[$ _k])) {
            if (variable_struct_names_count(_g.prop_keys) >= __GLITCHLESS_MAX_PROPS) {
                __glitchless_warn(_g, "prop:" + _k, "property \"" + _k + "\" dropped: a session has at most " + string(__GLITCHLESS_MAX_PROPS) + " properties");
                continue;
            }
            _g.prop_keys[$ _k] = true;
        }
        if (!__glitchless_same(_g.props[$ _k], _v)) {
            _g.props[$ _k] = _v;
            _changed = true;
        }
    }
    if (_changed) _g.props_at = __glitchless_now(_g);
}

/// Whether two property values are the same value of the same kind (GML's == takes true for 1).
function __glitchless_same(_a, _b) {
    if (is_undefined(_a) || is_undefined(_b)) return is_undefined(_a) && is_undefined(_b);
    if (is_bool(_a) != is_bool(_b) || is_string(_a) != is_string(_b)) return false;
    return _a == _b;
}

/// The `props` event for the keys that changed since the server last heard (undefined, sent as null, for a key
/// removed), or undefined when nothing did. At most one a window, with each key's last value.
function __glitchless_props_event(_g) {
    var _diff = {};
    var _any = false;
    var _now = variable_struct_get_names(_g.props);
    for (var _i = 0; _i < array_length(_now); _i++) {
        var _k = _now[_i];
        if (!__glitchless_same(_g.props_sent[$ _k], _g.props[$ _k])) {
            _diff[$ _k] = _g.props[$ _k];
            _any = true;
        }
    }
    var _was = variable_struct_get_names(_g.props_sent);
    for (var _j = 0; _j < array_length(_was); _j++) {
        if (!variable_struct_exists(_g.props, _was[_j])) {
            _diff[$ _was[_j]] = undefined;
            _any = true;
        }
    }
    if (!_any) return undefined;
    _g.props_sent = __glitchless_copy(_g.props);
    return { type: "props", ts: _g.props_at > 0 ? _g.props_at : __glitchless_now(_g), props: _diff };
}

/// Why a property can't be sent, or "". Keys: a lower-case letter, then up to 31 letters, digits or underscores; not
/// a built-in split or filter, and not a name for who the player is. Values: a word (up to 64 characters), true or
/// false, or a whole number from -1,000,000 to 1,000,000; never something shaped like an email address, a link, a
/// phone number, an ID or a key.
function __glitchless_prop_problem(_k, _v) {
    var _len = string_length(_k);
    if (_len < 1 || _len > 32) return "keys are 1 to 32 characters";
    for (var _i = 1; _i <= _len; _i++) {
        var _o = ord(string_char_at(_k, _i));
        var _letter = _o >= 97 && _o <= 122;
        if (_i == 1 && !_letter) return "keys start with a lower-case letter";
        if (!_letter && !(_o >= 48 && _o <= 57) && _o != 95) return "keys are lower-case letters, digits and _";
    }
    var _reserved = ["version", "level", "zone", "match", "party", "run", "env", "platform", "browser", "device_tier", "session_type", "privacy", "role", "link", "type", "players", "sessions", "hours",
        "steam_build", "steam_branch", "steam_hardware", "steam_deck", "steam_controller", "steam_language", "proton", "big_picture", "family_shared", "timed_trial"];
    if (__glitchless_has(_reserved, _k)) return "\"" + _k + "\" is one of Glitchless's own splits";
    var _identifying = ["name", "username", "user", "email", "phone", "user_id", "account", "account_id", "player_id", "steam_id", "epic_id", "psn_id", "xbox_id", "ip", "address",
        "device_id", "idfa", "gaid", "ad_id", "location", "lat", "lon", "city", "birthday", "age", "gender"];
    if (__glitchless_has(_identifying, _k)) return "\"" + _k + "\" would say who the player is";
    if (is_undefined(_v) || is_bool(_v)) return "";
    if (is_real(_v) || is_int64(_v)) {
        if (_v != floor(_v)) return "numbers are whole (send a band such as \"30-39\")";
        if (abs(_v) > __GLITCHLESS_MAX_PROP_NUMBER) return "numbers are from -1,000,000 to 1,000,000";
        return "";
    }
    if (!is_string(_v)) return "values are a word, a whole number, or true or false";
    if (_v == "") return "the value is empty";
    return __glitchless_identifying(_v);
}

/// Why a word looks like it says who someone is, or "": an email address, a link, a phone number or 7 digits in a
/// row, a UUID, or 16 characters of hex or base64 in a row (base64 with a letter and a digit, so a long word passes).
function __glitchless_identifying(_s) {
    var _len = string_length(_s);
    var _at = string_pos("@", _s);
    if (_at > 1 && string_pos(".", string_copy(_s, _at + 2, _len)) > 0 && string_char_at(_s, _len) != ".") return "it looks like an email address";
    var _lower = string_lower(_s);
    if (string_pos("://", _lower) > 0 || string_copy(_lower, 1, 4) == "www.") return "it looks like a link";
    var _run = 0; // digits in a row
    var _digits = 0; // digits in all
    var _parts = 0; // runs of digits
    var _phone = true; // only digits and what phone numbers are written with
    var _b64 = 0; // base64 characters in a row
    var _b64_digit = false;
    var _b64_letter = false;
    var _hex = 0; // hex digits in a row
    for (var _i = 1; _i <= _len; _i++) {
        var _c = string_char_at(_s, _i);
        var _o = ord(_c);
        var _digit = _o >= 48 && _o <= 57;
        var _letter = (_o >= 65 && _o <= 90) || (_o >= 97 && _o <= 122);
        _run = _digit ? _run + 1 : 0;
        if (_run >= 7) return "it looks like a phone number or an ID";
        if (_run == 1) _parts++;
        if (_digit) _digits++;
        if (!_digit && _c != " " && _c != "+" && _c != "-" && _c != "(" && _c != ")" && _c != ".") _phone = false;
        if (_digit || _letter || _c == "+" || _c == "/" || _c == "=") {
            if (_b64 == 0) {
                _b64_digit = false;
                _b64_letter = false;
            }
            _b64++;
            _b64_digit = _b64_digit || _digit;
            _b64_letter = _b64_letter || _letter;
            if (_b64 >= 16 && _b64_digit && _b64_letter) return "it looks like a key or an ID";
        } else {
            _b64 = 0;
        }
        _hex = __glitchless_is_hex(_c) ? _hex + 1 : 0;
        if (_hex >= 16) return "it looks like a key or an ID";
        if (_i + 35 <= _len && __glitchless_is_uuid_at(_s, _i)) return "it looks like an ID";
    }
    // A band such as "3000-3499" is two runs of digits; a phone number is written in three or more, or after + or (.
    var _first = string_char_at(_s, 1);
    if (_phone && _digits >= 7 && (_parts >= 3 || _first == "+" || _first == "(")) return "it looks like a phone number";
    return "";
}

/// Whether a UUID (8-4-4-4-12 hex digits) starts at character `_at`.
function __glitchless_is_uuid_at(_s, _at) {
    for (var _i = 0; _i < 36; _i++) {
        var _c = string_char_at(_s, _at + _i);
        if (_i == 8 || _i == 13 || _i == 18 || _i == 23) {
            if (_c != "-") return false;
        } else if (!__glitchless_is_hex(_c)) {
            return false;
        }
    }
    return true;
}

// ───────────────────────────── groups and zones (A7) ─────────────────────────────

/// Sets a group, which every event carries from then on, or (`_id` undefined) ends it. Match and party IDs come from
/// the game's servers and are hashed before they go, unless hash_group_ids is false; a run's ID is made here, and a
/// run the game saved resumes under its ID in install and full mode only. Returns the ID sent ("" for none).
function __glitchless_set_group(_kind, _id, _attrs) {
    var _g = __glitchless();
    var _k = string(_kind);
    if (_k != "match" && _k != "party" && _k != "run") {
        __glitchless_warn(_g, "group:" + _k, "group kind \"" + _k + "\" dropped: groups are \"match\", \"party\" and \"run\"");
        return "";
    }
    if (is_undefined(_id)) {
        if (is_undefined(_g.groups[$ _k])) return "";
        __glitchless_close_window(_g, false); // so a frame window never spans two matches
        variable_struct_remove(_g.groups, _k);
        variable_struct_remove(_g.group_attrs, _k);
        var _end = { type: "group", kind: _k };
        _end[$ "id"] = undefined; // `id` is also every instance's built-in variable: the accessor keeps it a field
        __glitchless_push(_g, _end);
        return "";
    }
    var _raw = string(_id);
    var _resumed = false;
    var _sent = "";
    if (_k == "run" && _raw == "") {
        _sent = __glitchless_new_id("r_", 12);
    } else if (!__glitchless_group_id_ok(_raw)) {
        __glitchless_warn(_g, "group-id:" + _k, "a " + _k + " ID was dropped: IDs are 8 to 64 letters, digits and _ . : -");
        return "";
    } else if (_k == "run") {
        _resumed = true;
        _sent = _g.keeps_ids ? _raw : __glitchless_new_id("r_", 12); // anonymous mode: nothing ties two launches together
    } else {
        _sent = _g.opts.hash_group_ids == true ? __glitchless_hash_group_id(_g, _raw) : _raw;
    }
    var _has_attrs = is_struct(_attrs) && variable_struct_names_count(_attrs) > 0;
    if (!is_undefined(_g.groups[$ _k]) && _g.groups[$ _k] == _sent && !_has_attrs && !_resumed) return _sent;
    __glitchless_close_window(_g, false);
    _g.groups[$ _k] = _sent;
    _g.group_attrs[$ _k] = _has_attrs ? _attrs : undefined;
    __glitchless_push(_g, __glitchless_group_event(_k, _sent, _g.group_attrs[$ _k], _resumed));
    __glitchless_remember(_g, _k);
    return _sent;
}

function __glitchless_group_event(_kind, _id, _attrs, _resumed) {
    var _e = { type: "group", kind: _kind };
    _e[$ "id"] = _id;
    if (!is_undefined(_attrs)) _e.attrs = _attrs;
    if (_resumed) _e.resumed = true;
    return _e;
}

/// A new session in the same launch starts in the groups still set: each goes again, so the server knows it.
function __glitchless_resend_groups(_g) {
    var _kinds = variable_struct_get_names(_g.groups);
    for (var _i = 0; _i < array_length(_kinds); _i++) {
        __glitchless_push(_g, __glitchless_group_event(_kinds[_i], _g.groups[$ _kinds[_i]], _g.group_attrs[$ _kinds[_i]], false));
    }
}

/// 8 to 64 characters of letters, digits and _ . : -
function __glitchless_group_id_ok(_s) {
    var _len = string_length(_s);
    if (_len < 8 || _len > 64) return false;
    for (var _i = 1; _i <= _len; _i++) {
        var _o = ord(string_char_at(_s, _i));
        if (!((_o >= 48 && _o <= 57) || (_o >= 65 && _o <= 90) || (_o >= 97 && _o <= 122) || _o == 95 || _o == 46 || _o == 58 || _o == 45)) return false;
    }
    return true;
}

/// "h_" and the first 24 hex digits of SHA-1(service + ":" + id): the same for every player in the match (and in
/// every Glitchless SDK), but not the ID in the game's own match logs. The service is the salt.
function __glitchless_hash_group_id(_g, _raw) {
    return "h_" + string_copy(string_lower(sha1_string_utf8(_g.service + ":" + _raw)), 1, 24);
}

/// Where the player is in an open world, which every event and frame window carries from then on; "" or
/// undefined: nowhere in particular. A change closes the frame window, as a level start does, once the window has
/// run a second: a player stepping back and forth over a zone's edge would otherwise fill the queue with windows.
function __glitchless_set_zone(_zone) {
    var _g = __glitchless();
    var _z = is_undefined(_zone) ? "" : __glitchless_cut(string(_zone), 64);
    var _was = is_undefined(_g.zone) ? "" : _g.zone;
    if (_z == _was) return;
    if (current_time - _g.win.started_ms >= __GLITCHLESS_MIN_ZONE_WINDOW_MS) __glitchless_close_window(_g, false);
    _g.zone = _z == "" ? undefined : _z;
}

// ───────────────────────────── network (A8) ─────────────────────────────

/// One round trip the game measured (and its packet loss and jitter, where it knows them). The first sample after
/// a disconnect starts a new connection.
function __glitchless_net_sample(_rtt_ms, _loss_pct, _jitter_ms) {
    var _g = __glitchless();
    if (__glitchless_off(_g) || !(is_real(_rtt_ms) || is_int64(_rtt_ms)) || _rtt_ms < 0) return;
    if (_g.net_connected && current_time - _g.net_last_sample < __GLITCHLESS_NET_MIN_GAP_MS) return;
    _g.net_last_sample = current_time;
    if (!_g.net_connected) {
        _g.net_connected = true;
        _g.net_since = current_time;
        _g.net_last_rtt = undefined;
    }
    var _n = _g.win.net;
    if (is_undefined(_n)) {
        _n = { sketch: __glitchless_sketch_new(__GLITCHLESS_NET_ALPHA), samples: 0, mx: 0, loss: 0, loss_n: 0, jitter: 0, jitter_n: 0, diff: 0, diff_n: 0 };
        _g.win.net = _n;
    }
    __glitchless_sketch_add(_n.sketch, _rtt_ms);
    _n.samples += 1;
    _n.mx = max(_n.mx, _rtt_ms);
    if (!is_undefined(_g.net_last_rtt)) {
        _n.diff += abs(_rtt_ms - _g.net_last_rtt);
        _n.diff_n += 1;
    }
    _g.net_last_rtt = _rtt_ms;
    if ((is_real(_loss_pct) || is_int64(_loss_pct)) && _loss_pct >= 0) {
        _n.loss += min(_loss_pct, 100);
        _n.loss_n += 1;
    }
    if ((is_real(_jitter_ms) || is_int64(_jitter_ms)) && _jitter_ms >= 0) {
        _n.jitter += _jitter_ms;
        _n.jitter_n += 1;
    }
}

/// A frame window's `net`. Jitter is the game's, or else how much one round trip differs from the one before.
/// GameMaker can't read throughput or the kind of connection, and only clients sample (a listen server's host has
/// no round trip of its own), so those are null and host is false.
function __glitchless_net_json(_g, _n) {
    var _jitter = undefined;
    if (_n.jitter_n > 0) {
        _jitter = __glitchless_round(_n.jitter / _n.jitter_n, 0.1);
    } else if (_n.diff_n > 0) {
        _jitter = __glitchless_round(_n.diff / _n.diff_n, 0.1);
    }
    return {
        rtt: __glitchless_sketch_json(_n.sketch),
        rtt_p50: __glitchless_round(__glitchless_sketch_quantile(_n.sketch, 0.5), 0.1),
        rtt_p95: __glitchless_round(__glitchless_sketch_quantile(_n.sketch, 0.95), 0.1),
        rtt_max: __glitchless_round(_n.mx, 0.1),
        jitter_ms: _jitter,
        loss_pct: _n.loss_n > 0 ? __glitchless_round(_n.loss / _n.loss_n, 0.01) : undefined,
        in_kbps: undefined,
        out_kbps: undefined,
        samples: _n.samples,
        transport: _g.opts.net_transport,
        link: undefined,
        host: false
    };
}

/// The connection dropped. Sends a `disconnect` with the numbers of the window before it and, with a level open, the
/// level's abandon with reason "disconnect": never a fail.
function __glitchless_disconnect(_reason) {
    var _g = __glitchless();
    if (__glitchless_off(_g)) return;
    var _r = is_string(_reason) ? _reason : "other";
    if (!__glitchless_has(["timeout", "connection_lost", "kicked", "server_closed", "failed_to_connect", "other"], _r)) _r = "other";
    var _numbers = _g.net_last;
    if (!is_undefined(_g.win.net)) _numbers = __glitchless_net_json(_g, _g.win.net);
    var _connected = _g.net_connected ? __glitchless_round((current_time - _g.net_since) / 1000, 0.1) : 0;
    __glitchless_close_window(_g, false); // the window ends with the connection
    _g.net_connected = false;
    _g.net_last_rtt = undefined;
    _g.net_down_at = current_time;
    if (_g.disconnects < __GLITCHLESS_MAX_DISCONNECTS) {
        _g.disconnects += 1;
        __glitchless_push(_g, {
            type: "disconnect",
            reason: _r,
            connected_s: _connected,
            rtt_p95: is_undefined(_numbers) ? undefined : _numbers.rtt_p95,
            loss_pct: is_undefined(_numbers) ? undefined : _numbers.loss_pct
        });
        __glitchless_remember(_g, "disconnect:" + _r);
    }
    if (_g.level_open && !is_undefined(_g.level)) __glitchless_abandon(_g, _g.level, "disconnect");
}

/// Back on the same connection after a disconnect.
function __glitchless_reconnect() {
    var _g = __glitchless();
    if (__glitchless_off(_g) || _g.net_down_at == 0) return;
    __glitchless_push(_g, { type: "reconnect", after_s: __glitchless_round((current_time - _g.net_down_at) / 1000, 0.1) });
    __glitchless_remember(_g, "reconnect");
    _g.net_down_at = 0;
    _g.net_connected = true;
    _g.net_since = current_time;
    _g.net_last_sample = current_time;
}
