// Feather disable all
/// Glitchless: the parts that only run inside GameMaker: pausing the game for the bug report form,
/// reading the screenshot off the application surface, and drawing the form. gamemaker/test/core.test.mjs
/// runs everything else in Node and stands in for these.

/// Deactivates every instance but Glitchless's own, and returns the ones it deactivated, so closing the
/// form wakes exactly those (not instances the game had deactivated itself).
function __glitchless_pause_game() {
    var _list = [];
    with (all) {
        if (object_index != obj_glitchless && object_index != obj_glitchless_tail) array_push(_list, id);
    }
    for (var _i = 0; _i < array_length(_list); _i++) instance_deactivate_object(_list[_i]);
    return _list;
}

function __glitchless_resume_game(_list) {
    for (var _i = 0; _i < array_length(_list); _i++) instance_activate_object(_list[_i]);
}

/// The frame just drawn, as a PNG data URL of at most 200,000 characters, and a sprite of it for the
/// form's preview: { url, sprite }. GameMaker writes PNG only, so the picture is drawn onto a smaller
/// surface, saved, read back and base64'd, smaller each time until it fits (960, 800, 640, 480, 320
/// pixels on the longer side).
function __glitchless_capture_screenshot(_g) {
    var _out = { url: "", sprite: -1 };
    var _file = "glitchless/screenshot.png";
    var _src = -1;
    var _src_sprite = -1;
    var _w = 0;
    var _h = 0;
    if (application_surface_is_enabled() && surface_exists(application_surface)) {
        _src = application_surface;
        _w = surface_get_width(_src);
        _h = surface_get_height(_src);
    } else {
        screen_save(_file);
        _src_sprite = sprite_add(_file, 1, false, false, 0, 0);
        if (_src_sprite == -1) return _out;
        _w = sprite_get_width(_src_sprite);
        _h = sprite_get_height(_src_sprite);
    }
    if (_w <= 0 || _h <= 0) return _out;
    var _sizes = [960, 800, 640, 480, 320];
    for (var _i = 0; _i < array_length(_sizes); _i++) {
        var _scale = min(1, _sizes[_i] / max(_w, _h));
        var _tw = max(1, floor(_w * _scale));
        var _th = max(1, floor(_h * _scale));
        var _surf = surface_create(_tw, _th);
        surface_set_target(_surf);
        draw_clear_alpha(c_black, 1);
        gpu_set_colorwriteenable(true, true, true, false); // keep the picture opaque where the game drew with alpha
        if (_src != -1) {
            draw_surface_stretched(_src, 0, 0, _tw, _th);
        } else {
            draw_sprite_stretched(_src_sprite, 0, 0, 0, _tw, _th);
        }
        gpu_set_colorwriteenable(true, true, true, true);
        surface_reset_target();
        surface_save(_surf, _file);
        var _buf = buffer_load(_file);
        var _url = "";
        if (_buf != -1) {
            _url = "data:image/png;base64," + buffer_base64_encode(_buf, 0, buffer_get_size(_buf));
            buffer_delete(_buf);
        }
        if (_url != "" && (string_length(_url) <= __GLITCHLESS_MAX_SCREENSHOT || _i == array_length(_sizes) - 1)) {
            if (string_length(_url) <= __GLITCHLESS_MAX_SCREENSHOT) _out.url = _url;
            _out.sprite = sprite_create_from_surface(_surf, 0, 0, _tw, _th, false, false, 0, 0);
            surface_free(_surf);
            break;
        }
        surface_free(_surf);
    }
    if (_src_sprite != -1) sprite_delete(_src_sprite);
    if (file_exists(_file)) file_delete(_file);
    return _out;
}

// ───────────────────────────── drawing the form ─────────────────────────────

