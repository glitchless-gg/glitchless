// Feather disable all
/// Glitchless: text the server must read the same way from every SDK.
///
/// The error fingerprint (packages/sdk/src/fingerprint.js), the scrubbing of paths on the
/// player's computer out of error text, callstack frames, which rooms read as levels, random IDs
/// and rounding. GML has no regular expressions, so each pattern the other SDKs write as a regex
/// is spelled out here character by character. gamemaker/test/core.test.mjs runs these functions
/// against the JavaScript originals.

/// Rounds to `_step` (0.1, 0.01...) the way the browser SDK's Math.round(v / step) * step does.
/// GML's round() goes to the even neighbour at .5; this always goes up, as JavaScript does.
function __glitchless_round(_v, _step) {
    if (is_undefined(_v)) return undefined;
    var _m = 1 / _step;
    return floor(_v * _m + 0.5) / _m;
}

/// The browser SDK's error grouping key: the kind, the message with long numbers and hex addresses
/// blanked out, and the function it came from, hashed with 32-bit FNV-1a over UTF-16 code units
/// (JavaScript's charCodeAt), as 8 hex digits.
function __glitchless_fingerprint(_kind, _message, _fn) {
    var _h = 2166136261; // 0x811c9dc5
    _h = __glitchless_fnv(_h, _kind + "|", infinity);
    _h = __glitchless_fnv(_h, __glitchless_normalize_message(_message), 200); // .slice(0, 200)
    _h = __glitchless_fnv(_h, "|" + _fn, infinity);
    return __glitchless_hex8(_h);
}

/// Hashes the first `_max_units` UTF-16 code units of `_s` into `_h`. A character past U+FFFF is
/// two code units in JavaScript, so it is hashed as its surrogate pair.
function __glitchless_fnv(_h, _s, _max_units) {
    var _len = string_length(_s);
    var _units = 0;
    for (var _i = 1; _i <= _len && _units < _max_units; _i++) {
        var _c = string_ord_at(_s, _i);
        if (_c > 65535) {
            _c -= 65536;
            _h = __glitchless_fnv_unit(_h, 55296 + floor(_c / 1024)); // 0xD800
            _units++;
            if (_units < _max_units) {
                _h = __glitchless_fnv_unit(_h, 56320 + (_c % 1024)); // 0xDC00
                _units++;
            }
        } else {
            _h = __glitchless_fnv_unit(_h, _c);
            _units++;
        }
    }
    return _h;
}

/// One FNV-1a step: h = (h xor unit) * 16777619 mod 2^32. The multiply is done as
/// h * 403 + (h mod 256) * 2^24 (16777619 = 2^24 + 403, and only h's low byte survives the
/// shift), which stays below 2^42 and so is exact in a double. The xor only touches the low
/// 16 bits, so it never sees a number past 2^16.
function __glitchless_fnv_unit(_h, _unit) {
    var _lo = _h % 65536;
    _h = (_h - _lo) + (_lo ^ _unit);
    return (_h * 403 + (_h % 256) * 16777216) % 4294967296;
}

function __glitchless_hex8(_h) {
    var _digits = "0123456789abcdef";
    var _out = "";
    for (var _i = 0; _i < 8; _i++) {
        _out = string_char_at(_digits, (_h % 16) + 1) + _out;
        _h = floor(_h / 16);
    }
    return _out;
}

/// msg.replace(/^Uncaught\s+/, '').replace(/\d{3,}/g, 'N').replace(/0x[0-9a-f]+/gi, 'X').
/// The 200-character cut is the hash's: __glitchless_fingerprint counts it in UTF-16 units.
function __glitchless_normalize_message(_msg) {
    var _s = string(_msg);
    // ^Uncaught\s+
    if (string_copy(_s, 1, 8) == "Uncaught") {
        var _n = string_length(_s);
        var _j = 9;
        while (_j <= _n && __glitchless_is_space(string_ord_at(_s, _j))) _j++;
        if (_j > 9) _s = string_copy(_s, _j, _n - _j + 1);
    }
    // \d{3,} -> N
    var _out = "";
    var _run = "";
    var _len = string_length(_s);
    for (var _i = 1; _i <= _len; _i++) {
        var _ch = string_char_at(_s, _i);
        var _o = ord(_ch);
        if (_o >= 48 && _o <= 57) {
            _run += _ch;
        } else {
            _out += string_length(_run) >= 3 ? "N" : _run;
            _run = "";
            _out += _ch;
        }
    }
    _out += string_length(_run) >= 3 ? "N" : _run;
    // 0x[0-9a-f]+ -> X, either case
    _s = _out;
    _out = "";
    _len = string_length(_s);
    var _k = 1;
    while (_k <= _len) {
        var _c0 = string_char_at(_s, _k);
        if (_c0 == "0" && _k + 2 <= _len && string_lower(string_char_at(_s, _k + 1)) == "x" && __glitchless_is_hex(string_char_at(_s, _k + 2))) {
            var _e = _k + 2;
            while (_e <= _len && __glitchless_is_hex(string_char_at(_s, _e))) _e++;
            _out += "X";
            _k = _e;
        } else {
            _out += _c0;
            _k++;
        }
    }
    return _out;
}

