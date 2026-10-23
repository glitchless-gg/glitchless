// Feather disable all
/// Glitchless: what the SDK says about the device in session_start, and the runner's own counts.
///
/// Anonymous and install mode send only coarse facts that many players share: the OS, the runner
/// (VM or YYC), the screen size and refresh rate, and a GPU tier where the GPU's name is known. Full
/// mode adds the OS version and the GPU's name. GameMaker can't read the core count or the memory, so
/// device_tier is "unknown". A Steam Deck says so (steam_deck, and os "SteamOS"), as in the Unreal plugin.
/// PRIVACY.md beside the SDK lists every field; keep the two in step.

function __glitchless_device(_full) {
    var _gpu = __glitchless_gpu();
    var _deck = __glitchless_steam_deck();
    var _d = {
        browser: "GameMaker", // the runtime, in the field the dashboard groups by
        browser_version: GM_runtime_version,
        os: _deck.steam_deck && (_deck.steamos || _deck.env) ? "SteamOS" : __glitchless_os_name(),
        mobile: __glitchless_is_phone(),
        device_tier: "unknown",
        // a phone's or a handheld's GPU is "low" next to a desktop one
        gpu_tier: __glitchless_is_phone() || _deck.steam_deck ? "low" : __glitchless_gpu_tier(_gpu.renderer),
        renderer: code_is_compiled() ? "yyc" : "vm",
        driver: _gpu.driver,
        screen: [display_get_width(), display_get_height()],
        dpr: undefined,
        refresh_hz: __glitchless_refresh_rate(),
        steam_deck: _deck.steam_deck
    };
    if (_full) {
        _d.model = _deck.steam_deck ? _deck.model : undefined;
        _d.os_version = __glitchless_os_version();
        _d.gpu = _gpu.renderer != "" ? _gpu.renderer : undefined;
        _d.gpu_vendor = _gpu.vendor != "" ? _gpu.vendor : undefined;
        _d.cores = undefined;
        _d.memory_gb = undefined;
    }
    return _d;
}

function __glitchless_os_name() {
    switch (os_type) {
        case os_windows: return "Windows";
        case os_macosx: return "macOS";
        case os_linux: return "Linux";
        case os_ios: return "iOS";
        case os_tvos: return "tvOS";
        case os_android: return "Android";
        case os_gxgames: return "GX.games";
        case os_operagx: return "Opera GX";
        case os_switch: return "Switch";
        case os_ps4: return "PS4";
        case os_ps5: return "PS5";
        case os_xboxseriesxs: return "Xbox Series";
    }
    return "unknown";
}

function __glitchless_is_phone() {
    return os_type == os_ios || os_type == os_android;
}

/// "26.1.0" on macOS (os_version is major * 16777216 + minor * 4096 + build), the number as it is elsewhere.
function __glitchless_os_version() {
    var _v = os_version;
    if (os_type == os_macosx || os_type == os_ios) {
        var _major = floor(_v / 16777216);
        var _minor = floor((_v % 16777216) / 4096);
        return string(_major) + "." + string(_minor) + "." + string(_v % 4096);
    }
    return string(_v);
}

/// The GPU's name and vendor, and the graphics API, from os_get_info where the runner says them.
function __glitchless_gpu() {
    var _out = { renderer: "", vendor: "", driver: undefined };
    var _info = os_get_info();
    if (!ds_exists(_info, ds_type_map)) return _out;
    var _renderer = _info[? "gl_renderer_string"];
    var _vendor = _info[? "gl_vendor_string"];
    var _dx = _info[? "video_adapter_description"];
    if (is_string(_renderer)) {
        _out.renderer = _renderer;
        _out.driver = "OpenGL";
    } else if (is_string(_dx)) {
        _out.renderer = _dx;
        _out.driver = "DirectX 11";
    }
    if (is_string(_vendor)) _out.vendor = _vendor;
    ds_map_destroy(_info);
    return _out;
}

/// Whether this is a Steam Deck, as the Unreal plugin decides it: Steam sets SteamDeck=1 for a game it starts on a
/// Deck (a Linux build, or a Windows build under Proton), the board is Valve's Jupiter (LCD) or Galileo (OLED), or
/// /etc/os-release says SteamOS. A Windows build under Proton sees those files through Wine's Z: drive. GameMaker's
/// file sandbox may refuse to read them (unless the game turns it off), so SteamDeck=1 is the signal to count on.
/// Read once: {steam_deck, steamos, env, model}.
function __glitchless_steam_deck() {
    if (variable_global_exists("__glitchless_deck_facts")) return global.__glitchless_deck_facts;
    var _root = os_type == os_linux ? "/" : (os_type == os_windows ? "Z:/" : "");
    var _vendor = "";
    var _board = "";
    var _release = "";
    if (_root != "") {
        _vendor = string_lower(__glitchless_trim(__glitchless_read_any(_root + "sys/class/dmi/id/board_vendor")));
        _board = string_lower(__glitchless_trim(__glitchless_read_any(_root + "sys/class/dmi/id/board_name")));
        _release = __glitchless_read_any(_root + "etc/os-release");
    }
    var _env = __glitchless_trim(environment_get_variable("SteamDeck")) == "1";
    var _steamos = __glitchless_os_release_id(_release) == "steamos";
    var _valve = _vendor == "valve" && (_board == "jupiter" || _board == "galileo");
    global.__glitchless_deck_facts = {
        steam_deck: _env || _valve || _steamos,
        steamos: _steamos,
        env: _env,
        model: _board == "galileo" ? "Steam Deck OLED" : (_board == "jupiter" ? "Steam Deck LCD" : "Steam Deck")
    };
    return global.__glitchless_deck_facts;
}