#macro __GLITCHLESS_UI_BACK make_colour_rgb(8, 13, 23)
#macro __GLITCHLESS_UI_PANEL make_colour_rgb(20, 33, 61)
#macro __GLITCHLESS_UI_FIELD make_colour_rgb(14, 24, 46)
#macro __GLITCHLESS_UI_EDGE make_colour_rgb(42, 60, 99)
#macro __GLITCHLESS_UI_ACCENT make_colour_rgb(46, 230, 166)
#macro __GLITCHLESS_UI_TEXT make_colour_rgb(238, 243, 251)
#macro __GLITCHLESS_UI_MUTED make_colour_rgb(143, 161, 196)

/// Where the form's parts go on the GUI layer: {left, top, w, h, shot_*, note_*, send_*, cancel_*}. (Not x and y:
/// those are every instance's built-in variables.)
function __glitchless_bug_layout() {
    var _gw = display_get_gui_width();
    var _gh = display_get_gui_height();
    var _w = min(560, _gw - 32);
    var _h = min(470, _gh - 32);
    var _x = floor((_gw - _w) / 2);
    var _y = floor((_gh - _h) / 2);
    var _pad = 18;
    var _shot_h = floor(_h * 0.42);
    var _note_y = _y + 54 + _shot_h + 12;
    var _button_y = _y + _h - _pad - 34;
    return {
        left: _x, top: _y, w: _w, h: _h, pad: _pad,
        shot_x: _x + _pad, shot_y: _y + 54, shot_w: _w - 2 * _pad, shot_h: _shot_h,
        note_x: _x + _pad, note_y: _note_y, note_w: _w - 2 * _pad, note_h: _button_y - 12 - _note_y,
        send_x: _x + _w - _pad - 110, send_y: _button_y, send_w: 110, send_h: 34,
        cancel_x: _x + _w - _pad - 110 - 12 - 96, cancel_y: _button_y, cancel_w: 96, cancel_h: 34
    };
}

function __glitchless_bug_button_at(_g, _mx, _my) {
    var _l = __glitchless_bug_layout();
    if (_mx >= _l.send_x && _mx <= _l.send_x + _l.send_w && _my >= _l.send_y && _my <= _l.send_y + _l.send_h) return "send";
    if (_mx >= _l.cancel_x && _mx <= _l.cancel_x + _l.cancel_w && _my >= _l.cancel_y && _my <= _l.cancel_y + _l.cancel_h) return "cancel";
    return "";
}