function __glitchless_is_hex(_ch) {
    var _o = ord(string_lower(_ch));
    return (_o >= 48 && _o <= 57) || (_o >= 97 && _o <= 102);
}

/// JavaScript's \s, for the characters an error message holds.
function __glitchless_is_space(_o) {
    return _o == 32 || (_o >= 9 && _o <= 13) || _o == 160 || _o == 65279 || _o == 8232 || _o == 8233 || (_o >= 8192 && _o <= 8202) || _o == 5760 || _o == 8239 || _o == 8287 || _o == 12288;
}

/// Error text can hold paths on the player's computer, and a path can hold their user name. The
/// game's save folder becomes "save:", and /Users/<name>, /home/<name> and C:\Users\<name> lose the
/// name, as in the other SDKs.
function __glitchless_scrub(_text, _save_dir) {
    var _s = string(_text);
    if (_save_dir != "") {
        _s = string_replace_all(_s, _save_dir, "save:/");
    }
    _s = __glitchless_scrub_after(_s, "/Users/", "~");
    _s = __glitchless_scrub_after(_s, "/home/", "~");
    _s = __glitchless_scrub_windows(_s);
    return _s;
}

/// Replaces the path segment after each `_prefix` (up to the next /, whitespace or quote) with `_with`.
function __glitchless_scrub_after(_s, _prefix, _with) {
    var _out = "";
    var _plen = string_length(_prefix);
    var _pos = string_pos(_prefix, _s);
    while (_pos > 0) {
        _out += string_copy(_s, 1, _pos + _plen - 1);
        _s = string_copy(_s, _pos + _plen, string_length(_s) - _pos - _plen + 1);
        var _len = string_length(_s);
        var _e = 1;
        while (_e <= _len && !__glitchless_ends_segment(string_char_at(_s, _e), false)) _e++;
        if (_e > 1) _out += _with;
        _s = string_copy(_s, _e, _len - _e + 1);
        _pos = string_pos(_prefix, _s);
    }
    return _out + _s;
}

/// ([A-Za-z]:[\\/]Users[\\/])[^\\/\s'"]+ -> $1~
function __glitchless_scrub_windows(_s) {
    if (string_pos(":\\Users", _s) == 0 && string_pos(":/Users", _s) == 0) return _s; // most text has no Windows path
    var _out = "";
    var _len = string_length(_s);
    var _i = 1;
    while (_i <= _len) {
        var _c = string_char_at(_s, _i);
        var _o = ord(_c);
        var _letter = (_o >= 65 && _o <= 90) || (_o >= 97 && _o <= 122);
        if (_letter && _i + 9 <= _len && string_char_at(_s, _i + 1) == ":" && __glitchless_is_slash(string_char_at(_s, _i + 2))
            && string_copy(_s, _i + 3, 5) == "Users" && __glitchless_is_slash(string_char_at(_s, _i + 8))) {
            _out += string_copy(_s, _i, 9);
            var _e = _i + 9;
            while (_e <= _len && !__glitchless_ends_segment(string_char_at(_s, _e), true)) _e++;
            if (_e > _i + 9) _out += "~";
            _i = _e;
        } else {
            _out += _c;
            _i++;
        }
    }
    return _out;
}

function __glitchless_is_slash(_c) {
    return _c == "/" || _c == "\\";
}

function __glitchless_ends_segment(_c, _backslash) {
    return _c == "/" || (_backslash && _c == "\\") || _c == "'" || _c == "\"" || __glitchless_is_space(ord(_c));
}

