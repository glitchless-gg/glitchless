/// One frame of the demo: move the player, play the level's next event, end the level when its time is up.
if (quitting) exit;
var _dt = delta_time / 1000000;
t += _dt;
elapsed += _dt;
player_x = 480 + sin(current_time / 400) * 260;
player_y = 270 + cos(current_time / 700) * 120;
glitchless_set_position(player_x, player_y);
if (t >= next_event) {
    var _opening = events_this_level < 4;
    var _openers = ["powerup", "pickup", "death", "bonus"];
    next_event = t + (_opening ? 0.25 : random_range(0.3, 0.8));
    demo_play_event(_opening ? _openers[events_this_level] : "");
    events_this_level += 1;
}
if (t >= level_seconds) {
    glitchless_level_complete(undefined, irandom_range(100, 999));
    demo_next_level();
}
if (bug_report_at >= 0 && elapsed >= bug_report_at) {
    bug_report_at = -1;
    glitchless_report_bug("the bonus on " + room_get_name(room) + " never paid out", true, function(_result) {
        show_debug_message("bug report from code: " + json_stringify(_result));
    });
}
