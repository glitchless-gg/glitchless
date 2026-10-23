/// The Glitchless demo: a tiny game with planted problems, so Glitchless has something to find.
///   rm_level_1  a bonus finds a row missing from its table, and the game reports it with glitchless_error
///               (the message holds the save folder's full path, which Glitchless cuts down)
///   rm_level_2  planted problem 1: a power-up makes 2500 spark instances in one step and sorts them with a
///               bubble sort (a stutter). The sparks are persistent and never destroyed, so rm_level_3 carries
///               every one (a leak), and each power-up makes a glow surface it never frees (another)
///   rm_level_3  planted problem 2: a bonus reads a variable from an object that has no instances, which stops a
///               GameMaker game; Glitchless writes the crash down and sends it on the next launch
/// Each level opens with the same four events (power-up, pickup, death, bonus), then plays at random. F8 opens
/// the bug report form.
///
/// Flags (on the command line, or in GLITCHLESS_ARGS, or in glitchless/args.txt when run from the IDE):
///   -autoplay            play by itself and quit after the last level
///   -seed=N              which run to play (the same seed plays the same way)
///   -level-seconds=S     how long each level lasts (default 4)
///   -no-crash            skip planted problem 2, so the run reaches its end
///   -bug-report-at=S     send a bug report from code (glitchless_report_bug) S seconds in
///   -bug-form-at=S       S seconds in, open the F8 form and cancel it, then open it, type a note and send it
///   -glitchless-selftest compute the sketch and fingerprints of datafiles/glitchless_fixture.json, write them to
///                        glitchless/selftest.json in the save area, and quit (gamemaker/test/e2e.mjs compares them)
/// and Glitchless's own: -glitchless, -glitchless-intake=URL, -glitchless-privacy=MODE, -glitchless-measure=S.

autoplay = glitchless_has_flag("autoplay");
level_seconds = real(glitchless_flag_value("level-seconds", "4"));
crash = !glitchless_has_flag("no-crash");
random_set_seed(real(glitchless_flag_value("seed", "1")));
levels = [rm_level_1, rm_level_2, rm_level_3];
level = -1;
t = 0;
next_event = 0.2;
events_this_level = 0;
glow = []; // planted leak: a surface per power-up, never freed
player_x = 480;
player_y = 300;
bug_report_at = real(glitchless_flag_value("bug-report-at", "-1"));
bug_form_at = real(glitchless_flag_value("bug-form-at", "-1"));
elapsed = 0;
quitting = false;

show_debug_message("glitchless demo save dir: " + game_save_id);
if (glitchless_has_flag("glitchless-selftest")) {
    demo_selftest();
    game_end();
    exit;
}

glitchless_init("glitchless-gamemaker-demo", "0.1.0", "dev", "http://localhost:7777", {
    bug_reports: {
        on_open: function() { show_debug_message("bug report form opened, paused: " + (instance_number(obj_demo) == 0 ? "true" : "false")); },
        on_close: function() { show_debug_message("bug report form closed, paused: " + (instance_number(obj_demo) == 0 ? "true" : "false")); }
    }
});
if (bug_form_at >= 0) demo_pretend_bug_form(bug_form_at);
demo_next_level();