/// One line of a GameMaker callstack ("gml_Object_obj_player_Step_0 (line 12)", or
/// "gml_Script_spawn_wave:23" in some runtimes) as {fn, source, line, raw}. fn is what errors group
/// by: "obj_player.Step_0" for an object's event, the function's own name for a script function.
/// source is the asset the code lives in, where the name says which.
function __glitchless_parse_frame(_raw) {
    var _s = string(_raw);
    var _line = 0;
    var _name = _s;
    var _p = string_pos(" (line ", _s);
    if (_p > 0) {
        _name = string_copy(_s, 1, _p - 1);
        _line = __glitchless_to_int(string_copy(_s, _p + 7, string_length(_s) - _p - 7));
    } else {
        _p = string_last_pos(":", _s);
        if (_p > 0) {
            var _digits = string_copy(_s, _p + 1, string_length(_s) - _p);
            if (_digits != "" && string_digits(_digits) == _digits) {
                _name = string_copy(_s, 1, _p - 1);
                _line = real(_digits);
            }
        }
    }
    var _fn = _name;
    var _source = "";
    if (string_copy(_name, 1, 11) == "gml_Object_") {
        var _rest = string_copy(_name, 12, string_length(_name) - 11);
        var _cut = __glitchless_event_cut(_rest);
        if (_cut > 0) {
            _source = string_copy(_rest, 1, _cut - 1);
            _fn = _source + "." + string_copy(_rest, _cut + 1, string_length(_rest) - _cut);
        } else {
            _source = _rest;
            _fn = _rest;
        }
    } else if (string_copy(_name, 1, 11) == "gml_Script_") {
        _fn = string_copy(_name, 12, string_length(_name) - 11);
        var _at = string_pos("@", _fn); // anon@123@gml_Object_obj_demo_Create_0: a method made in that event
        if (_at > 0) {
            var _in = string_copy(_fn, string_last_pos("@", _fn) + 1, string_length(_fn));
            _fn = "anon in " + __glitchless_parse_frame(_in).fn;
        }
        _source = _fn;
    } else if (string_copy(_name, 1, 17) == "gml_GlobalScript_") {
        _source = string_copy(_name, 18, string_length(_name) - 17);
        _fn = _source;
    } else if (string_copy(_name, 1, 11) == "gml_RoomCC_") {
        _source = string_copy(_name, 12, string_length(_name) - 11);
        _fn = _source;
    }
    return { fn: _fn, source: _source, line: _line, raw: _name };
}

/// Where the object's name ends in "obj_player_Step_0": the underscore before the event's name. An
/// object's own name can hold underscores, so the event name is found from the right.
function __glitchless_event_cut(_rest) {
    var _events = ["Create", "Destroy", "CleanUp", "Step", "Alarm", "Draw", "Collision", "Keyboard", "KeyPress", "KeyRelease", "Mouse", "Other", "Gesture", "PreCreate"];
    var _best = 0;
    for (var _i = 0; _i < array_length(_events); _i++) {
        var _needle = "_" + _events[_i] + "_";
        var _p = string_last_pos(_needle, _rest);
        if (_p > _best) _best = _p;
    }
    return _best;
}

function __glitchless_to_int(_s) {
    var _d = string_digits(_s);
    return _d == "" ? 0 : real(_d);
}

/// Unreal's and Unity's check of whether a map or scene is a level: rooms named like a menu, a boot
/// or loading room, a title or a lobby are not ("rm_main_menu", "MainMenu", "room_title"). The room's
/// own name is the level otherwise.
function __glitchless_level_for_room(_name) {
    if (_name == "") return "";
    var _words = __glitchless_words(_name);
    var _not = ["boot", "bootstrap", "init", "startup", "preload", "preloader", "load", "loader", "loading", "splash", "intro", "title",
        "menu", "mainmenu", "ui", "hud", "overlay", "pause", "paused", "gameover", "settings", "options", "credits", "leaderboard",
        "shop", "empty", "entry", "frontend", "lobby", "transition"];
    var _n = array_length(_words);
    for (var _i = 0; _i < _n; _i++) {
        for (var _j = 0; _j < array_length(_not); _j++) {
            if (_words[_i] == _not[_j]) return "";
        }
        if (_i + 1 < _n && ((_words[_i] == "game" && _words[_i + 1] == "over") || (_words[_i] == "front" && _words[_i + 1] == "end"))) return "";
    }
    return _name;
}