/// obj_glitchless_tail's Draw GUI End: the form, over everything the game drew.
function __glitchless_draw_bug_form() {
    var _g = __glitchless();
    var _bug = _g.bug;
    if (is_undefined(_bug)) return;
    var _l = __glitchless_bug_layout();
    var _font = draw_get_font();
    var _halign = draw_get_halign();
    var _valign = draw_get_valign();
    var _colour = draw_get_colour();
    var _alpha = draw_get_alpha();
    draw_set_font(-1);
    draw_set_halign(fa_left);
    draw_set_valign(fa_top);
    var _gw = display_get_gui_width();
    var _gh = display_get_gui_height();
    // The game as it was: paused instances draw nothing, so the screenshot stands in behind the form.
    if (_bug.sprite != -1 && _bug.pause) draw_sprite_stretched(_bug.sprite, 0, 0, 0, _gw, _gh);
    draw_set_alpha(0.55);
    draw_set_colour(__GLITCHLESS_UI_BACK);
    draw_rectangle(0, 0, _gw, _gh, false);
    draw_set_alpha(1);
    draw_set_colour(__GLITCHLESS_UI_PANEL);
    draw_roundrect_ext(_l.left, _l.top, _l.left + _l.w, _l.top + _l.h, 14, 14, false);
    draw_set_colour(__GLITCHLESS_UI_EDGE);
    draw_roundrect_ext(_l.left, _l.top, _l.left + _l.w, _l.top + _l.h, 14, 14, true);
    draw_set_colour(__GLITCHLESS_UI_TEXT);
    draw_text(_l.left + _l.pad, _l.top + _l.pad, "Report a bug");
    // The screenshot, fitted into its box.
    draw_set_colour(__GLITCHLESS_UI_FIELD);
    draw_rectangle(_l.shot_x, _l.shot_y, _l.shot_x + _l.shot_w, _l.shot_y + _l.shot_h, false);
    if (_bug.sprite != -1) {
        var _sw = sprite_get_width(_bug.sprite);
        var _sh = sprite_get_height(_bug.sprite);
        var _scale = min(_l.shot_w / _sw, _l.shot_h / _sh);
        var _dw = _sw * _scale;
        var _dh = _sh * _scale;
        draw_sprite_stretched(_bug.sprite, 0, _l.shot_x + (_l.shot_w - _dw) / 2, _l.shot_y + (_l.shot_h - _dh) / 2, _dw, _dh);
    } else {
        draw_set_colour(__GLITCHLESS_UI_MUTED);
        draw_text(_l.shot_x + 12, _l.shot_y + 12, "No screenshot");
    }
    // The note.
    draw_set_colour(__GLITCHLESS_UI_FIELD);
    draw_rectangle(_l.note_x, _l.note_y, _l.note_x + _l.note_w, _l.note_y + _l.note_h, false);
    draw_set_colour(__GLITCHLESS_UI_EDGE);
    draw_rectangle(_l.note_x, _l.note_y, _l.note_x + _l.note_w, _l.note_y + _l.note_h, true);
    var _text = _bug.state == "form" ? keyboard_string : _bug[$ "note"];
    if (is_undefined(_text)) _text = "";
    if (_text == "" && _bug.state == "form") {
        draw_set_colour(__GLITCHLESS_UI_MUTED);
        draw_text_ext(_l.note_x + 10, _l.note_y + 8, "What went wrong? Type here.", -1, _l.note_w - 20);
    } else {
        draw_set_colour(__GLITCHLESS_UI_TEXT);
        var _caret = _bug.state == "form" && (current_time div 500) % 2 == 0 ? "|" : "";
        draw_text_ext(_l.note_x + 10, _l.note_y + 8, _text + _caret, -1, _l.note_w - 20);
    }
    // The buttons, or how the send went.
    var _status = "";
    switch (_bug.state) {
        case "sending": _status = "Sending..."; break;
        case "sent": _status = "Sent. Thank you!"; break;
        case "offline": _status = "This build doesn't send reports."; break;
        case "failed": _status = "Couldn't send it now: it goes with the next batch."; break;
    }
    if (_status != "") {
        draw_set_colour(_bug.state == "sent" ? __GLITCHLESS_UI_ACCENT : __GLITCHLESS_UI_MUTED);
        draw_text(_l.left + _l.pad, _l.send_y + 9, _status);
    } else {
        draw_set_colour(__GLITCHLESS_UI_MUTED);
        draw_text(_l.left + _l.pad, _l.send_y + 9, "Enter sends, Esc cancels");
        draw_set_colour(__GLITCHLESS_UI_FIELD);
        draw_roundrect_ext(_l.cancel_x, _l.cancel_y, _l.cancel_x + _l.cancel_w, _l.cancel_y + _l.cancel_h, 8, 8, false);
        draw_set_colour(__GLITCHLESS_UI_TEXT);
        draw_set_halign(fa_center);
        draw_text(_l.cancel_x + _l.cancel_w / 2, _l.cancel_y + 9, "Cancel");
        draw_set_colour(__GLITCHLESS_UI_ACCENT);
        draw_roundrect_ext(_l.send_x, _l.send_y, _l.send_x + _l.send_w, _l.send_y + _l.send_h, 8, 8, false);
        draw_set_colour(__GLITCHLESS_UI_BACK);
        draw_text(_l.send_x + _l.send_w / 2, _l.send_y + 9, "Send");
    }
    draw_set_font(_font);
    draw_set_halign(_halign);
    draw_set_valign(_valign);
    draw_set_colour(_colour);
    draw_set_alpha(_alpha);
}