/// The ID= line of an os-release file, lower case and without quotes ("steamos").
function __glitchless_os_release_id(_text) {
    var _lines = string_split(string_replace_all(_text, "\r", ""), "\n");
    for (var _i = 0; _i < array_length(_lines); _i++) {
        var _line = __glitchless_trim(_lines[_i]);
        if (string_copy(_line, 1, 3) == "ID=") {
            var _id = __glitchless_trim(string_copy(_line, 4, string_length(_line) - 3));
            var _q = string_char_at(_id, 1);
            if (string_length(_id) >= 2 && (_q == "\"" || _q == "'")) _id = string_copy(_id, 2, string_length(_id) - 2);
            return string_lower(_id);
        }
    }
    return "";
}

/// A small file anywhere on disk, or "" where it's missing or the file sandbox refuses it.
function __glitchless_read_any(_path) {
    try {
        return __glitchless_read_text(_path);
    } catch (_e) {
        return "";
    }
}

/// The browser SDK's GPU tiers (packages/sdk/src/device.js), for desktops: the Godot SDK's patterns,
/// spelled out without regular expressions.
function __glitchless_gpu_tier(_name) {
    var _s = string_lower(_name);
    if (_s == "") return "unknown";
    if (__glitchless_contains_any(_s, ["swiftshader", "llvmpipe", "software", "basic render"])) return "software";
    var _apple_m = __glitchless_after_digits(_s, "apple m"); // what follows "apple m3", or undefined
    if (!is_undefined(_apple_m) && (string_copy(_apple_m, 1, 4) == " pro" || string_copy(_apple_m, 1, 4) == " max" || string_copy(_apple_m, 1, 6) == " ultra")) return "high";
    if (__glitchless_contains_any(_s, ["rtx", "radeon rx", "radeon pro", "quadro", "geforce gtx 10", "geforce gtx 16", "geforce gtx 17", "geforce gtx 18", "geforce gtx 19", "arc a7"])) return "high";
    if (__glitchless_contains_any(_s, ["adreno", "mali", "powervr"]) || !is_undefined(__glitchless_after_digits(_s, "apple a"))) return "low";
    if (string_length(_s) >= 9 && string_copy(_s, string_length(_s) - 8, 9) == "apple gpu") return "low";
    var _intel = string_pos("intel", _s);
    if (_intel > 0 && string_pos("hd graphics", string_copy(_s, _intel, string_length(_s))) > 0) return "low";
    if (__glitchless_contains_any(_s, ["intel(r) hd", "intel(r) uhd"])) return "low";
    if (!is_undefined(_apple_m) || __glitchless_contains_any(_s, ["apple gpu", "iris", "arc", "radeon", "geforce", "nvidia"])) return "mid";
    return "unknown";
}

/// The text after the first `_prefix` that is followed by one or more digits, and after those digits;
/// undefined when there is none ("apple m3 max" with "apple m" gives " max").
function __glitchless_after_digits(_s, _prefix) {
    var _from = 1;
    var _len = string_length(_s);
    var _plen = string_length(_prefix);
    while (_from <= _len) {
        var _p = string_pos(_prefix, string_copy(_s, _from, _len - _from + 1));
        if (_p == 0) return undefined;
        var _i = _from + _p - 1 + _plen;
        var _j = _i;
        while (_j <= _len && ord(string_char_at(_s, _j)) >= 48 && ord(string_char_at(_s, _j)) <= 57) _j++;
        if (_j > _i) return string_copy(_s, _j, _len - _j + 1);
        _from = _from + _p;
    }
    return undefined;
}

function __glitchless_contains_any(_s, _needles) {
    for (var _i = 0; _i < array_length(_needles); _i++) {
        if (string_pos(_needles[_i], _s) > 0) return true;
    }
    return false;
}

function __glitchless_refresh_rate() {
    var _hz = display_get_frequency();
    return _hz > 0 ? floor(_hz + 0.5) : undefined;
}

/// The runner's memory in use, in MB (debug_event's DumpMemory, on every platform), or undefined.
function __glitchless_heap_mb() {
    try {
        var _m = debug_event("DumpMemory", true);
        // totalUsed is an int64 on runtime 2026.0.0.23, not a real
        if (is_struct(_m) && is_numeric(_m[$ "totalUsed"])) return __glitchless_round(real(_m.totalUsed) / 1048576, 0.1);
    } catch (_e) {}
    return undefined;
}

/// How many surfaces, DS lists, DS maps, DS grids, buffers and particle systems exist (debug_event's
/// ResourceCounts). Each is freed by hand in GameMaker, so one that only climbs is a leak.
function __glitchless_resource_counts() {
    var _out = {};
    try {
        var _r = debug_event("ResourceCounts", true);
        if (!is_struct(_r)) return _out;
        var _pairs = [["surfaces", "surfaceCount"], ["ds_lists", "listCount"], ["ds_maps", "mapCount"], ["ds_grids", "gridCount"], ["buffers", "bufferCount"], ["particle_systems", "partSystemCount"], ["vertex_buffers", "vertexBufferCount"]];
        for (var _i = 0; _i < array_length(_pairs); _i++) {
            var _v = _r[$ _pairs[_i][1]];
            if (is_numeric(_v)) _out[$ _pairs[_i][0]] = real(_v);
        }
    } catch (_e) {}
    return _out;
}