/// "rmMainMenu" and "rm_main_menu" -> ["rm", "main", "menu"]: lower-case words, split at underscores,
/// dashes, dots, spaces and a lower-case letter or digit followed by a capital (and "HUDMenu" at "D|M").
function __glitchless_words(_name) {
    var _out = [];
    var _word = "";
    var _len = string_length(_name);
    for (var _i = 1; _i <= _len; _i++) {
        var _c = string_char_at(_name, _i);
        var _o = ord(_c);
        var _upper = _o >= 65 && _o <= 90;
        var _lower = _o >= 97 && _o <= 122;
        var _digit = _o >= 48 && _o <= 57;
        if (!(_upper || _lower || _digit)) {
            if (_word != "") array_push(_out, string_lower(_word));
            _word = "";
            continue;
        }
        if (_upper && _word != "") {
            var _prev = ord(string_char_at(_name, _i - 1));
            var _prev_lower_or_digit = (_prev >= 97 && _prev <= 122) || (_prev >= 48 && _prev <= 57);
            var _next = _i < _len ? ord(string_char_at(_name, _i + 1)) : 0;
            var _prev_upper = _prev >= 65 && _prev <= 90;
            if (_prev_lower_or_digit || (_prev_upper && _next >= 97 && _next <= 122)) {
                array_push(_out, string_lower(_word));
                _word = "";
            }
        }
        _word += _c;
    }
    if (_word != "") array_push(_out, string_lower(_word));
    return _out;
}

/// A random ID such as "s_k3f9…": `_length` characters from a SHA-1 of the clock, the time since
/// the game started and a counter. GameMaker's random() starts from the same seed in every run
/// unless the game calls randomize(), and Glitchless must not move the game's own random sequence,
/// so it never touches the random functions.
function __glitchless_new_id(_prefix, _length) {
    if (!variable_global_exists("__glitchless_ids")) global.__glitchless_ids = 0;
    global.__glitchless_ids += 1;
    var _count = global.__glitchless_ids;
    var _chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var _seed = string(date_current_datetime()) + "|" + string(get_timer()) + "|" + string(current_time) + "|" + string(_count) + "|" + string(display_mouse_get_x()) + "," + string(display_mouse_get_y());
    var _hex = sha1_string_utf8(_seed + "|" + game_save_id);
    _hex += sha1_string_utf8(_hex + _seed);
    var _out = _prefix;
    for (var _i = 0; _i < _length; _i++) {
        var _byte = __glitchless_hex_value(string_char_at(_hex, _i * 2 + 1)) * 16 + __glitchless_hex_value(string_char_at(_hex, _i * 2 + 2));
        _out += string_char_at(_chars, (_byte % 36) + 1);
    }
    return _out;
}

function __glitchless_hex_value(_ch) {
    var _o = ord(string_lower(_ch));
    return _o <= 57 ? _o - 48 : _o - 87;
}

/// The longest prefix of `_s` that fits in `_max` characters.
function __glitchless_cut(_s, _max) {
    return string_length(_s) > _max ? string_copy(_s, 1, _max) : _s;
}

function __glitchless_trim(_s) {
    var _len = string_length(_s);
    var _a = 1;
    while (_a <= _len && __glitchless_is_space(string_ord_at(_s, _a))) _a++;
    var _b = _len;
    while (_b >= _a && __glitchless_is_space(string_ord_at(_s, _b))) _b--;
    return string_copy(_s, _a, _b - _a + 1);
}

/// encodeURIComponent, for the client token in the intake URL.
function __glitchless_url_encode(_s) {
    var _safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    var _hex = "0123456789ABCDEF";
    var _out = "";
    var _buf = buffer_create(string_byte_length(_s) + 1, buffer_fixed, 1);
    buffer_write(_buf, buffer_string, _s);
    var _n = buffer_tell(_buf) - 1;
    for (var _i = 0; _i < _n; _i++) {
        var _b = buffer_peek(_buf, _i, buffer_u8);
        var _ch = chr(_b);
        if (_b < 128 && string_pos(_ch, _safe) > 0) {
            _out += _ch;
        } else {
            _out += "%" + string_char_at(_hex, floor(_b / 16) + 1) + string_char_at(_hex, (_b % 16) + 1);
        }
    }
    buffer_delete(_buf);
    return _out;
}
